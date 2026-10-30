//! A single coordinator owns ConPTY I/O. Pending kernel buffers are never detached or reused.

use super::*;
use std::io::ErrorKind;

mod process;
use process::Process;

pub(super) fn run(resource: &Pty, options: StartOptions) {
    let setup = || {
        if resource
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .closing
            .is_some()
        {
            return Err(NativeError::new("CLOSED", "PTY creation was cancelled"));
        }
        Process::spawn(&options)
    };
    let mut process = match setup() {
        Ok(process) => process,
        Err(error) => {
            resource
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .ready = Some(Err(error.clone()));
            resource.finish(1, 0, Some(error.to_string()), false);
            return;
        }
    };
    {
        let mut state = resource.state.lock().unwrap_or_else(|p| p.into_inner());
        state.ready = Some(Ok(StartInfo {
            resource_id: resource.id.clone(),
            pid: process.pid,
            cwd: options.cwd.to_string_lossy().into(),
            command: options.command,
        }));
        if Instant::now() >= resource.start_deadline {
            state.closing = Some(Instant::now());
        }
        resource.changed.notify_all();
    }
    let mut status = None;
    let mut tree_exited = false;
    let mut terminated = false;
    let mut eof = false;
    let mut pending_output: Option<Vec<u8>> = None;
    let mut active: Option<(Command, usize)> = None;
    let mut output_complete = true;
    let mut failure = None;
    let mut buffer = [0; READ_BYTES];
    loop {
        let until = resource
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .closing;
        if status.is_none() {
            match process.try_wait() {
                Ok(value) => status = value,
                Err(error) => {
                    failure = Some(error.to_string());
                    resource.request_close(Instant::now());
                }
            }
        }
        if (until.is_some() || status.is_some()) && !terminated {
            match process.terminate() {
                Ok(()) => terminated = true,
                Err(error) => {
                    failure = Some(error.to_string());
                    resource.request_close(Instant::now());
                }
            }
        }
        if terminated && !tree_exited {
            match process.tree_exited() {
                Ok(value) => tree_exited = value,
                Err(error) => {
                    failure = Some(error.to_string());
                    resource.request_close(Instant::now());
                }
            }
        }
        if until.is_some_and(|until| Instant::now() >= until) {
            if !eof || pending_output.is_some() {
                output_complete = false;
                failure.get_or_insert_with(|| {
                    "DEADLINE_EXCEEDED: unread PTY output may remain".into()
                });
                pending_output = None;
            }
            // A deadline explicitly abandons delivery. Continue draining into the same bounded
            // scratch buffer and count discarded bytes: closing a full pipe alone does not
            // reliably unblock ClosePseudoConsole on Windows 11 23H2.
            process.begin_close();
        }
        if let Some(bytes) = pending_output.take() {
            let mut state = resource.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.sequence == u32::MAX - 1 {
                state.closing = Some(Instant::now());
                eof = true;
                output_complete = false;
                failure = Some("EVENT_SEQUENCE_EXHAUSTED: PTY sequence space is exhausted".into());
            } else if state.events.len() < OUTPUT_CHUNKS {
                state.sequence += 1;
                let sequence = state.sequence;
                state.bytes_emitted += bytes.len() as u64;
                state.events.push_back(Event {
                    resource_id: resource.id.clone(),
                    sequence,
                    kind: "data",
                    data: bytes,
                    exit_code: 0,
                    signal: 0,
                    output_complete: true,
                    error: None,
                });
                state.peak_queue = state.peak_queue.max(state.events.len());
                resource.event_ready.notify_one();
            } else {
                pending_output = Some(bytes);
            }
        }
        if !eof && pending_output.is_none() {
            match process
                .output
                .as_mut()
                .expect("readable ConPTY")
                .read(&mut buffer)
            {
                Ok(0) => eof = true,
                Ok(count) => {
                    resource
                        .state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .bytes_read += count as u64;
                    pending_output = Some(buffer[..count].to_vec());
                }
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(error) => {
                    eof = true;
                    output_complete = false;
                    failure = Some(format!("PTY_READ_FAILED: {error}"));
                    resource.request_close(Instant::now());
                }
            }
        }
        if active.is_none() {
            active = resource
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .commands
                .pop_front()
                .map(|command| (command, 0));
        }
        if let Some((command, mut offset)) = active.take() {
            let result = step_command(
                &mut process,
                &command,
                &mut offset,
                until.is_some() || status.is_some(),
            );
            if let Some(result) = result {
                command
                    .completion
                    .control_in_flight
                    .store(false, Ordering::Release);
                command
                    .completion
                    .write_in_flight
                    .store(false, Ordering::Release);
                let result = result.map(|bytes_written| CommandResult {
                    operation_id: command.id.clone(),
                    resource_id: resource.id.clone(),
                    bytes_written,
                });
                resource.complete_command(command, result);
            } else {
                active = Some((command, offset));
            }
        }
        if terminated
            && tree_exited
            && pending_output.is_none()
            && resource
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .events
                .is_empty()
        {
            // Avoid entering the older ConPTY synchronous close while a full output queue is
            // already backpressuring conhost. At deadline the explicit discard path above wins.
            process.begin_close();
        }
        if status.is_some()
            && tree_exited
            && eof
            && pending_output.is_none()
            && process.close_finished()
        {
            break;
        }
        let state = resource.state.lock().unwrap_or_else(|p| p.into_inner());
        let idle = pending_output.is_none() && active.is_none() && state.commands.is_empty();
        let _ = resource
            .changed
            .wait_timeout(state, Duration::from_millis(if idle { 10 } else { 2 }))
            .unwrap_or_else(|p| p.into_inner());
    }
    if let Some((command, offset)) = active {
        let error = write_error(
            "CLOSED",
            "PTY exited",
            offset,
            command.completion.write_in_flight.load(Ordering::Acquire),
        );
        resource.complete_command(command, Err(error));
    }
    // The private job is empty, the root process was reaped, and the closer finished before done.
    drop(process);
    resource.finish(
        status.expect("child was reaped"),
        0,
        failure,
        output_complete,
    );
}

fn write_error(code: &'static str, message: &str, offset: usize, unknown: bool) -> NativeError {
    NativeError::new(
        code,
        format!("{message}; bytesWritten={offset}; writeOutcomeUnknown={unknown}"),
    )
}

fn step_command(
    process: &mut Process,
    command: &Command,
    offset: &mut usize,
    closing: bool,
) -> Option<Result<u32>> {
    let cancelled = command
        .operation
        .check()
        .err()
        .or_else(|| closing.then(|| NativeError::new("CLOSED", "PTY is closing")));
    if let Some(error) = cancelled {
        if command.completion.control_in_flight.load(Ordering::Acquire) {
            let _ = process.poll_resize()?;
            return Some(Err(NativeError::new(
                error.code,
                format!("{}; controlOutcomeUnknown=true", error.message),
            )));
        }
        let mut unknown = command.completion.write_in_flight.load(Ordering::Acquire);
        if let Some(input) = process.input.as_mut().filter(|input| input.pending()) {
            input.cancel();
            match input.poll_cancelled_write() {
                Ok(count) => {
                    *offset += count;
                    command
                        .completion
                        .written
                        .store(*offset as u64, Ordering::Release);
                    unknown = false;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => return None,
                // Cancellation may race a partial kernel write; never advertise its prefix as exact.
                Err(_) => {}
            }
        }
        return Some(Err(write_error(
            error.code,
            &error.message,
            *offset,
            unknown,
        )));
    }
    match &command.kind {
        CommandKind::Resize(cols, rows) => {
            command
                .completion
                .control_in_flight
                .store(true, Ordering::Release);
            process.resize(*cols, *rows).map(|result| result.map(|_| 0))
        }
        CommandKind::Write(data) => {
            if *offset == data.len() {
                return Some(Ok(*offset as u32));
            }
            let input = process.input.as_mut().expect("writable ConPTY");
            command
                .completion
                .write_in_flight
                .store(true, Ordering::Release);
            match input.write(&data[*offset..]) {
                Ok(0) => Some(Err(write_error(
                    "PTY_WRITE_FAILED",
                    "zero-length write",
                    *offset,
                    false,
                ))),
                Ok(count) => {
                    *offset += count;
                    command
                        .completion
                        .written
                        .store(*offset as u64, Ordering::Release);
                    command
                        .completion
                        .write_in_flight
                        .store(false, Ordering::Release);
                    if *offset == data.len() {
                        Some(Ok(*offset as u32))
                    } else {
                        None
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => None,
                Err(error) => Some(Err(write_error(
                    "PTY_WRITE_FAILED",
                    &error.to_string(),
                    *offset,
                    true,
                ))),
            }
        }
    }
}
