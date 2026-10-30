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
