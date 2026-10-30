//! Persistent workspace search sessions.
//!
//! A one-shot search walks the tree on every call ([`crate::files::search`]),
//! which is the right contract for a single question but the wrong one for a
//! picker: the `@` menu re-queries on every keystroke, and each query paid a
//! full `git ls-files` or recursive walk of the same unchanged tree.
//!
//! A session walks once at creation, keeps the snapshot, and re-ranks it per
//! query. The snapshot is deliberately frozen for the session's lifetime — the
//! same trade the picker's counterpart makes elsewhere: the menu is short-lived
//! (open, type, pick, close), so a file created mid-session simply is not
//! offered until the menu reopens. Nothing watches the filesystem here; adding
//! a watcher would mean owning invalidation, which this module deliberately
//! does not.
//!
//! Results are returned from [`SearchSession::query`] rather than pushed on an
//! event queue. A push channel only pays for itself when results arrive in
//! increments a consumer must stream; a snapshot load is one synchronous step
//! with nothing to stream, so an event pump here would be a queue with a single
//! possible message. Cancellation still works: every query registers an
//! [`Operation`] that [`SearchSession::cancel_query`] and
//! [`SearchSession::stop`] can trip, and ranking checks it between paths.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use crate::files::{self, Entries, Hit};
use crate::{deadline, valid_id, NativeError, Operation, Result};

/// One root's snapshot, kept in workspace order so ranking can reproduce the
/// one-shot handler's budget split across roots. The root path itself is not
/// retained: re-prefixing a secondary root's hit is the host's job, and it
/// already knows the workspace layout it asked for.
struct RootSnapshot {
    entries: Entries,
}

/// A hit tagged with the root it came from. The host still owns turning a
/// non-primary root into an addressable path, so the renderer's result shape is
/// unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoredHit {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub root_index: usize,
}

#[derive(Clone, Debug)]
pub struct SessionOptions {
    pub session_id: String,
    pub roots: Vec<PathBuf>,
    pub deadline_ms: u32,
}

impl SessionOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.roots.is_empty() {
            return Err(NativeError::new("INVALID_ROOT", "a session needs at least one root"));
        }
        if self.roots.len() > 16 {
            return Err(NativeError::new("INVALID_ROOT", "a session accepts at most 16 roots"));
        }
        for root in &self.roots {
            if !root.is_absolute() || root.as_os_str().to_string_lossy().contains('\0') {
                return Err(NativeError::new(
                    "INVALID_ROOT",
                    "search root must be an absolute path",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct QueryOptions {
    pub operation_id: String,
    pub query: String,
    pub limit: i32,
    pub deadline_ms: u32,
}

impl QueryOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.query.chars().count() > 256 {
            return Err(NativeError::new(
                "INVALID_QUERY",
                "search query exceeds 256 characters",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct SessionInfo {
    pub session_id: String,
    pub roots: usize,
    pub scanned: u32,
    /// True when any root hit the entry or path-data bound. A truncated
    /// snapshot is never served: the host rejects creation, exactly as it
    /// rejects a truncated one-shot listing.
    pub truncated: bool,
}

#[derive(Debug)]
pub struct QueryResult {
    pub operation_id: String,
    pub hits: Vec<ScoredHit>,
    pub scanned: u32,
}

#[derive(Default)]
struct State {
    operations: HashMap<String, Arc<Operation>>,
    stopped: bool,
}

/// A frozen tree snapshot plus the queries ranked against it.
pub struct SearchSession {
    id: String,
    snapshot: Vec<RootSnapshot>,
    scanned: u32,
    state: Mutex<State>,
    stopped: AtomicBool,
}

/// Identity and shape only: the snapshot is too large to print, and callers use
/// this in assertion messages, not as a dump.
impl std::fmt::Debug for SearchSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchSession")
            .field("id", &self.id)
            .field("roots", &self.snapshot.len())
            .field("scanned", &self.scanned)
            .field("stopped", &self.stopped())
            .finish()
    }
}

impl SearchSession {
    /// Walk every root once. Cheap roots cost nothing extra; an expensive one
    /// is paid here instead of on every keystroke.
    ///
    /// Cancellation is bounded by this walk's own deadline; the runtime decides
    /// whether to register the result (see `prepare_search_session`), so a walk
    /// that finishes after shutdown started is discarded rather than adopted.
    pub fn create(options: SessionOptions) -> Result<Arc<Self>> {
        valid_id(&options.session_id)?;
        options.validate()?;
        let operation = Operation::new(deadline(options.deadline_ms)?);

        let mut snapshot = Vec::with_capacity(options.roots.len());
        let mut scanned: usize = 0;
        for root in options.roots {
            operation.check()?;
            // A missing root yields an empty snapshot rather than an error,
            // matching the one-shot path.
            let entries = files::load(&root, &operation)?;
            scanned = scanned.saturating_add(entries.scanned);
            snapshot.push(RootSnapshot { entries });
        }

        Ok(Arc::new(Self {
            id: options.session_id,
            snapshot,
            scanned: scanned as u32,
            state: Mutex::new(State::default()),
            stopped: AtomicBool::new(false),
        }))
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            session_id: self.id.clone(),
            roots: self.snapshot.len(),
            scanned: self.scanned,
            truncated: self.snapshot.iter().any(|root| root.entries.truncated),
        }
    }

    /// Re-rank the snapshot. Replicates the one-shot handler's budget split:
    /// roots are ranked in workspace order, each with what is left of `limit`,
    /// and a satisfied budget stops before touching the next root. A negative
    /// limit keeps its "all but the last N" meaning and never short-circuits.
    pub fn query(&self, options: QueryOptions) -> Result<QueryResult> {
        valid_id(&options.operation_id)?;
        options.validate()?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(NativeError::new("CLOSED", "search session is stopped"));
        }
        let operation = Arc::new(Operation::new(deadline(options.deadline_ms)?));
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.stopped {
                return Err(NativeError::new("CLOSED", "search session is stopped"));
            }
            if state.operations.contains_key(&options.operation_id) {
                return Err(NativeError::new(
                    "DUPLICATE_OPERATION",
                    &options.operation_id,
                ));
            }
            if state.operations.len() >= 4 {
                return Err(NativeError::new(
                    "BUSY",
                    "at most 4 queries may be pending per search session",
                ));
            }
            state
                .operations
                .insert(options.operation_id.clone(), Arc::clone(&operation));
        }

        let outcome = self.rank(&options, &operation);
        self.forget(&options.operation_id);
        outcome
    }

    fn rank(&self, options: &QueryOptions, operation: &Operation) -> Result<QueryResult> {
        let limit = options.limit;
        let mut hits: Vec<ScoredHit> = Vec::new();
        for (index, root) in self.snapshot.iter().enumerate() {
            if limit >= 0 && hits.len() >= limit as usize {
                break;
            }
            // A negative limit means "all but the last N" of one root's ranking.
            // Applying it per root and then concatenating would double-count the
            // dropped tail, so the one-shot handler searches the primary root
            // only in that mode. Match it rather than inventing a second meaning.
            if limit < 0 && index > 0 {
                break;
            }
            let remaining = if limit < 0 {
                limit
            } else {
                limit - hits.len() as i32
            };
            let ranked: Vec<Hit> = files::rank(&root.entries, &options.query, remaining, operation)?;
            hits.extend(ranked.into_iter().map(|hit| ScoredHit {
                rel: hit.rel,
                name: hit.name,
                is_dir: hit.is_dir,
                root_index: index,
            }));
        }
        Ok(QueryResult {
            operation_id: options.operation_id.clone(),
            hits,
            scanned: self.scanned,
        })
    }

    fn forget(&self, operation_id: &str) {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .operations
            .remove(operation_id);
    }

    /// Cancel one in-flight query without closing the session.
    pub fn cancel_query(&self, operation_id: &str) -> bool {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(operation) = state.operations.get(operation_id) {
            operation.cancel();
            true
        } else {
            false
        }
    }

    /// Cancel every in-flight query and refuse later ones. Idempotent.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.stopped = true;
        for operation in state.operations.values() {
            operation.cancel();
        }
    }

    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    /// True once every cancelled query has unwound, so shutdown can tell a
    /// drained session from one still holding a worker.
    pub fn drained(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .operations
            .is_empty()
    }

    pub fn pending_operations(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .operations
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }
}
