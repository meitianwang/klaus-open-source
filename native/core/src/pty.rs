use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::{deadline, valid_id, NativeError, Operation, Result};

#[cfg(windows)]
mod windows;

const OUTPUT_CHUNKS: usize = 64;
const READ_BYTES: usize = 16 * 1024;
const INPUT_OPERATIONS: usize = 8;
const INPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct StartOptions {
    pub resource_id: String,
    pub cwd: PathBuf,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
    pub deadline_ms: u32,
}

impl StartOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        valid_id(&self.resource_id)?;
        deadline(self.deadline_ms)?;
        if !self.cwd.is_absolute() || self.cwd.as_os_str().to_string_lossy().contains('\0') {
            return Err(NativeError::new(
                "INVALID_CWD",
                "PTY cwd must be an absolute path",
            ));
        }
        if self.command.is_empty()
            || self.command.contains('\0')
            || self.args.iter().any(|arg| arg.contains('\0'))
        {
            return Err(NativeError::new(
                "INVALID_COMMAND",
                "invalid executable or argument",
            ));
        }
        if self
            .env
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
        {
            return Err(NativeError::new("INVALID_ENV", "invalid environment entry"));
        }
        size(self.cols, self.rows)?;
        #[cfg(not(any(unix, windows)))]
        return Err(NativeError::new(
            "UNSUPPORTED_PLATFORM",
            "deadline-safe PTY I/O requires Unix or Windows ConPTY",
        ));
        #[cfg(any(unix, windows))]
        Ok(())
    }
}

fn size(cols: u16, rows: u16) -> Result<()> {
    if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
        Err(NativeError::new(
            "INVALID_SIZE",
            "PTY size must be within 2-500 columns and 1-200 rows",
        ))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct StartInfo {
    pub resource_id: String,
    pub pid: u32,
    pub cwd: String,
    pub command: String,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub resource_id: String,
    pub sequence: u32,
    pub kind: &'static str,
    pub data: Vec<u8>,
    pub exit_code: u32,
    pub signal: i32,
    pub output_complete: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CloseReport {
    pub resource_id: String,
    pub complete: bool,
    pub state: &'static str,
    pub last_sequence: u32,
    pub bytes_read: u64,
    pub bytes_emitted: u64,
    pub discarded_bytes: u64,
    pub peak_queue_chunks: u32,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CommandResult {
    pub operation_id: String,
    pub resource_id: String,
    pub bytes_written: u32,
}

struct Completion {
    result: Mutex<Option<Result<CommandResult>>>,
    changed: Condvar,
    written: AtomicU64,
    write_in_flight: AtomicBool,
    control_in_flight: AtomicBool,
}

impl Completion {
    fn finish(&self, result: Result<CommandResult>) {
        *self.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(result);
        self.changed.notify_all();
    }
}

pub struct CommandTicket {
    completion: Arc<Completion>,
    operation: Arc<Operation>,
}

impl CommandTicket {
    /// A timed-out write reports its accepted prefix. Retrying the complete payload could duplicate it.
    pub fn wait(self) -> Result<CommandResult> {
        let mut result = self
            .completion
            .result
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        while result.is_none() {
            if let Err(error) = self.operation.check() {
                self.operation.cancel();
                return Err(NativeError::new(
                    error.code,
                    format!(
                        "{}; bytesWritten={}; writeOutcomeUnknown={}; controlOutcomeUnknown={}",
                        error.message,
                        self.completion.written.load(Ordering::Acquire),
                        self.completion.write_in_flight.load(Ordering::Acquire),
                        self.completion.control_in_flight.load(Ordering::Acquire)
                    ),
                ));
            }
            let remaining = self
                .operation
                .deadline
                .saturating_duration_since(Instant::now());
            result = self
                .completion
                .changed
                .wait_timeout(result, remaining.min(Duration::from_millis(20)))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        result.take().expect("completion was checked")
    }
}

enum CommandKind {
    Write(Vec<u8>),
    Resize(u16, u16),
}

struct Command {
    id: String,
    kind: CommandKind,
    operation: Arc<Operation>,
    completion: Arc<Completion>,
}

struct State {
    ready: Option<Result<StartInfo>>,
    events: VecDeque<Event>,
    commands: VecDeque<Command>,
    operations: HashMap<String, Arc<Operation>>,
    closing: Option<Instant>,
    done: bool,
    sequence: u32,
    bytes_read: u64,
    bytes_emitted: u64,
    peak_queue: usize,
    output_complete: bool,
    error: Option<String>,
}

pub struct Pty {
    id: String,
    state: Mutex<State>,
    changed: Condvar,
    event_ready: Notify,
    reading: AtomicBool,
    start_deadline: Instant,
}

impl Pty {
    pub(crate) fn start(options: StartOptions) -> Result<Arc<Self>> {
        let resource = Arc::new(Self {
            id: options.resource_id.clone(),
            state: Mutex::new(State {
                ready: None,
                events: VecDeque::new(),
                commands: VecDeque::new(),
                operations: HashMap::new(),
                closing: None,
                done: false,
                sequence: 0,
                bytes_read: 0,
                bytes_emitted: 0,
                peak_queue: 0,
                output_complete: true,
                error: None,
            }),
            changed: Condvar::new(),
            event_ready: Notify::new(),
            reading: AtomicBool::new(false),
            start_deadline: deadline(options.deadline_ms)?,
        });
        let worker = Arc::clone(&resource);
        std::thread::Builder::new()
            .name("native-pty".into())
            .spawn(move || worker.run(options))
            .map_err(|error| NativeError::new("WORKER_FAILED", error.to_string()))?;
        Ok(resource)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn wait_ready(&self) -> Result<StartInfo> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while state.ready.is_none()
            || state.ready.as_ref().is_some_and(|ready| ready.is_err()) && !state.done
        {
            if Instant::now() >= self.start_deadline {
                drop(state);
                self.request_close(Instant::now());
                return Err(NativeError::new(
                    "DEADLINE_EXCEEDED",
                    "PTY creation did not finish before its deadline",
                ));
            }
            state = self
                .changed
                .wait_timeout(
                    state,
                    self.start_deadline
                        .saturating_duration_since(Instant::now()),
                )
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        state.ready.clone().expect("ready was checked")
    }

    pub fn write(
        &self,
        operation_id: String,
        data: Vec<u8>,
        deadline_ms: u32,
    ) -> Result<CommandTicket> {
        if data.len() > INPUT_BYTES {
            return Err(NativeError::new(
                "INPUT_TOO_LARGE",
                "split PTY input into chunks of at most 65536 bytes",
            ));
        }
        self.enqueue(operation_id, CommandKind::Write(data), deadline_ms)
    }

    pub fn resize(
        &self,
        operation_id: String,
        cols: u16,
        rows: u16,
        deadline_ms: u32,
    ) -> Result<CommandTicket> {
        size(cols, rows)?;
        self.enqueue(operation_id, CommandKind::Resize(cols, rows), deadline_ms)
    }

    fn enqueue(&self, id: String, kind: CommandKind, deadline_ms: u32) -> Result<CommandTicket> {
        valid_id(&id)?;
        let operation = Arc::new(Operation::new(deadline(deadline_ms)?));
        let completion = Arc::new(Completion {
            result: Mutex::new(None),
            changed: Condvar::new(),
            written: AtomicU64::new(0),
            write_in_flight: AtomicBool::new(false),
            control_in_flight: AtomicBool::new(false),
        });
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.done || state.closing.is_some() {
            return Err(NativeError::new("CLOSED", "PTY is closing or closed"));
        }
        if state.operations.contains_key(&id) {
            return Err(NativeError::new("DUPLICATE_OPERATION", id));
        }
        if state.operations.len() >= INPUT_OPERATIONS {
            return Err(NativeError::new("BACKPRESSURE", "PTY input queue is full"));
        }
        state.operations.insert(id.clone(), Arc::clone(&operation));
        state.commands.push_back(Command {
            id,
            kind,
            operation: Arc::clone(&operation),
            completion: Arc::clone(&completion),
        });
        self.changed.notify_all();
        Ok(CommandTicket {
            completion,
            operation,
        })
    }

    pub fn cancel_operation(&self, operation_id: &str) -> bool {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(operation) = state.operations.get(operation_id) {
            operation.cancel();
            self.changed.notify_all();
            true
        } else {
            false
        }
    }

    /// Exactly one consumer; each next call is an async wait without occupying a worker thread.
    pub async fn next_event(&self) -> Result<Option<Event>> {
        if self.reading.swap(true, Ordering::AcqRel) {
            return Err(NativeError::new(
                "CONCURRENT_READ",
                "a PTY permits one event consumer",
            ));
        }
        struct Guard<'a>(&'a AtomicBool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = Guard(&self.reading);
        loop {
            let notified = self.event_ready.notified();
            {
                let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(event) = state.events.pop_front() {
                    self.changed.notify_all();
                    return Ok(Some(event));
                }
                if state.done {
                    return Ok(None);
                }
            }
            notified.await;
        }
    }

    pub fn request_close(&self, until: Instant) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closing = Some(state.closing.map_or(until, |existing| existing.min(until)));
        for operation in state.operations.values() {
            operation.cancel();
        }
        self.changed.notify_all();
    }

    pub fn close(&self, deadline_ms: u32) -> Result<CloseReport> {
        let until = deadline(deadline_ms)?;
        self.request_close(until);
        Ok(self.wait_close(until))
    }

    pub fn wait_close(&self, until: Instant) -> CloseReport {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while !state.done && Instant::now() < until {
            state = self
                .changed
                .wait_timeout(state, until.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        self.report(&state)
    }

    fn report(&self, state: &State) -> CloseReport {
        CloseReport {
            resource_id: self.id.clone(),
            complete: state.done && state.output_complete,
            state: if state.done { "closed" } else { "closing" },
            last_sequence: state.sequence,
            bytes_read: state.bytes_read,
            bytes_emitted: state.bytes_emitted,
            discarded_bytes: state.bytes_read.saturating_sub(state.bytes_emitted),
            peak_queue_chunks: state.peak_queue as u32,
            error: state.error.clone().or_else(|| {
                (!state.done).then(|| "DEADLINE_EXCEEDED: PTY worker is still stopping".into())
            }),
        }
    }

    pub fn is_done(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).done
    }

    pub fn snapshot(&self) -> CloseReport {
        self.report(&self.state.lock().unwrap_or_else(|p| p.into_inner()))
    }

    fn complete_command(&self, command: Command, result: Result<CommandResult>) {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .operations
            .remove(&command.id);
        command.completion.finish(result);
    }

    fn finish(&self, exit_code: u32, signal: i32, error: Option<String>, output_complete: bool) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.error = error.clone();
        state.output_complete = output_complete;
        state.sequence += 1;
        let event = Event {
            resource_id: self.id.clone(),
            sequence: state.sequence,
            kind: "exit",
            data: Vec::new(),
            exit_code,
            signal,
            output_complete,
            error,
        };
        // A reserved terminal slot makes the exit deliverable even when the data queue is full.
        state.events.push_back(event);
        state.peak_queue = state.peak_queue.max(state.events.len());
        state.done = true;
        for command in state.commands.drain(..) {
            command.completion.finish(Err(NativeError::new(
                "CLOSED",
                "PTY stopped before the operation completed; bytesWritten=0",
            )));
        }
        state.operations.clear();
        self.changed.notify_all();
        self.event_ready.notify_one();
    }

    #[cfg(windows)]
    fn run(&self, options: StartOptions) {
        windows::run(self, options);
    }

    #[cfg(not(any(unix, windows)))]
    fn run(&self, _options: StartOptions) {
        let error = NativeError::new(
            "UNSUPPORTED_PLATFORM",
            "PTY is not implemented for this platform",
        );
        self.state.lock().unwrap_or_else(|p| p.into_inner()).ready = Some(Err(error.clone()));
        self.finish(1, 0, Some(error.to_string()), false);
    }

    #[cfg(unix)]
    fn run(&self, options: StartOptions) {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::io::{Read, Write};

        let setup = || -> Result<_> {
            if self
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .closing
                .is_some()
            {
                return Err(NativeError::new("CLOSED", "PTY creation was cancelled"));
            }
            if !options.cwd.is_dir() {
                return Err(NativeError::new(
                    "INVALID_CWD",
                    "PTY cwd is not a directory",
                ));
            }
            let pair = NativePtySystem::default()
                .openpty(PtySize {
                    rows: options.rows,
                    cols: options.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| NativeError::new("PTY_OPEN_FAILED", error.to_string()))?;
            let fd = pair.master.as_raw_fd().ok_or_else(|| {
                NativeError::new("PTY_OPEN_FAILED", "PTY master has no descriptor")
            })?;
            // Clones share this open file description. Both read and write must be interruptible.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err(NativeError::new(
                    "PTY_OPEN_FAILED",
                    std::io::Error::last_os_error().to_string(),
                ));
            }
            // Acquire all fallible parent handles before creating a child that must be reaped.
            let reader = pair
                .master
                .try_clone_reader()
                .map_err(|error| NativeError::new("PTY_OPEN_FAILED", error.to_string()))?;
            let writer = pair
                .master
                .take_writer()
                .map_err(|error| NativeError::new("PTY_OPEN_FAILED", error.to_string()))?;
            let mut command = CommandBuilder::new(&options.command);
            command.args(&options.args);
            command.cwd(&options.cwd);
            for (key, value) in &options.env {
                command.env(key, value);
            }
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            command.env("PWD", &options.cwd);
            let child = pair
                .slave
                .spawn_command(command)
                .map_err(|error| NativeError::new("PTY_SPAWN_FAILED", error.to_string()))?;
            drop(pair.slave);
            Ok((pair.master, reader, writer, child))
        };
        let (master, reader, writer, mut child) = match setup() {
            Ok(value) => value,
            Err(error) => {
                self.state.lock().unwrap_or_else(|p| p.into_inner()).ready =
                    Some(Err(error.clone()));
                self.finish(1, 0, Some(error.to_string()), false);
                return;
            }
        };
        let mut master = Some(master);
        let mut reader = Some(reader);
        let mut writer = Some(writer);
        let pid = child.process_id().unwrap_or(0);
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.ready = Some(Ok(StartInfo {
                resource_id: self.id.clone(),
                pid,
                cwd: options.cwd.to_string_lossy().into(),
                command: options.command,
            }));
            if Instant::now() >= self.start_deadline {
                state.closing = Some(Instant::now());
            }
            self.changed.notify_all();
        }
        let mut status = None;
        let mut eof = false;
        let mut pending_output: Option<Vec<u8>> = None;
        let mut active: Option<(Command, usize)> = None;
        let mut signalled_at: Option<Instant> = None;
        let mut killed = false;
        let mut output_complete = true;
        let mut failure: Option<String> = None;
        let mut buffer = [0u8; READ_BYTES];
        loop {
            let until = self.state.lock().unwrap_or_else(|p| p.into_inner()).closing;
            if let Some(until) = until {
                if signalled_at.is_none() {
                    if status.is_none() {
                        signal_owned(&**master.as_ref().expect("open PTY"), pid, libc::SIGHUP);
                    }
                    signalled_at = Some(Instant::now());
                }
                let grace_elapsed =
                    signalled_at.is_some_and(|at| at.elapsed() >= Duration::from_millis(80));
                if status.is_none() && !killed && (grace_elapsed || Instant::now() >= until) {
                    signal_owned(&**master.as_ref().expect("open PTY"), pid, libc::SIGKILL);
                    killed = true;
                }
                if Instant::now() >= until && (!eof || pending_output.is_some()) {
                    output_complete = false;
                    failure.get_or_insert_with(|| {
                        "DEADLINE_EXCEEDED: unread PTY output may remain".into()
                    });
                    pending_output = None;
                    eof = true;
                }
                if Instant::now() >= until {
                    // Once draining has timed out, retaining the master can keep a blocked slave alive.
                    drop(reader.take());
                    drop(writer.take());
                    drop(master.take());
                }
            }
            if status.is_none() {
                match child.try_wait() {
                    Ok(value) => status = value,
                    Err(error) => {
                        failure = Some(format!("PTY_WAIT_FAILED: {error}"));
                        self.request_close(Instant::now());
                        // Retain ownership and retry reaping; a wait failure is never a fabricated exit.
                    }
                }
            }
            if let Some(bytes) = pending_output.take() {
                let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if state.sequence == u32::MAX - 1 {
                    state.closing = Some(Instant::now());
                    eof = true;
                    output_complete = false;
                    failure =
                        Some("EVENT_SEQUENCE_EXHAUSTED: PTY sequence space is exhausted".into());
                } else if state.events.len() < OUTPUT_CHUNKS {
                    state.sequence += 1;
                    state.bytes_emitted += bytes.len() as u64;
                    let event = Event {
                        resource_id: self.id.clone(),
                        sequence: state.sequence,
                        kind: "data",
                        data: bytes,
                        exit_code: 0,
                        signal: 0,
                        output_complete: true,
                        error: None,
                    };
                    state.events.push_back(event);
                    state.peak_queue = state.peak_queue.max(state.events.len());
                    self.event_ready.notify_one();
                } else {
                    pending_output = Some(bytes);
                }
            }
            if !eof && pending_output.is_none() {
                match reader.as_mut().expect("readable PTY").read(&mut buffer) {
                    Ok(0) => eof = true,
                    Ok(count) => {
                        self.state
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .bytes_read += count as u64;
                        pending_output = Some(buffer[..count].to_vec());
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(error) => {
                        eof = true;
                        output_complete = false;
                        failure = Some(format!("PTY_READ_FAILED: {error}"));
                        self.request_close(Instant::now());
                    }
                }
            }
            if active.is_none() {
                active = self
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .commands
                    .pop_front()
                    .map(|command| (command, 0));
            }
            if let Some((command, mut offset)) = active.take() {
                let result = if let Err(error) = command.operation.check() {
                    Some(Err(NativeError::new(
                        error.code,
                        format!("{}; bytesWritten={offset}", error.message),
                    )))
                } else if status.is_some() || until.is_some() {
                    Some(Err(NativeError::new(
                        "CLOSED",
                        format!("PTY is closing; bytesWritten={offset}"),
                    )))
                } else {
                    match &command.kind {
                        CommandKind::Resize(cols, rows) => Some(
                            master
                                .as_ref()
                                .expect("open PTY")
                                .resize(PtySize {
                                    rows: *rows,
                                    cols: *cols,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                })
                                .map(|_| 0)
                                .map_err(|error| {
                                    NativeError::new("PTY_RESIZE_FAILED", error.to_string())
                                }),
                        ),
                        CommandKind::Write(data) => {
                            if offset == data.len() {
                                Some(Ok(offset as u32))
                            } else {
                                match writer
                                    .as_mut()
                                    .expect("writable PTY")
                                    .write(&data[offset..(offset + READ_BYTES).min(data.len())])
                                {
                                    Ok(0) => Some(Err(NativeError::new(
                                        "PTY_WRITE_FAILED",
                                        format!("zero-length write; bytesWritten={offset}"),
                                    ))),
                                    Ok(count) => {
                                        offset += count;
                                        command
                                            .completion
                                            .written
                                            .store(offset as u64, Ordering::Release);
                                        (offset == data.len()).then_some(Ok(offset as u32))
                                    }
                                    Err(error)
                                        if matches!(
                                            error.kind(),
                                            std::io::ErrorKind::WouldBlock
                                                | std::io::ErrorKind::Interrupted
                                        ) =>
                                    {
                                        None
                                    }
                                    Err(error) => Some(Err(NativeError::new(
                                        "PTY_WRITE_FAILED",
                                        format!("{error}; bytesWritten={offset}"),
                                    ))),
                                }
                            }
                        }
                    }
                };
                match result {
                    Some(result) => {
                        let result = result.map(|bytes_written| CommandResult {
                            operation_id: command.id.clone(),
                            resource_id: self.id.clone(),
                            bytes_written,
                        });
                        self.complete_command(command, result);
                    }
                    None => active = Some((command, offset)),
                }
            }
            if status.is_some() && eof && pending_output.is_none() {
                break;
            }
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let idle = pending_output.is_none() && active.is_none() && state.commands.is_empty();
            let _ = self
                .changed
                .wait_timeout(state, Duration::from_millis(if idle { 10 } else { 2 }))
                .unwrap_or_else(|p| p.into_inner());
        }
        if let Some((command, offset)) = active {
            self.complete_command(
                command,
                Err(NativeError::new(
                    "CLOSED",
                    format!("PTY exited; bytesWritten={offset}"),
                )),
            );
        }
        let status = status.expect("loop exits only after child was reaped");
        let (exit_code, signal) = exit_report(&status);
        // Drop OS resources before publishing the final event and waking close waiters.
        drop(reader);
        drop(writer);
        drop(master);
        drop(child);
        self.finish(exit_code, signal, failure, output_complete);
    }
}

#[cfg(unix)]
fn signal_owned(master: &dyn portable_pty::MasterPty, pid: u32, signal: i32) {
    if pid <= 1 || pid > i32::MAX as u32 {
        return;
    }
    let pid = pid as i32;
    let app_group = unsafe { libc::getpgrp() };
    // The kernel restricts this controlling terminal's foreground group to its own session.
    // getsid(child) is not a portable check: implementations may restrict inspection across sessions.
    let foreground = master
        .process_group_leader()
        .filter(|group| *group > 1 && *group != app_group);
    if let Some(group) = foreground {
        unsafe {
            libc::kill(-group, signal);
        }
    }
    if pid != app_group && foreground != Some(pid) && unsafe { libc::getpgid(pid) } == pid {
        unsafe {
            libc::kill(-pid, signal);
        }
    }
    // This child has not been reaped, so its PID cannot have been recycled.
    unsafe {
        libc::kill(pid, signal);
    }
}

#[cfg(unix)]
fn exit_report(status: &portable_pty::ExitStatus) -> (u32, i32) {
    let text = status.to_string();
    let Some(name) = text.strip_prefix("Terminated by ") else {
        return (status.exit_code(), 0);
    };
    if let Some(number) = name
        .strip_prefix("Signal ")
        .and_then(|value| value.parse().ok())
    {
        return (0, number);
    }
    for signal in 1..64 {
        let text = unsafe { libc::strsignal(signal) };
        if !text.is_null() && unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy() == name {
            return (0, signal);
        }
    }
    (0, 0)
}
