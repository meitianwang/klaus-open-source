use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Result, Task};
use napi_derive::napi;

/// Maps a raw native authorization status to the three-state contract string.
#[cfg(target_os = "macos")]
type StatusMapper = fn(i32) -> &'static str;

pub struct PermissionStatusTask {
    #[cfg(target_os = "macos")]
    symbol: &'static str,
    #[cfg(target_os = "macos")]
    map: StatusMapper,
}

impl Task for PermissionStatusTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            extern "C" {
                fn klaus_automation_permission_status() -> i32;
                fn klaus_photos_permission_status() -> i32;
                fn klaus_location_permission_status() -> i32;
                fn klaus_notification_permission_status() -> i32;
            }
            let raw = unsafe {
                match self.symbol {
                    "automation" => klaus_automation_permission_status(),
                    "photos" => klaus_photos_permission_status(),
                    "location" => klaus_location_permission_status(),
                    _ => klaus_notification_permission_status(),
                }
            };
            Ok((self.map)(raw).into())
        }
        #[cfg(not(target_os = "macos"))]
        {
            // The exported surface is stable, but none of these TCC domains exist here.
            Ok("unknown".into())
        }
    }

    fn resolve(&mut self, _env: Env, status: String) -> Result<Self::JsValue> {
        Ok(status)
    }
}

pub struct PermissionRequestTask {
    #[cfg(target_os = "macos")]
    symbol: &'static str,
    #[cfg(target_os = "macos")]
    map: StatusMapper,
}

impl Task for PermissionRequestTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            extern "C" {
                fn klaus_automation_request_consent() -> i32;
                fn klaus_photos_request_authorization() -> i32;
                fn klaus_notification_request_authorization() -> i32;
            }
            let raw = unsafe {
                match self.symbol {
                    "automation" => klaus_automation_request_consent(),
                    "photos" => klaus_photos_request_authorization(),
                    _ => klaus_notification_request_authorization(),
                }
            };
            Ok((self.map)(raw).into())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok("unknown".into())
        }
    }

    fn resolve(&mut self, _env: Env, status: String) -> Result<Self::JsValue> {
        Ok(status)
    }
}

/// Fixed System Events target; callers cannot choose another application.
#[napi]
pub fn automation_permission_status() -> AsyncTask<PermissionStatusTask> {
    AsyncTask::new(PermissionStatusTask {
        #[cfg(target_os = "macos")]
        symbol: "automation",
        #[cfg(target_os = "macos")]
        map: klaus_native_core::permissions::automation_status_from_os_status,
    })
}

#[napi]
pub fn photos_permission_status() -> AsyncTask<PermissionStatusTask> {
    AsyncTask::new(PermissionStatusTask {
        #[cfg(target_os = "macos")]
        symbol: "photos",
        #[cfg(target_os = "macos")]
        map: klaus_native_core::permissions::photos_status_from_authorization,
    })
}

#[napi]
pub fn location_permission_status() -> AsyncTask<PermissionStatusTask> {
    AsyncTask::new(PermissionStatusTask {
        #[cfg(target_os = "macos")]
        symbol: "location",
        #[cfg(target_os = "macos")]
        map: klaus_native_core::permissions::location_status_from_authorization,
    })
}

#[napi]
pub fn notification_permission_status() -> AsyncTask<PermissionStatusTask> {
    AsyncTask::new(PermissionStatusTask {
        #[cfg(target_os = "macos")]
        symbol: "notification",
        #[cfg(target_os = "macos")]
        map: klaus_native_core::permissions::notification_status_from_authorization,
    })
}

/// Presents the system consent dialog for the given domain ("automation", "photos",
/// "notification") and resolves with the recorded status once the user answered.
#[napi]
pub fn request_permission(domain: String) -> AsyncTask<PermissionRequestTask> {
    AsyncTask::new(permission_request_task(domain))
}

#[cfg(target_os = "macos")]
fn permission_request_task(domain: String) -> PermissionRequestTask {
    let (symbol, map): (&'static str, StatusMapper) = match domain.as_str() {
        "automation" => (
            "automation",
            klaus_native_core::permissions::automation_status_from_os_status,
        ),
        "photos" => (
            "photos",
            klaus_native_core::permissions::photos_status_from_authorization,
        ),
        _ => (
            "notification",
            klaus_native_core::permissions::notification_status_from_authorization,
        ),
    };
    PermissionRequestTask { symbol, map }
}

#[cfg(not(target_os = "macos"))]
fn permission_request_task(_: String) -> PermissionRequestTask {
    // These consent domains are macOS-only; requests elsewhere resolve to unknown.
    PermissionRequestTask {}
}

#[napi(object)]
pub struct PermissionGuideOptions {
    pub pane_title: String,
    pub instruction_prefix: Option<String>,
    pub instruction_middle: Option<String>,
    pub instruction_suffix: Option<String>,
    pub drag_label: Option<String>,
    pub reopen_url: Option<String>,
    pub app_path: Option<String>,
    pub source_x: Option<f64>,
    pub source_y: Option<f64>,
    pub source_w: Option<f64>,
    pub source_h: Option<f64>,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct KlausPermissionGuideConfig {
    pane_title: *const std::ffi::c_char,
    instruction_prefix: *const std::ffi::c_char,
    instruction_middle: *const std::ffi::c_char,
    instruction_suffix: *const std::ffi::c_char,
    drag_label: *const std::ffi::c_char,
    reopen_url: *const std::ffi::c_char,
    app_path: *const std::ffi::c_char,
    source_x: f64,
    source_y: f64,
    source_w: f64,
    source_h: f64,
    has_source_rect: bool,
}

#[cfg(target_os = "macos")]
fn to_optional_c_string(value: Option<String>) -> Option<std::ffi::CString> {
    value.and_then(|item| std::ffi::CString::new(item).ok())
}

#[cfg(target_os = "macos")]
fn c_ptr(value: &Option<std::ffi::CString>) -> *const std::ffi::c_char {
    value
        .as_ref()
        .map_or(std::ptr::null(), |item| item.as_ptr())
}

/// Shows a floating drag-and-drop guidance panel anchored beneath macOS System Settings.
#[napi]
pub fn show_permission_guide(options: PermissionGuideOptions) -> bool {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn klaus_permission_guide_show(config: *const KlausPermissionGuideConfig) -> bool;
        }
        let pane_title = to_optional_c_string(Some(options.pane_title));
        let prefix = to_optional_c_string(options.instruction_prefix);
        let middle = to_optional_c_string(options.instruction_middle);
        let suffix = to_optional_c_string(options.instruction_suffix);
        let drag_label = to_optional_c_string(options.drag_label);
        let reopen_url = to_optional_c_string(options.reopen_url);
        let app_path = to_optional_c_string(options.app_path);
        let has_source_rect = options.source_x.is_some()
            && options.source_y.is_some()
            && options.source_w.is_some()
            && options.source_h.is_some();
        let config = KlausPermissionGuideConfig {
            pane_title: c_ptr(&pane_title),
            instruction_prefix: c_ptr(&prefix),
            instruction_middle: c_ptr(&middle),
            instruction_suffix: c_ptr(&suffix),
            drag_label: c_ptr(&drag_label),
            reopen_url: c_ptr(&reopen_url),
            app_path: c_ptr(&app_path),
            source_x: options.source_x.unwrap_or(0.0),
            source_y: options.source_y.unwrap_or(0.0),
            source_w: options.source_w.unwrap_or(0.0),
            source_h: options.source_h.unwrap_or(0.0),
            has_source_rect,
        };
        unsafe { klaus_permission_guide_show(&config) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = options;
        false
    }
}

/// Dismisses the floating permission guidance panel if it is open.
#[napi]
pub fn close_permission_guide(restore_previous_app: Option<bool>) {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn klaus_permission_guide_close(restore_previous_app: bool);
        }
        unsafe {
            klaus_permission_guide_close(restore_previous_app.unwrap_or(false));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = restore_previous_app;
    }
}

/// Reports whether the floating permission guidance panel is currently visible.
#[napi]
pub fn permission_guide_visible() -> bool {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn klaus_permission_guide_is_visible() -> bool;
        }
        unsafe { klaus_permission_guide_is_visible() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
