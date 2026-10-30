//! Main-thread AppKit resource only. Session ownership and preferences stay in TypeScript.
use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;

const MAX_EVENTS: usize = 64;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const MAX_QUEUE_BYTES: usize = 1024 * 1024;
static NEXT_GENERATION: AtomicU32 = AtomicU32::new(1);
static OWNER: Mutex<Option<Owner>> = Mutex::new(None);

struct Owner {
    generation: u32,
    closing: bool,
    sequence: u32,
    bytes: usize,
    events: VecDeque<(u32, String)>,
    error: Option<String>,
    changed: Arc<Notify>,
    reading: bool,
}

fn failure(message: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, message.into())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void, CStr, CString};
    unsafe extern "C" {
        fn klaus_pip_supported() -> i32;
        fn klaus_pip_host_open(
            view: *mut c_void,
            helper: *const c_char,
            generation: u64,
            callback: extern "C" fn(u64, *const c_char),
        ) -> i32;
        fn klaus_pip_host_command(generation: u64, json: *const c_char) -> i32;
        fn klaus_pip_host_shutdown(generation: u64);
        fn klaus_pip_host_pending(generation: u64, force: i32) -> i32;
        fn klaus_pip_host_inspect(generation: u64) -> *mut c_char;
        fn klaus_pip_free(value: *mut c_char);
    }
    pub fn supported() -> bool {
        unsafe { klaus_pip_supported() != 0 }
    }
    pub fn pending(generation: u32, force: bool) -> i32 {
        unsafe { klaus_pip_host_pending(generation.into(), i32::from(force)) }
    }
    pub fn close(generation: u32) {
        unsafe { klaus_pip_host_shutdown(generation.into()) }
    }
    pub fn command(generation: u32, json: &str) -> bool {
        CString::new(json).is_ok_and(|json| unsafe {
            klaus_pip_host_command(generation.into(), json.as_ptr()) != 0
        })
    }
    pub fn inspect(generation: u32) -> serde_json::Value {
        unsafe {
            let raw = klaus_pip_host_inspect(generation.into());
            if raw.is_null() {
                return serde_json::Value::Null;
            }
            let result = serde_json::from_slice(CStr::from_ptr(raw).to_bytes())
                .unwrap_or(serde_json::Value::Null);
            klaus_pip_free(raw);
            result
        }
    }
    pub fn open(generation: u32, window: &[u8], helper: &str) -> bool {
        let Ok(bytes) = window.try_into() else {
            return false;
        };
        let pointer = usize::from_ne_bytes(bytes);
        if pointer == 0 {
            return false;
        }
        CString::new(helper).is_ok_and(|helper| unsafe {
            klaus_pip_host_open(
                pointer as *mut c_void,
                helper.as_ptr(),
                generation.into(),
                callback,
            ) != 0
        })
    }
    extern "C" fn callback(generation: u64, raw: *const c_char) {
        if raw.is_null() {
            return;
        }
        let Ok(generation) = u32::try_from(generation) else {
            return;
        };
        // The Objective-C caller owns this UTF-8 string for the callback duration.
        let bytes = unsafe { CStr::from_ptr(raw).to_bytes() };
        super::enqueue(generation, bytes);
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn supported() -> bool {
        false
    }
    pub fn pending(_: u32, _: bool) -> i32 {
        0
    }
    pub fn close(_: u32) {}
    pub fn command(_: u32, _: &str) -> bool {
        false
    }
    pub fn inspect(_: u32) -> serde_json::Value {
        serde_json::Value::Null
    }
    pub fn open(_: u32, _: &[u8], _: &str) -> bool {
        false
    }
}

#[cfg(target_os = "macos")]
fn enqueue(generation: u32, bytes: &[u8]) {
    let Ok(mut owner) = OWNER.lock() else {
        return;
    };
    let Some(owner) = owner
        .as_mut()
        .filter(|owner| owner.generation == generation && !owner.closing && owner.error.is_none())
    else {
        return;
    };
    if bytes.len() > MAX_EVENT_BYTES
        || owner.events.len() >= MAX_EVENTS
        || owner.bytes + bytes.len() > MAX_QUEUE_BYTES
        || owner.sequence == u32::MAX
    {
        owner.error = Some("Native preview event backpressure limit exceeded".into());
        owner.changed.notify_one();
        return;
    }
    let Ok(event) = std::str::from_utf8(bytes) else {
        owner.error = Some("Native preview returned invalid UTF-8".into());
        owner.changed.notify_one();
        return;
    };
    owner.sequence += 1;
    owner.bytes += bytes.len();
    owner.events.push_back((owner.sequence, event.to_owned()));
    owner.changed.notify_one();
}

#[napi]
pub fn pip_supported() -> bool {
    platform::supported()
}

#[napi(object)]
pub struct PipEvent {
    pub resource_id: String,
    pub generation: u32,
    pub sequence: u32,
    pub event_json: String,
}

#[napi]
pub struct NativePip {
    resource_id: String,
    generation: u32,
}

#[napi]
impl NativePip {
    #[napi(constructor)]
    pub fn new(resource_id: String, window_handle: Buffer, helper_path: String) -> Result<Self> {
        if !platform::supported() {
            return Err(failure("Native picture-in-picture is unsupported"));
        }
        if resource_id.is_empty()
            || resource_id.len() > 128
            || !std::path::Path::new(&helper_path).is_absolute()
        {
            return Err(failure("Invalid native preview resource or producer path"));
        }
        let mut owner = OWNER
            .lock()
            .map_err(|_| failure("Native preview ownership was poisoned"))?;
        if let Some(previous) = owner.as_ref() {
            if !previous.closing || platform::pending(previous.generation, false) != 0 {
                return Err(failure("The previous native preview owner has not closed"));
            }
        }
        let generation = NEXT_GENERATION
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| failure("Native preview generation exhausted"))?;
        *owner = Some(Owner {
            generation,
            closing: false,
            sequence: 0,
            bytes: 0,
            events: VecDeque::new(),
            error: None,
            changed: Arc::new(Notify::new()),
            reading: false,
        });
        drop(owner);
        if !platform::open(generation, &window_handle, &helper_path) {
            let mut owner = OWNER
                .lock()
                .map_err(|_| failure("Native preview ownership was poisoned"))?;
            if owner
                .as_ref()
                .is_some_and(|owner| owner.generation == generation)
            {
                *owner = None;
            }
            return Err(failure("Native preview requires a live Electron main-thread window and executable producer"));
        }
        Ok(Self {
            resource_id,
            generation,
        })
    }

    #[napi]
    pub fn command(&self, operation_id: String, command_json: String) -> Result<String> {
        if operation_id.is_empty()
            || operation_id.len() > 128
            || command_json.len() > 32 * 1024 * 1024 + 65536
        {
            return Err(failure("Invalid preview operation ID or command size"));
        }
        let value: Value = serde_json::from_str(&command_json)
            .map_err(|_| failure("Invalid preview command JSON"))?;
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return Err(failure("Preview command type is required"));
        };
        if !matches!(
            kind,
            "layout"
                | "diagnostics"
                | "preferences"
                | "upsertWindow"
                | "upsertBrowser"
                | "remove"
                | "endSession"
                | "cursor"
        ) {
            return Err(failure("Unknown preview command"));
        }
        if kind == "diagnostics" {
            let path = value
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Preview diagnostic path is required"))?;
            let file = std::path::Path::new(path);
            if path.len() >= 4096
                || path.as_bytes().contains(&0)
                || !file.is_absolute()
                || file.file_name() != Some(std::ffi::OsStr::new("computer-use-pip-crash.log"))
            {
                return Err(failure("Invalid preview diagnostic path"));
            }
        }
        {
            let owner = OWNER
                .lock()
                .map_err(|_| failure("Native preview ownership was poisoned"))?;
            let current = owner
                .as_ref()
                .filter(|owner| owner.generation == self.generation && !owner.closing)
                .ok_or_else(|| failure("Native preview is closing"))?;
            if let Some(error) = &current.error {
                return Err(failure(error));
            }
        }
        if !platform::command(self.generation, &command_json) {
            return Err(failure("Native preview rejected this command or owner"));
        }
        Ok(json!({"operationId": operation_id, "resourceId": self.resource_id, "generation": self.generation, "accepted": true}).to_string())
    }

    /// Wait off the AppKit thread. Event draining and commands still run on JS main.
    /// A close or queue failure wakes the single admitted waiter immediately.
    #[napi]
    pub async fn wait_for_events(&self) -> Result<bool> {
        let changed = {
            let mut owner = OWNER
                .lock()
                .map_err(|_| failure("Native preview ownership was poisoned"))?;
            let Some(owner) = owner
                .as_mut()
                .filter(|owner| owner.generation == self.generation && !owner.closing)
            else {
                return Ok(false);
            };
            if owner.reading {
                return Err(failure("Native preview already has an event reader"));
            }
            owner.reading = true;
            owner.changed.clone()
        };
        struct Reader(u32);
        impl Drop for Reader {
            fn drop(&mut self) {
                if let Ok(mut owner) = OWNER.lock() {
                    if let Some(owner) = owner.as_mut().filter(|owner| owner.generation == self.0) {
                        owner.reading = false;
                    }
                }
            }
        }
        let _reader = Reader(self.generation);
        loop {
            let mut notified = std::pin::pin!(changed.notified());
            notified.as_mut().enable();
            {
                let owner = OWNER
                    .lock()
                    .map_err(|_| failure("Native preview ownership was poisoned"))?;
                let Some(owner) = owner
                    .as_ref()
                    .filter(|owner| owner.generation == self.generation && !owner.closing)
                else {
                    return Ok(false);
                };
                if let Some(error) = &owner.error {
                    return Err(failure(error));
                }
                if !owner.events.is_empty() {
                    return Ok(true);
                }
            }
            notified.await;
        }
    }

    #[napi]
    pub fn drain_events(&self) -> Result<Vec<PipEvent>> {
        let mut owner = OWNER
            .lock()
            .map_err(|_| failure("Native preview ownership was poisoned"))?;
        let Some(owner) = owner
            .as_mut()
            .filter(|owner| owner.generation == self.generation && !owner.closing)
        else {
            return Ok(vec![]);
        };
        if let Some(error) = &owner.error {
            return Err(failure(error));
        }
        owner.bytes = 0;
        Ok(owner
            .events
            .drain(..)
            .map(|(sequence, event_json)| PipEvent {
                resource_id: self.resource_id.clone(),
                generation: self.generation,
                sequence,
                event_json,
            })
            .collect())
    }

    #[napi]
    pub fn begin_close(&self) -> Result<()> {
        {
            let mut owner = OWNER
                .lock()
                .map_err(|_| failure("Native preview ownership was poisoned"))?;
            if let Some(owner) = owner
                .as_mut()
                .filter(|owner| owner.generation == self.generation)
            {
                owner.closing = true;
                owner.events.clear();
                owner.bytes = 0;
                owner.changed.notify_one();
            }
        }
        platform::close(self.generation);
        Ok(())
    }

    #[napi]
    pub fn report(&self, force: bool) -> Result<String> {
        let (closing, sequence, error) = {
            let owner = OWNER
                .lock()
                .map_err(|_| failure("Native preview ownership was poisoned"))?;
            owner
                .as_ref()
                .filter(|owner| owner.generation == self.generation)
                .map(|owner| (owner.closing, owner.sequence, owner.error.clone()))
                .unwrap_or((true, 0, None))
        };
        if force && !closing {
            return Err(failure("Begin preview close before forcing producer exit"));
        }
        let pending = platform::pending(self.generation, force);
        if pending < 0 {
            return Err(failure(
                "Native preview report requires the Electron main thread",
            ));
        }
        Ok(json!({"resourceId": self.resource_id, "generation": self.generation, "closing": closing,
            "complete": closing && pending == 0, "pending": pending, "lastSequence": sequence,
            "error": error, "native": platform::inspect(self.generation),
            "limits": {"events": MAX_EVENTS, "eventBytes": MAX_EVENT_BYTES, "queueBytes": MAX_QUEUE_BYTES}}).to_string())
    }
}

impl Drop for NativePip {
    fn drop(&mut self) {
        let _ = self.begin_close();
    }
}
