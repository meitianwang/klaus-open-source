//! ConPTY handles with overlapped parent pipes and a process tree owned by a Job Object.

use super::super::{NativeError, Result, StartOptions, READ_BYTES};
use std::collections::BTreeMap;
use std::ffi::{c_void, OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread::JoinHandle;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::IO::*;

static PIPE_SERIAL: AtomicU64 = AtomicU64::new(0);

struct PipeSecurity(*mut c_void);
impl PipeSecurity {
    fn new() -> Result<Self> {
        // The default named-pipe DACL also allows Everyone/Anonymous read access.
        let descriptor = wide(OsStr::new("D:P(A;;GA;;;SY)(A;;GA;;;OW)"));
        let mut pointer = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                SDDL_REVISION_1,
                &mut pointer,
                null_mut(),
            )
        } == 0
        {
            return Err(failure("PTY_PIPE_FAILED"));
        }
        Ok(Self(pointer))
    }
}
impl Drop for PipeSecurity {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn failure(code: &'static str) -> NativeError {
    NativeError::new(code, io::Error::last_os_error().to_string())
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn own(handle: HANDLE, code: &'static str) -> Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(failure(code))
    } else {
        // The API returned one newly owned, valid kernel handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}
fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle()
}

pub(super) struct Pipe {
    handle: OwnedHandle,
    _event: OwnedHandle,
    overlapped: Box<OVERLAPPED>,
    buffer: Box<[u8; READ_BYTES]>,
    pending: bool,
    requested: usize,
}

impl Pipe {
    fn pair(read: bool) -> Result<(Self, OwnedHandle)> {
        let security = PipeSecurity::new()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security.0,
            bInheritHandle: 0,
        };
        let name = wide(OsStr::new(&format!(
            r"\\.\pipe\klaus-native-pty-{}-{}",
            std::process::id(),
            PIPE_SERIAL.fetch_add(1, Ordering::Relaxed)
        )));
        let access = if read {
            PIPE_ACCESS_INBOUND
        } else {
            PIPE_ACCESS_OUTBOUND
        };
        let handle = own(
            unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    access | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    READ_BYTES as u32,
                    READ_BYTES as u32,
                    0,
                    &attributes,
                )
            },
            "PTY_PIPE_FAILED",
        )?;
        let event = own(
            unsafe { CreateEventW(null(), 1, 0, null()) },
            "PTY_PIPE_FAILED",
        )?;
        let mut overlapped = Box::<OVERLAPPED>::default();
        overlapped.hEvent = raw(&event);
        let connecting = unsafe { ConnectNamedPipe(raw(&handle), &mut *overlapped) };
        if connecting == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(failure("PTY_PIPE_FAILED"));
        }
        let peer = match own(
            unsafe {
                CreateFileW(
                    name.as_ptr(),
                    if read { GENERIC_WRITE } else { GENERIC_READ },
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
                    null_mut(),
                )
            },
            "PTY_PIPE_FAILED",
        ) {
            Ok(peer) => peer,
            Err(error) => {
                // The connection buffer must outlive cancellation completion.
                unsafe {
                    CancelIoEx(raw(&handle), &*overlapped);
                    let mut ignored = 0;
                    GetOverlappedResult(raw(&handle), &*overlapped, &mut ignored, 1);
                }
                return Err(error);
            }
        };
        let mut transferred = 0;
        if unsafe { GetOverlappedResult(raw(&handle), &*overlapped, &mut transferred, 1) } == 0 {
            return Err(failure("PTY_PIPE_FAILED"));
        }
        Ok((
            Self {
                handle,
                _event: event,
                overlapped,
                buffer: Box::new([0; READ_BYTES]),
                pending: false,
                requested: 0,
            },
            peer,
        ))
    }

    fn poll(&mut self) -> io::Result<usize> {
        let mut count = 0;
        if unsafe { GetOverlappedResult(raw(&self.handle), &*self.overlapped, &mut count, 0) } != 0
        {
            self.pending = false;
            return Ok(count as usize);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        self.pending = false;
        Err(error)
    }

    pub(super) fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let result = if self.pending {
            self.poll()
        } else {
            unsafe {
                ResetEvent(self.overlapped.hEvent);
            }
            let mut count = 0;
            if unsafe {
                ReadFile(
                    raw(&self.handle),
                    self.buffer.as_mut_ptr(),
                    READ_BYTES as u32,
                    &mut count,
                    &mut *self.overlapped,
                )
            } != 0
            {
                Ok(count as usize)
            } else {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
                    self.pending = true;
                    Err(io::ErrorKind::WouldBlock.into())
                } else {
                    Err(error)
                }
            }
        };
        match result {
            Ok(count) => {
                output[..count].copy_from_slice(&self.buffer[..count]);
                Ok(count)
            }
            Err(error) if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => Ok(0),
            Err(error) => Err(error),
        }
    }

    pub(super) fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        if self.pending {
            return self.poll();
        }
        self.requested = input.len().min(READ_BYTES);
        self.buffer[..self.requested].copy_from_slice(&input[..self.requested]);
        unsafe {
            ResetEvent(self.overlapped.hEvent);
        }
        let mut count = 0;
        if unsafe {
            WriteFile(
                raw(&self.handle),
                self.buffer.as_ptr(),
                self.requested as u32,
                &mut count,
                &mut *self.overlapped,
            )
        } != 0
        {
            return Ok(count as usize);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
            self.pending = true;
            Err(io::ErrorKind::WouldBlock.into())
        } else {
            Err(error)
        }
    }

    pub(super) fn pending(&self) -> bool {
        self.pending
    }
    pub(super) fn cancel(&mut self) {
        if self.pending {
            unsafe {
                CancelIoEx(raw(&self.handle), &*self.overlapped);
            }
        }
    }
    pub(super) fn poll_cancelled_write(&mut self) -> io::Result<usize> {
        self.poll()
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        if self.pending {
            // A cancellation request alone does not release the kernel's buffer/OVERLAPPED borrow.
            unsafe {
                CancelIoEx(raw(&self.handle), &*self.overlapped);
                let mut ignored = 0;
                GetOverlappedResult(raw(&self.handle), &*self.overlapped, &mut ignored, 1);
            }
        }
    }
}

struct Attributes {
    buffer: Box<[usize]>,
    initialized: bool,
}
impl Attributes {
    fn new(hpc: HPCON) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(failure("PTY_SPAWN_FAILED"));
        }
        let mut value = Self {
            buffer: vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())].into_boxed_slice(),
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(value.pointer(), 1, 0, &mut bytes) } == 0 {
            return Err(failure("PTY_SPAWN_FAILED"));
        }
        value.initialized = true;
        if unsafe {
            UpdateProcThreadAttribute(
                value.pointer(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const c_void,
                std::mem::size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(failure("PTY_SPAWN_FAILED"));
        }
        Ok(value)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer());
            }
        }
    }
}

enum ControlCommand {
    Resize(u16, u16, SyncSender<Result<()>>),
    Close,
}

pub(super) struct Process {
    pub(super) output: Option<Pipe>,
    pub(super) input: Option<Pipe>,
    process: OwnedHandle,
    job: OwnedHandle,
    control: Option<SyncSender<ControlCommand>>,
    controller: Option<JoinHandle<()>>,
    resize_result: Option<Receiver<Result<()>>>,
    closing: bool,
    close_queued: bool,
    pub(super) pid: u32,
}

impl Process {
    pub(super) fn spawn(options: &StartOptions) -> Result<Self> {
        if !options.cwd.is_dir() {
            return Err(NativeError::new(
                "INVALID_CWD",
                "PTY cwd is not a directory",
            ));
        }
        let (mut environment, executable) = command_environment(options)?;
        let executable_wide = wide(&executable);
        let mut command = command_line(&executable, &options.args);
        let cwd = wide(options.cwd.as_os_str());
        let (input, child_input) = Pipe::pair(false)?;
        let (output, child_output) = Pipe::pair(true)?;
        let mut hpc = 0;
        let hr = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: options.cols as i16,
                    Y: options.rows as i16,
                },
                raw(&child_input),
                raw(&child_output),
                0,
                &mut hpc,
            )
        };
        if hr < 0 {
            return Err(NativeError::new(
                "PTY_OPEN_FAILED",
                format!("CreatePseudoConsole HRESULT {hr:#x}"),
            ));
        }
        let mut launch = || -> Result<(OwnedHandle, OwnedHandle, u32)> {
            let mut attributes = Attributes::new(hpc)?;
            let job = own(
                unsafe { CreateJobObjectW(null(), null()) },
                "PTY_JOB_FAILED",
            )?;
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    raw(&job),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(failure("PTY_JOB_FAILED"));
            }
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            // Explicit null standard handles prevent inheriting a redirected host stdin/stdout.
            // ConPTY replaces them with the new console handles during child initialization.
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.lpAttributeList = attributes.pointer();
            let mut info = PROCESS_INFORMATION::default();
            if unsafe {
                CreateProcessW(
                    executable_wide.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                    environment.as_mut_ptr().cast(),
                    cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                )
            } == 0
            {
                return Err(failure("PTY_SPAWN_FAILED"));
            }
            let process = own(info.hProcess, "PTY_SPAWN_FAILED")?;
            let thread = match own(info.hThread, "PTY_SPAWN_FAILED") {
                Ok(thread) => thread,
                Err(error) => {
                    unsafe {
                        TerminateProcess(raw(&process), 1);
                        WaitForSingleObject(raw(&process), INFINITE);
                    }
                    return Err(error);
                }
            };
            // The child cannot create descendants before it belongs to this private job.
            if unsafe { AssignProcessToJobObject(raw(&job), raw(&process)) } == 0
                || unsafe { ResumeThread(raw(&thread)) } == u32::MAX
            {
                let error = failure("PTY_JOB_FAILED");
                unsafe {
                    TerminateProcess(raw(&process), 1);
                    WaitForSingleObject(raw(&process), INFINITE);
                }
                return Err(error);
            }
            Ok((process, job, info.dwProcessId))
        };
        match launch() {
            Ok((process, job, pid)) => {
                // ConPTY holds its own copies; these references would prevent EOF detection.
                drop(child_input);
                drop(child_output);
                let (control, receiver) = mpsc::sync_channel(1);
                let controller = match std::thread::Builder::new()
                    .name("native-conpty-control".into())
                    .spawn(move || {
                        // This thread exclusively owns HPCON; resize and close can never overlap.
                        while let Ok(command) = receiver.recv() {
                            match command {
                                ControlCommand::Resize(cols, rows, result) => {
                                    let hr = unsafe {
                                        ResizePseudoConsole(
                                            hpc,
                                            COORD {
                                                X: cols as i16,
                                                Y: rows as i16,
                                            },
                                        )
                                    };
                                    let outcome = if hr < 0 {
                                        Err(NativeError::new(
                                            "PTY_RESIZE_FAILED",
                                            format!("HRESULT {hr:#x}"),
                                        ))
                                    } else {
                                        Ok(())
                                    };
                                    let _ = result.send(outcome);
                                }
                                ControlCommand::Close => break,
                            }
                        }
                        // The I/O coordinator continues draining throughout this blocking API call.
                        unsafe {
                            ClosePseudoConsole(hpc);
                        }
                    }) {
                    Ok(controller) => controller,
                    Err(error) => {
                        unsafe {
                            TerminateJobObject(raw(&job), 1);
                            WaitForSingleObject(raw(&process), INFINITE);
                        }
                        drop(input);
                        drop(output);
                        unsafe {
                            ClosePseudoConsole(hpc);
                        }
                        return Err(NativeError::new("WORKER_FAILED", error.to_string()));
                    }
                };
                Ok(Self {
                    output: Some(output),
                    input: Some(input),
                    process,
                    job,
                    control: Some(control),
                    controller: Some(controller),
                    resize_result: None,
                    closing: false,
                    close_queued: false,
                    pid,
                })
            }
            Err(error) => {
                drop(child_input);
                drop(child_output);
                drop(input);
                drop(output);
                unsafe {
                    ClosePseudoConsole(hpc);
                }
                Err(error)
            }
        }
    }

    pub(super) fn resize(&mut self, cols: u16, rows: u16) -> Option<Result<()>> {
        if self.resize_result.is_none() {
            if self.closing {
                return Some(Err(NativeError::new("CLOSED", "ConPTY is closing")));
            }
            let (result, receiver) = mpsc::sync_channel(1);
            if self
                .control
                .as_ref()
                .expect("live controller")
                .try_send(ControlCommand::Resize(cols, rows, result))
                .is_err()
            {
                return Some(Err(NativeError::new(
                    "PTY_CONTROL_FAILED",
                    "ConPTY controller is unavailable",
                )));
            }
            self.resize_result = Some(receiver);
        }
        self.poll_resize()
    }
    pub(super) fn poll_resize(&mut self) -> Option<Result<()>> {
        let result = self
            .resize_result
            .as_ref()
            .expect("one active resize")
            .try_recv();
        match result {
            Ok(result) => {
                self.resize_result = None;
                Some(result)
            }
            Err(TryRecvError::Empty) => None,
            Err(TryRecvError::Disconnected) => {
                self.resize_result = None;
                Some(Err(NativeError::new(
                    "PTY_CONTROL_FAILED",
                    "ConPTY controller stopped",
                )))
            }
        }
    }
    pub(super) fn try_wait(&self) -> Result<Option<u32>> {
        match unsafe { WaitForSingleObject(raw(&self.process), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(raw(&self.process), &mut code) } == 0 {
                    Err(failure("PTY_WAIT_FAILED"))
                } else {
                    Ok(Some(code))
                }
            }
            _ => Err(failure("PTY_WAIT_FAILED")),
        }
    }
    pub(super) fn terminate(&mut self) -> Result<()> {
        if unsafe { TerminateJobObject(raw(&self.job), 1) } == 0 {
            return Err(failure("PTY_KILL_FAILED"));
        }
        Ok(())
    }
    pub(super) fn tree_exited(&self) -> Result<bool> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                raw(&self.job),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                null_mut(),
            )
        } == 0
        {
            return Err(failure("PTY_WAIT_FAILED"));
        }
        Ok(accounting.ActiveProcesses == 0)
    }
    pub(super) fn begin_close(&mut self) {
        self.closing = true;
        if !self.close_queued {
            match self
                .control
                .as_ref()
                .expect("live controller")
                .try_send(ControlCommand::Close)
            {
                Ok(()) | Err(TrySendError::Disconnected(_)) => self.close_queued = true,
                Err(TrySendError::Full(_)) => {}
            }
        }
    }
    pub(super) fn force_close_io(&mut self) {
        drop(self.input.take());
        drop(self.output.take());
    }
    pub(super) fn close_finished(&self) -> bool {
        self.closing && self.controller.as_ref().is_none_or(JoinHandle::is_finished)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = unsafe { TerminateJobObject(raw(&self.job), 1) };
        self.force_close_io();
        drop(self.control.take());
        if let Some(controller) = self.controller.take() {
            let _ = controller.join();
        }
    }
}

fn command_environment(options: &StartOptions) -> Result<(Vec<u16>, OsString)> {
    let mut values = BTreeMap::<String, (OsString, OsString)>::new();
    for (key, value) in std::env::vars_os() {
        values.insert(key.to_string_lossy().to_uppercase(), (key, value));
    }
    for (key, value) in &options.env {
        values.insert(key.to_uppercase(), (key.into(), value.into()));
    }
    for (key, value) in [
        ("TERM", OsString::from("xterm-256color")),
        ("COLORTERM", OsString::from("truecolor")),
        ("PWD", options.cwd.clone().into_os_string()),
    ] {
        values.insert(key.into(), (key.into(), value));
    }
    let command = PathBuf::from(&options.command);
    let executable = if command.is_absolute() {
        command
    } else if command.components().count() > 1 {
        options.cwd.join(command)
    } else {
        let mut directories = vec![options.cwd.clone()];
        if let Some((_, search)) = values.get("PATH") {
            directories.extend(std::env::split_paths(search));
        }
        directories
            .into_iter()
            .flat_map(|directory| {
                let mut candidates = vec![directory.join(&command)];
                if command.extension().is_none() {
                    candidates.push(directory.join(&command).with_extension("exe"));
                }
                candidates
            })
            .find(|candidate| candidate.is_file())
            .ok_or_else(|| {
                NativeError::new("PTY_SPAWN_FAILED", "executable was not found on PATH")
            })?
    };
    if !executable.is_file() {
        return Err(NativeError::new(
            "PTY_SPAWN_FAILED",
            "executable is not a file",
        ));
    }
    let mut block = Vec::new();
    for (key, value) in values.values() {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    Ok((block, executable.into_os_string()))
}

fn quote_argument(value: &OsStr) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for unit in value.encode_wide() {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
        } else {
            result.extend(std::iter::repeat_n(b'\\' as u16, slashes));
        }
        result.push(unit);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}
fn command_line(executable: &OsStr, args: &[String]) -> Vec<u16> {
    let mut result = quote_argument(executable);
    for argument in args {
        result.push(b' ' as u16);
        result.extend(quote_argument(OsStr::new(argument)));
    }
    result.push(0);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapped_write_is_cancelled_before_its_buffer_can_be_reused() {
        let (mut writer, reader) = Pipe::pair(false).unwrap();
        let bytes = [b'x'; READ_BYTES];
        for _ in 0..128 {
            match writer.write(&bytes) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("unexpected pipe error: {error}"),
            }
        }
        assert!(writer.pending());
        writer.cancel();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match writer.poll_cancelled_write() {
                Ok(_) => break,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < until =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(1))
                }
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(ERROR_OPERATION_ABORTED as i32));
                    break;
                }
            }
        }
        assert!(!writer.pending());
        drop(reader);
    }
    #[test]
    fn windows_argument_quotes_preserve_empty_spaces_quotes_and_final_backslashes() {
        for (input, expected) in [
            ("", "\"\""),
            ("two words", "\"two words\""),
            ("a\"b", "\"a\\\"b\""),
            ("C:\\last\\", "\"C:\\last\\\\\""),
        ] {
            assert_eq!(
                String::from_utf16(&quote_argument(OsStr::new(input))).unwrap(),
                expected
            );
        }
    }
}
