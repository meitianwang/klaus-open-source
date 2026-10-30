//! Synchronous, process-local compatibility with the shipped single-instance protocol.
//! No database, engine, application activation, or JavaScript callback is owned here.

#[cfg(target_os = "macos")]
mod macos;
pub mod protocol;
#[cfg(all(test, any(target_os = "macos", windows)))]
mod tests;
#[cfg(windows)]
mod windows;

use crate::{NativeError, Result};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const MAX_PAYLOAD: usize = 32 * 1024;
const MAX_EVENTS: usize = 16;
const MAX_QUEUE_BYTES: usize = 128 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub identity: String,
    pub cwd: String,
    pub args: Vec<String>,
    pub timeout_ms: u32,
}

impl Options {
    fn validate(&self) -> Result<()> {
        if self.identity.is_empty()
            || self.identity.len() > 72
            || !self
                .identity
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || !(100..=5000).contains(&self.timeout_ms)
        {
            return Err(error("INSTANCE_INVALID_OPTIONS"));
        }
        protocol::validate(&self.cwd, &self.args)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Acquisition {
    pub acquired: bool,
    /// The entire bounded message was handed to the existing endpoint.
    pub forwarded: bool,
    /// Legacy macOS has no acknowledgement. Delivery must not imply UI activation.
    pub acknowledged: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Activation { cwd: String, args: Vec<String> },
    Lost { code: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub acquired: bool,
    pub held: bool,
    pub complete: bool,
    pub error: Option<String>,
}

struct State {
    events: VecDeque<Event>,
    bytes: usize,
    closed: bool,
    error: Option<String>,
}

pub(super) struct Shared {
    state: Mutex<State>,
    stopped: Condvar,
    changed: Notify,
    stopping: AtomicBool,
    primary: AtomicBool,
    reading: AtomicBool,
    // Windows uses this as its native wake target; macOS records a socket witness.
    endpoint: AtomicUsize,
    #[cfg(target_os = "macos")]
    witness: Mutex<Option<macos::Witness>>,
    // Owned here, not published as a raw fd, so a wake can never target a descriptor
    // that another thread already closed and the OS handed to something else.
    #[cfg(target_os = "macos")]
    wake: Mutex<Option<macos::WakePipe>>,
}

impl Shared {
    fn new() -> Self {
        Self {
            state: Mutex::new(State {
                events: VecDeque::new(),
                bytes: 0,
                closed: false,
                error: None,
            }),
            stopped: Condvar::new(),
            changed: Notify::new(),
            stopping: AtomicBool::new(false),
            primary: AtomicBool::new(false),
            reading: AtomicBool::new(false),
            endpoint: AtomicUsize::new(0),
            #[cfg(target_os = "macos")]
            witness: Mutex::new(None),
            #[cfg(target_os = "macos")]
            wake: Mutex::new(None),
        }
    }

    fn activation(&self, cwd: String, args: Vec<String>) -> bool {
        let bytes = cwd.len() + args.iter().map(String::len).sum::<usize>();
        let mut state = self.state.lock().unwrap();
        if self.stopping.load(Ordering::Acquire)
            || state.closed
            || state.error.is_some()
            || state.events.len() >= MAX_EVENTS
            || state.bytes + bytes > MAX_QUEUE_BYTES
        {
            return false;
        }
        state.bytes += bytes;
        state.events.push_back(Event::Activation { cwd, args });
        self.changed.notify_one();
        true
    }

    fn fail(&self, code: &str) {
        let mut state = self.state.lock().unwrap();
        if state.error.is_none() {
            state.error = Some(code.to_owned());
            state.events.clear();
            state.bytes = 0;
            state.events.push_back(Event::Lost {
                code: code.to_owned(),
            });
        }
        drop(state);
        #[cfg(target_os = "macos")]
        macos::wake(self);
        self.changed.notify_one();
    }

    fn failed(&self) -> bool {
        self.state.lock().unwrap().error.is_some()
    }

    #[cfg(target_os = "macos")]
    fn hold_until_close(&self) {
        let state = self.state.lock().unwrap();
        drop(
            self.stopped
                .wait_while(state, |_| !self.stopping.load(Ordering::Acquire))
                .unwrap(),
        );
    }

    fn finish(&self) {
        self.endpoint.store(0, Ordering::Release);
        self.state.lock().unwrap().closed = true;
        self.stopped.notify_all();
        self.changed.notify_one();
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        #[cfg(windows)]
        windows::wake(self);
        #[cfg(target_os = "macos")]
        macos::wake(self);
        let state = self.state.lock().unwrap();
        self.stopped.notify_all();
        drop(state);
        self.changed.notify_one();
    }
}

pub struct InstanceGuard {
    shared: Arc<Shared>,
    acquisition: Acquisition,
}

pub(super) fn error(code: &'static str) -> NativeError {
    NativeError::new(code, "desktop instance guard")
}

impl InstanceGuard {
    /// This deliberately blocks the caller for at most timeoutMs. The Windows
    /// profile encryption key must be prepared before the first JS event-loop yield.
    pub fn acquire_sync(options: Options) -> Result<Self> {
        options.validate()?;
        let shared = Arc::new(Shared::new());
        let worker = shared.clone();
        let timeout = Duration::from_millis(options.timeout_ms.into());
        let deadline = Instant::now() + timeout;
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("klaus-instance-guard".into())
            .spawn(move || {
                #[cfg(target_os = "macos")]
                let result = macos::run(&options, deadline, &worker, &tx);
                #[cfg(windows)]
                let result = windows::run(&options, deadline, &worker, &tx);
                #[cfg(not(any(target_os = "macos", windows)))]
                let result = {
                    let _ = (options, deadline);
                    Err(error("INSTANCE_UNSUPPORTED"))
                };
                if let Err(failure) = result {
                    worker.fail(failure.code);
                    let _ = tx.try_send(Err(failure));
                }
                worker.finish();
            })
            .map_err(|_| error("INSTANCE_THREAD_FAILED"))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(acquisition)) => Ok(Self {
                shared,
                acquisition,
            }),
            Ok(Err(failure)) => {
                shared.stop();
                Err(failure)
            }
            Err(_) => {
                shared.stop();
                Err(error("INSTANCE_ACQUIRE_TIMEOUT"))
            }
        }
    }

    pub fn acquisition(&self) -> &Acquisition {
        &self.acquisition
    }

    pub fn assert_held(&self) -> Result<()> {
        if !self.acquisition.acquired
            || self.shared.failed()
            || self.shared.stopping.load(Ordering::Acquire)
            || self.shared.state.lock().unwrap().closed
        {
            return Err(error("INSTANCE_NOT_HELD"));
        }
        #[cfg(target_os = "macos")]
        let valid = macos::held(&self.shared);
        #[cfg(windows)]
        let valid = windows::held(&self.shared);
        #[cfg(not(any(target_os = "macos", windows)))]
        let valid = false;
        if !valid {
            self.shared.fail("INSTANCE_ENDPOINT_LOST");
            return Err(error("INSTANCE_ENDPOINT_LOST"));
        }
        Ok(())
    }

    pub fn report(&self) -> Report {
        let held = self.assert_held().is_ok();
        let state = self.shared.state.lock().unwrap();
        Report {
            acquired: self.acquisition.acquired,
            held,
            complete: state.closed,
            error: state.error.clone(),
        }
    }

    pub fn read_event(&self) -> Result<impl Future<Output = Option<Event>> + Send + 'static> {
        if self.shared.reading.swap(true, Ordering::AcqRel) {
            return Err(error("INSTANCE_READ_PENDING"));
        }
        struct Read(Arc<Shared>);
        impl Drop for Read {
            fn drop(&mut self) {
                self.0.reading.store(false, Ordering::Release);
            }
        }
        let read = Read(self.shared.clone());
        Ok(async move {
            loop {
                let notified = read.0.changed.notified();
                {
                    let mut state = read.0.state.lock().unwrap();
                    if let Some(event) = state.events.pop_front() {
                        if let Event::Activation { ref cwd, ref args } = event {
                            state.bytes -= cwd.len() + args.iter().map(String::len).sum::<usize>();
                        }
                        return Some(event);
                    }
                    if state.closed {
                        return None;
                    }
                }
                notified.await;
            }
        })
    }

    pub fn close_sync(&self, timeout_ms: u32) -> Result<Report> {
        if !(1..=5000).contains(&timeout_ms) {
            return Err(error("INSTANCE_INVALID_DEADLINE"));
        }
        self.shared.stop();
        let state = self.shared.state.lock().unwrap();
        let _result = self
            .shared
            .stopped
            .wait_timeout_while(state, Duration::from_millis(timeout_ms.into()), |s| {
                !s.closed
            })
            .unwrap();
        drop(_result);
        Ok(self.report())
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.shared.stop();
    }
}
