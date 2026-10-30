//! Process-local capabilities. Business ownership and renderer dispatch belong to TypeScript.

pub mod credentials;
pub mod files;
pub mod instance;
pub mod permissions;
pub mod pty;
pub mod search_session;
pub mod ssh;
pub mod whatsapp;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

pub type Result<T> = std::result::Result<T, NativeError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeError {
    pub code: &'static str,
    pub message: String,
}

impl NativeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NativeError {}

pub(crate) fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 120
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    {
        return Err(NativeError::new(
            "INVALID_ID",
            "expected 1-120 ASCII identifier characters",
        ));
    }
    Ok(())
}

pub(crate) fn deadline(ms: u32) -> Result<Instant> {
    if !(1..=120_000).contains(&ms) {
        return Err(NativeError::new(
            "INVALID_DEADLINE",
            "deadlineMs must be between 1 and 120000",
        ));
    }
    Ok(Instant::now() + Duration::from_millis(u64::from(ms)))
}

pub(crate) struct Operation {
    cancelled: AtomicBool,
    deadline: Instant,
}

impl Operation {
    pub(crate) fn new(deadline: Instant) -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            deadline,
        }
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub(crate) fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(NativeError::new("CANCELLED", "operation was cancelled"))
        } else if Instant::now() >= self.deadline {
            Err(NativeError::new(
                "DEADLINE_EXCEEDED",
                "operation deadline elapsed",
            ))
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct State {
    closing: bool,
    searches: HashMap<String, Arc<Operation>>,
    ptys: HashMap<String, Arc<pty::Pty>>,
    search_sessions: HashMap<String, Arc<search_session::SearchSession>>,
}

/// Cap on live persistent search sessions.
///
/// Deliberately far below the PTY cap of 16: a session pins a whole tree
/// snapshot, bounded at 200k entries / 32 MiB of path data per root, so the
/// number this limits is memory, not file descriptors.
const MAX_SEARCH_SESSIONS: usize = 4;

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    changed: Condvar,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap_or_else(|p| p.into_inner());
        for search in state.searches.values() {
            search.cancel();
        }
        for pty in state.ptys.values() {
            pty.request_close(Instant::now());
        }
        for session in state.search_sessions.values() {
            session.stop();
        }
    }
}

/// Cloning shares one process-local state; the binding clones it into each
/// async task so a walk or a rank never runs on the JavaScript thread.
#[derive(Clone, Default)]
pub struct Runtime {
    inner: Arc<Inner>,
}

#[derive(Debug)]
pub struct ShutdownReport {
    pub complete: bool,
    pub pending_operations: Vec<String>,
    pub resources: Vec<pty::CloseReport>,
}

impl Runtime {
    /// Registration is synchronous, before a queued worker can be cancelled.
    pub fn prepare_search(&self, options: files::SearchOptions) -> Result<SearchJob> {
        valid_id(&options.operation_id)?;
        options.validate()?;
        let operation = Arc::new(Operation::new(deadline(options.deadline_ms)?));
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            return Err(NativeError::new(
                "CLOSED",
                "native runtime is shutting down",
            ));
        }
        if state.searches.contains_key(&options.operation_id) {
            return Err(NativeError::new(
                "DUPLICATE_OPERATION",
                &options.operation_id,
            ));
        }
        if state.searches.len() >= 8 {
            return Err(NativeError::new(
                "BUSY",
                "at most 8 file searches may be pending",
            ));
        }
        state
            .searches
            .insert(options.operation_id.clone(), Arc::clone(&operation));
        Ok(SearchJob {
            options,
            operation,
            runtime: Arc::downgrade(&self.inner),
        })
    }

    pub fn cancel_search(&self, operation_id: &str) -> bool {
        let state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(operation) = state.searches.get(operation_id) {
            operation.cancel();
            true
        } else {
            false
        }
    }

    /// Admit and open a persistent search session.
    ///
    /// Admission is checked before the walk and the registration is atomic with
    /// respect to it: the pre-check keeps an over-cap or duplicate caller from
    /// paying for a snapshot it cannot register, and the entry insertion after
    /// the walk catches a caller that raced in while this one was walking. The
    /// lock is never held across the walk.
    ///
    /// The whole call is safe to run on a worker thread (the binding wraps it in
    /// an `AsyncTask`), because the walk happens between two lock scopes.
    pub fn prepare_search_session(
        &self,
        options: search_session::SessionOptions,
    ) -> Result<Arc<search_session::SearchSession>> {
        // Validate before admission, in the order `prepare_search` uses: a
        // malformed request reports itself as malformed rather than as a
        // capacity problem, whatever the current load happens to be.
        valid_id(&options.session_id)?;
        options.validate()?;
        let session_id = options.session_id.clone();
        {
            let state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.closing {
                return Err(NativeError::new(
                    "CLOSED",
                    "native runtime is shutting down",
                ));
            }
            if state.search_sessions.contains_key(&session_id) {
                return Err(NativeError::new("DUPLICATE_RESOURCE", &session_id));
            }
            if state.search_sessions.len() >= MAX_SEARCH_SESSIONS {
                return Err(NativeError::new(
                    "BUSY",
                    format!("at most {MAX_SEARCH_SESSIONS} search sessions may be open"),
                ));
            }
        }
        let session = search_session::SearchSession::create(options)?;
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            return Err(NativeError::new(
                "CLOSED",
                "native runtime is shutting down",
            ));
        }
        // A duplicate that raced in during the walk loses here, not by being
        // overwritten: overwriting would hand that caller a session the runtime
        // no longer tracks, so stopping its id would stop someone else's.
        match state.search_sessions.entry(session_id) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(Arc::clone(&session));
            }
            std::collections::hash_map::Entry::Occupied(existing) => {
                return Err(NativeError::new("DUPLICATE_RESOURCE", existing.key()));
            }
        }
        Ok(session)
    }

    pub fn search_session(&self, session_id: &str) -> Result<Arc<search_session::SearchSession>> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .search_sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| NativeError::new("RESOURCE_NOT_FOUND", session_id))
    }

    /// Stop a session and drop it. Stopping cancels its in-flight queries; a
    /// handle the caller still holds keeps working for draining, exactly as a
    /// released PTY does. Shutdown stops every session itself while holding the
    /// handles it needs to wait on, so there is no separate "stop all" entry
    /// point here.
    pub fn stop_search_session(&self, session_id: &str) -> bool {
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        match state.search_sessions.remove(session_id) {
            Some(session) => {
                session.stop();
                true
            }
            None => false,
        }
    }

    pub fn start_pty(&self, options: pty::StartOptions) -> Result<Arc<pty::Pty>> {
        options.validate()?;
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            return Err(NativeError::new(
                "CLOSED",
                "native runtime is shutting down",
            ));
        }
        if state.ptys.contains_key(&options.resource_id) {
            return Err(NativeError::new("DUPLICATE_RESOURCE", &options.resource_id));
        }
        if state.ptys.len() >= 16 {
            return Err(NativeError::new(
                "BUSY",
                "at most 16 PTY resources may be owned",
            ));
        }
        let resource = pty::Pty::start(options)?;
        state
            .ptys
            .insert(resource.id().to_owned(), Arc::clone(&resource));
        Ok(resource)
    }

    pub fn pty(&self, resource_id: &str) -> Result<Arc<pty::Pty>> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .ptys
            .get(resource_id)
            .cloned()
            .ok_or_else(|| NativeError::new("RESOURCE_NOT_FOUND", resource_id))
    }

    /// Release only after the worker has stopped. Queued events remain readable through an existing handle.
    pub fn release_pty(&self, resource_id: &str) -> bool {
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.ptys.get(resource_id).is_some_and(|pty| pty.is_done()) {
            state.ptys.remove(resource_id);
            true
        } else {
            false
        }
    }

    pub fn prepare_shutdown(&self, deadline_ms: u32) -> Result<ShutdownJob> {
        let until = deadline(deadline_ms)?;
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closing = true;
        for operation in state.searches.values() {
            operation.cancel();
        }
        let resources: Vec<_> = state.ptys.values().cloned().collect();
        for resource in &resources {
            resource.request_close(until);
        }
        // Take the sessions out of the registry now, keeping handles so the job
        // can still wait for their cancelled queries to unwind. Leaving them
        // registered would make the host's "no resources after shutdown"
        // assertion blind to a session that never drained.
        let sessions: Vec<_> = state.search_sessions.drain().map(|(_, s)| s).collect();
        for session in &sessions {
            session.stop();
        }
        Ok(ShutdownJob {
            runtime: Arc::clone(&self.inner),
            resources,
            sessions,
            until,
        })
    }

    pub fn counts(&self) -> (usize, usize) {
        let state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        (state.searches.len(), state.ptys.len())
    }

    /// Live persistent search sessions, separate from the one-shot search
    /// count so the host's teardown assertions can name a leak.
    pub fn search_session_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .search_sessions
            .len()
    }
}

pub struct SearchJob {
    options: files::SearchOptions,
    operation: Arc<Operation>,
    runtime: Weak<Inner>,
}

impl SearchJob {
    pub fn run(self) -> Result<files::SearchResult> {
        files::search(&self.options, &self.operation)
    }
}

impl Drop for SearchJob {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.upgrade() {
            runtime
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .searches
                .remove(&self.options.operation_id);
            runtime.changed.notify_all();
        }
    }
}

pub struct ShutdownJob {
    runtime: Arc<Inner>,
    resources: Vec<Arc<pty::Pty>>,
    sessions: Vec<Arc<search_session::SearchSession>>,
    until: Instant,
}

impl ShutdownJob {
    pub fn run(self) -> ShutdownReport {
        let resources: Vec<_> = self
            .resources
            .iter()
            .map(|pty| pty.wait_close(self.until))
            .collect();
        // Session queries run on their caller's thread and check cancellation
        // between paths, so a stopped session unwinds without a worker to join;
        // poll until every cancelled query has forgotten its operation.
        while self.sessions.iter().any(|session| !session.drained())
            && Instant::now() < self.until
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        let mut state = self.runtime.state.lock().unwrap_or_else(|p| p.into_inner());
        while !state.searches.is_empty() && Instant::now() < self.until {
            let remaining = self.until.saturating_duration_since(Instant::now());
            state = self
                .runtime
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        let mut pending_operations: Vec<_> = state.searches.keys().cloned().collect();
        // A session query that outlived the deadline is reported by its own id,
        // so the host can name the leak instead of only seeing `complete: false`.
        for session in &self.sessions {
            pending_operations.extend(session.pending_operations());
        }
        pending_operations.sort();
        pending_operations.dedup();
        // Retain completed resources until their consumer has drained and released them.
        ShutdownReport {
            complete: pending_operations.is_empty() && resources.iter().all(|r| r.complete),
            pending_operations,
            resources,
        }
    }
}
