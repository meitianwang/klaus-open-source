use napi_derive::napi;

/// Current mouse button state only; no keyboard input or screen content is captured.
#[napi]
pub fn pointer_buttons() -> napi::Result<u32> {
    platform_buttons()
}

#[cfg(target_os = "macos")]
fn platform_buttons() -> napi::Result<u32> {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    let mut buttons = 0;
    for button in 0..3 {
        // Combined session state includes physical input across foreground apps.
        if unsafe { CGEventSourceButtonState(0, button) } {
            buttons |= 1 << button;
        }
    }
    Ok(buttons)
}

#[cfg(target_os = "windows")]
fn platform_buttons() -> napi::Result<u32> {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(virtual_key: i32) -> i16;
    }
    let mut buttons = 0;
    for (index, key) in [0x01, 0x02, 0x04].into_iter().enumerate() {
        if unsafe { GetAsyncKeyState(key) } < 0 {
            buttons |= 1 << index;
        }
    }
    Ok(buttons)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_buttons() -> napi::Result<u32> {
    Err(napi::Error::from_reason(
        "Global pointer state is unavailable on this platform",
    ))
}
