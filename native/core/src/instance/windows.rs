use super::{error, protocol, Acquisition, Options, Shared, MAX_PAYLOAD};
use crate::Result;
use std::ptr::{null, null_mut};
use std::sync::atomic::Ordering;
use std::sync::{mpsc::SyncSender, Arc};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_CLASS_ALREADY_EXISTS,
    HANDLE, HWND, LPARAM, LRESULT, WAIT_ABANDONED, WAIT_OBJECT_0, WPARAM,
};
use windows_sys::Win32::System::DataExchange::COPYDATASTRUCT;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{
    CreateMutexW, GetCurrentProcessId, ReleaseMutex, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const WAKE: u32 = WM_APP + 1542;
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

pub(super) fn wake(shared: &Shared) {
    let hwnd = shared.endpoint.load(Ordering::Acquire) as HWND;
    if !hwnd.is_null() {
        unsafe {
            PostMessageW(hwnd, WAKE, 0, 0);
        }
    }
}
pub(super) fn held(shared: &Shared) -> bool {
    let hwnd = shared.endpoint.load(Ordering::Acquire) as HWND;
    let mut pid = 0;
    unsafe {
        !hwnd.is_null()
            && IsWindow(hwnd) != 0
            && GetWindowThreadProcessId(hwnd, &mut pid) != 0
            && pid == GetCurrentProcessId()
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        // DefWindowProc initializes the window title from CREATESTRUCT. Skipping
        // it produces a live but undiscoverable compatibility window.
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let shared = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Shared).as_ref();
    match message {
        WM_COPYDATA => {
            let Some(shared) = shared else {
                return 0;
            };
            if !shared.primary.load(Ordering::Acquire) {
                return 0;
            }
            if lparam == 0 {
                return 0;
            }
            // WM_COPYDATA is marshalled by USER32. Respect its explicit bound;
            // the shipped protocol's CStr scan must never run on hostile input.
            let data = &*(lparam as *const COPYDATASTRUCT);
            if data.dwData != 1542
                || data.cbData == 0
                || data.cbData as usize > MAX_PAYLOAD
                || data.lpData.is_null()
            {
                return 0;
            }
            let bytes = std::slice::from_raw_parts(data.lpData.cast::<u8>(), data.cbData as usize);
            match protocol::decode_windows(bytes) {
                Ok((cwd, args)) => i32::from(shared.activation(cwd, args)) as _,
                Err(_) => 0,
            }
        }
        WM_CLOSE => 0, // An external WM_CLOSE must not release the data-owner lock.
        WM_NCDESTROY => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if let Some(shared) = shared {
                shared.endpoint.store(0, Ordering::Release);
                if shared.primary.load(Ordering::Acquire)
                    && !shared.stopping.load(Ordering::Acquire)
                {
                    shared.fail("INSTANCE_ENDPOINT_LOST");
                }
            }
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
        WAKE => 0,
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

struct Handles {
    window: HWND,
    mutex: HANDLE,
    owns_mutex: bool,
    owns_class: bool,
    class: Vec<u16>,
}

struct StartupLock(HANDLE);
impl StartupLock {
    fn acquire(identity: &str, deadline: Instant) -> Result<Self> {
        let name = wide(&format!("{identity}-electron-si-start"));
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(error("INSTANCE_STARTUP_LOCK_FAILED"));
        }
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(5000) as u32;
        let result = unsafe { WaitForSingleObject(handle, timeout) };
        if matches!(result, WAIT_OBJECT_0 | WAIT_ABANDONED) {
            Ok(Self(handle))
        } else {
            unsafe {
                CloseHandle(handle);
            }
            Err(error("INSTANCE_STARTUP_BUSY"))
        }
    }
}
impl Drop for StartupLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}
impl Drop for Handles {
    fn drop(&mut self) {
        unsafe {
            // The same native thread creates and closes every handle. Closing
            // the endpoint precedes ReleaseMutex, so no new writer can overlap.
            if !self.window.is_null() {
                DestroyWindow(self.window);
            }
            if self.owns_mutex {
                ReleaseMutex(self.mutex);
            }
            if !self.mutex.is_null() {
                CloseHandle(self.mutex);
            }
            if self.owns_class {
                UnregisterClassW(self.class.as_ptr(), GetModuleHandleW(null()));
            }
        }
    }
}

fn drain_messages() -> Result<()> {
    let mut message: MSG = unsafe { std::mem::zeroed() };
    unsafe {
        for _ in 0..64 {
            if PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) == 0 {
                break;
            }
            if message.message == WM_QUIT {
                return Err(error("INSTANCE_ENDPOINT_LOST"));
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

fn forward(window: HWND, options: &Options, deadline: Instant) -> Result<Acquisition> {
    let bytes = protocol::encode_windows(options)?;
    let copy = COPYDATASTRUCT {
        dwData: 1542,
        cbData: bytes.len() as u32,
        lpData: bytes.as_ptr().cast_mut().cast(),
    };
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .as_millis()
        .min(5000) as u32;
    if remaining == 0 {
        return Err(error("INSTANCE_ACTIVATION_TIMEOUT"));
    }
    let mut accepted = 0;
    let result = unsafe {
        SendMessageTimeoutW(
            window,
            WM_COPYDATA,
            0,
            (&copy as *const COPYDATASTRUCT) as _,
            SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
            remaining,
            &mut accepted,
        )
    };
    if result == 0 {
        return Err(error("INSTANCE_ACTIVATION_FAILED"));
    }
    if accepted != 1 {
        return Err(error("INSTANCE_ACTIVATION_REJECTED"));
    }
    Ok(Acquisition {
        acquired: false,
        forwarded: true,
        acknowledged: true,
    })
}

pub(super) fn run(
    options: &Options,
    deadline: Instant,
    shared: &Arc<Shared>,
    tx: &SyncSender<Result<Acquisition>>,
) -> Result<()> {
    protocol::encode_windows(options)?;
    // Serialize only new-client publication so FindWindow cannot select another
    // new process's provisional receiver. The legacy mutex remains authoritative.
    let startup = StartupLock::acquire(&options.identity, deadline)?;
    let class = wide(&format!("{}-sic", options.identity));
    let title = wide(&format!("{}-siw", options.identity));
    let name = wide(&format!("{}-sim", options.identity));
    let module = unsafe { GetModuleHandleW(null()) };
    let mut definition: WNDCLASSEXW = unsafe { std::mem::zeroed() };
    definition.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
    definition.lpfnWndProc = Some(window_proc);
    definition.hInstance = module;
    definition.lpszClassName = class.as_ptr();
    unsafe {
        SetLastError(0);
    }
    let owns_class = unsafe { RegisterClassExW(&definition) } != 0;
    if !owns_class && unsafe { GetLastError() } != ERROR_CLASS_ALREADY_EXISTS {
        return Err(error("INSTANCE_WINDOW_CLASS_FAILED"));
    }
    let mut handles = Handles {
        window: null_mut(),
        mutex: null_mut(),
        owns_mutex: false,
        owns_class,
        class,
    };
    // FindWindowW only discovers a top-level window. A message-only window or
    // a mutex without this compatible class/title lets the old client continue.
    handles.window = unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            handles.class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            null_mut(),
            null_mut(),
            module,
            Arc::as_ptr(shared).cast_mut().cast(),
        )
    };
    if handles.window.is_null() {
        return Err(error("INSTANCE_WINDOW_FAILED"));
    }
    let mut actual_title = vec![0u16; title.len()];
    let length = unsafe {
        GetWindowTextW(
            handles.window,
            actual_title.as_mut_ptr(),
            actual_title.len() as i32,
        )
    };
    if length as usize != title.len() - 1 || actual_title != title {
        return Err(error("INSTANCE_WINDOW_TITLE_MISMATCH"));
    }
    shared
        .endpoint
        .store(handles.window as usize, Ordering::Release);
    // Publish the mutex only after the receiver exists. Neither this thread nor
    // WM_COPYDATA handling needs the JavaScript event loop to become ready.
    unsafe {
        SetLastError(0);
    }
    handles.mutex = unsafe { CreateMutexW(null(), 1, name.as_ptr()) };
    let existing = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if handles.mutex.is_null() {
        return Err(error("INSTANCE_MUTEX_FAILED"));
    }
    if existing {
        unsafe {
            DestroyWindow(handles.window);
        }
        handles.window = null_mut();
        loop {
            let window = unsafe { FindWindowW(handles.class.as_ptr(), title.as_ptr()) };
            if !window.is_null() {
                match forward(window, options, deadline) {
                    Ok(acquisition) => {
                        let _ = tx.send(Ok(acquisition));
                        return Ok(());
                    }
                    // A concurrent new process may briefly expose its receiver
                    // before discovering the primary mutex. A negative ACK has
                    // not accepted the activation and can be retried safely.
                    Err(failure) if failure.code == "INSTANCE_ACTIVATION_REJECTED" => {}
                    Err(failure) => return Err(failure),
                }
            }
            if shared.stopping.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(error("INSTANCE_OWNER_WINDOW_MISSING"));
            }
            drain_messages()?;
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    handles.owns_mutex = true;
    shared.primary.store(true, Ordering::Release);
    if shared.stopping.load(Ordering::Acquire) {
        return Err(error("INSTANCE_ACQUIRE_TIMEOUT"));
    }
    drop(startup);
    tx.send(Ok(Acquisition {
        acquired: true,
        forwarded: false,
        acknowledged: false,
    }))
    .map_err(|_| error("INSTANCE_ACQUIRE_TIMEOUT"))?;
    while !shared.stopping.load(Ordering::Acquire) {
        if let Err(failure) = drain_messages() {
            shared.fail(failure.code);
        }
        if !held(shared) {
            shared.fail("INSTANCE_ENDPOINT_LOST");
        }
        // On a lost endpoint, retain the mutex while TypeScript closes all data
        // owners. Continue pumping a surviving window so legacy senders do not hang.
        // Bounded native wait is independent of JS startup, callbacks and exit.
        unsafe {
            MsgWaitForMultipleObjects(0, null(), 0, 20, QS_ALLINPUT);
        }
    }
    drop(handles);
    Ok(())
}
