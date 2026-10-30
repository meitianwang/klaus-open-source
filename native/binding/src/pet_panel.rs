use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[cfg(target_os = "macos")]
fn view(handle: &Buffer) -> napi::Result<*mut std::ffi::c_void> {
    let bytes: [u8; std::mem::size_of::<usize>()] = handle
        .as_ref()
        .try_into()
        .map_err(|_| napi::Error::from_reason("Invalid native pet window handle"))?;
    let pointer = usize::from_ne_bytes(bytes) as *mut std::ffi::c_void;
    if pointer.is_null() {
        return Err(napi::Error::from_reason("Pet window handle is null"));
    }
    Ok(pointer)
}

/// Configure a host-owned panel; never accepts a renderer-provided handle.
#[napi]
pub fn configure_pet_panel(handle: Buffer) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_panel_configure(view: *mut std::ffi::c_void) -> bool;
        }
        Ok(unsafe { klaus_pet_panel_configure(view(&handle)?) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = handle;
        Ok(false)
    }
}

/// Give the nonactivating panel keyboard focus without activating the main window.
#[napi]
pub fn focus_pet_panel(handle: Buffer, active: bool) -> napi::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_panel_focus(view: *mut std::ffi::c_void, active: bool) -> bool;
        }
        Ok(unsafe { klaus_pet_panel_focus(view(&handle)?, active) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, active);
        Ok(false)
    }
}

/// Capture a transient process identity for restoring the app active before panel input.
#[napi]
pub fn capture_active_application() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_capture_active_application() -> i32;
        }
        let pid = unsafe { klaus_pet_capture_active_application() };
        (pid > 0).then(|| pid.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}
#[napi]
pub fn restore_active_application(token: String) -> napi::Result<bool> {
    let pid = token
        .parse::<i32>()
        .map_err(|_| napi::Error::from_reason("Invalid foreground application identity"))?;
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_restore_active_application(pid: i32) -> bool;
        }
        Ok(unsafe { klaus_pet_restore_active_application(pid) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        Ok(false)
    }
}

#[cfg(target_os = "macos")]
type OutsideCallback =
    napi::threadsafe_function::ThreadsafeFunction<(), (), (), napi::Status, false, true>;
#[cfg(target_os = "macos")]
type OutsideWindowCallback = napi::threadsafe_function::ThreadsafeFunction<i32, (), i32, napi::Status, false, true>;
#[cfg(target_os = "macos")]
static OUTSIDE_CALLBACKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, Box<OutsideWindowCallback>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
#[cfg(target_os = "macos")]
extern "C" fn outside_click(context: *mut std::ffi::c_void) {
    if context.is_null() {
        return;
    }
    let callback = unsafe { &*(context as *const OutsideCallback) };
    let _ = callback.call(
        (),
        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
}

#[cfg(target_os = "macos")]
extern "C" fn outside_window_click(context: *mut std::ffi::c_void, window_number: i32) {
    if context.is_null() { return; }
    let callback = unsafe { &*(context as *const OutsideWindowCallback) };
    let _ = callback.call(window_number, napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking);
}

/// Identify only a host-owned native window, for filtering local transient events.
#[napi]
pub fn pet_window_number(handle: Buffer) -> napi::Result<i32> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn klaus_pet_window_number(view: *mut std::ffi::c_void) -> i32; }
        Ok(unsafe { klaus_pet_window_number(view(&handle)?) })
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = handle; Ok(0) }
}

/// Event monitors preserve short clicks and ignore owned sheets and child windows.
#[napi]
pub fn observe_pet_outside_clicks(
    handle: Buffer,
    callback: napi::bindgen_prelude::Function<'_, i32, ()>,
) -> napi::Result<u32> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_observe_outside_clicks(
                view: *mut std::ffi::c_void,
                callback: extern "C" fn(*mut std::ffi::c_void, i32),
                context: *mut std::ffi::c_void,
            ) -> u32;
        }
        let callback = Box::new(
            callback
                .build_threadsafe_function::<i32>()
                .weak::<true>()
                .build()?,
        );
        let context = (&*callback as *const OutsideWindowCallback).cast_mut().cast();
        let token =
            unsafe { klaus_pet_observe_outside_clicks(view(&handle)?, outside_window_click, context) };
        if token == 0 {
            return Err(napi::Error::from_reason(
                "Outside mouse observation is unavailable",
            ));
        }
        OUTSIDE_CALLBACKS
            .lock()
            .map_err(|_| napi::Error::from_reason("Outside mouse observer state is unavailable"))?
            .insert(token, callback);
        Ok(token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, callback);
        Err(napi::Error::from_reason(
            "Native outside mouse observation is unavailable",
        ))
    }
}
#[napi]
pub fn stop_pet_outside_clicks(token: u32) -> napi::Result<()> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_stop_outside_clicks(token: u32);
        }
        unsafe { klaus_pet_stop_outside_clicks(token) };
        OUTSIDE_CALLBACKS
            .lock()
            .map_err(|_| napi::Error::from_reason("Outside mouse observer state is unavailable"))?
            .remove(&token);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = token;
    }
    Ok(())
}

#[napi(object)]
pub struct PetWindowDragEvent {
    pub window_x: f64,
    pub window_y: f64,
    pub ended: bool,
    pub alt_key: bool,
}
#[cfg(target_os = "macos")]
type DragCallback = napi::threadsafe_function::ThreadsafeFunction<
    PetWindowDragEvent,
    (),
    PetWindowDragEvent,
    napi::Status,
    false,
    true,
>;
#[cfg(target_os = "macos")]
static DRAG_CALLBACKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, Box<DragCallback>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
#[cfg(target_os = "macos")]
extern "C" fn window_drag(
    context: *mut std::ffi::c_void,
    window_x: f64,
    window_y: f64,
    ended: bool,
    alt_key: bool,
) {
    if context.is_null() {
        return;
    }
    let callback = unsafe { &*(context as *const DragCallback) };
    let _ = callback.call(
        PetWindowDragEvent {
            window_x,
            window_y,
            ended,
            alt_key,
        },
        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
    );
}
#[napi(object)]
pub struct PetWindowOriginBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }
/// Hand movement to AppKit events while the renderer retains the drag identity.
#[napi]
pub fn begin_pet_window_drag(
    handle: Buffer,
    pointer_x: f64,
    pointer_y: f64,
    callback: napi::bindgen_prelude::Function<'_, PetWindowDragEvent, ()>,
    origin_bounds: Option<PetWindowOriginBounds>,
) -> napi::Result<u32> {
    if !pointer_x.is_finite() || !pointer_y.is_finite() {
        return Err(napi::Error::from_reason("Invalid drag pointer"));
    }
    if let Some(bounds) = &origin_bounds {
        if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|value| value.is_finite()) || bounds.width < 0.0 || bounds.height < 0.0 { return Err(napi::Error::from_reason("Invalid drag origin bounds")); }
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_begin_window_drag(
                view: *mut std::ffi::c_void,
                pointer_x: f64,
                pointer_y: f64,
                has_origin_bounds: bool, x: f64, y: f64, width: f64, height: f64,
                callback: extern "C" fn(*mut std::ffi::c_void, f64, f64, bool, bool),
                context: *mut std::ffi::c_void,
            ) -> u32;
        }
        let callback = Box::new(
            callback
                .build_threadsafe_function::<PetWindowDragEvent>()
                .weak::<true>()
                .build()?,
        );
        let context = (&*callback as *const DragCallback).cast_mut().cast();
        let bounded = origin_bounds.is_some();
        let bounds = origin_bounds.unwrap_or(PetWindowOriginBounds { x: 0.0, y: 0.0, width: 0.0, height: 0.0 });
        let token = unsafe {
            klaus_pet_begin_window_drag(view(&handle)?, pointer_x, pointer_y, bounded, bounds.x, bounds.y, bounds.width, bounds.height, window_drag, context)
        };
        if token != 0 {
            DRAG_CALLBACKS
                .lock()
                .map_err(|_| napi::Error::from_reason("Native drag state is unavailable"))?
                .insert(token, callback);
        }
        Ok(token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, pointer_x, pointer_y, callback, origin_bounds);
        Ok(0)
    }
}
#[napi]
pub fn stop_pet_window_drag(token: u32) -> napi::Result<()> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_stop_window_drag(token: u32);
        }
        unsafe { klaus_pet_stop_window_drag(token) };
        DRAG_CALLBACKS
            .lock()
            .map_err(|_| napi::Error::from_reason("Native drag state is unavailable"))?
            .remove(&token);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = token;
    }
    Ok(())
}

/// Lifetime diagnostics only; no captured input or application content is returned.
#[napi]
pub fn pet_input_observer_count() -> u32 {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_pet_input_observer_count() -> u32;
        }
        unsafe { klaus_pet_input_observer_count() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

#[cfg(target_os = "macos")]
static APPSHOT_CALLBACKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<u32, Box<OutsideCallback>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Observe one bare left-and-right modifier chord without consuming keyboard input.
#[napi]
pub fn observe_appshot_shortcut(mode: String, callback: napi::bindgen_prelude::Function<'_, (), ()>) -> napi::Result<u32> {
    let modifier = match mode.as_str() {
        "DoubleCommand" => 0u32,
        "DoubleAlt" | "DoubleOption" => 1,
        "DoubleShift" => 2,
        _ => return Err(napi::Error::from_reason("Unsupported capture shortcut")),
    };
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn klaus_appshot_observe_shortcut(modifier: u32, callback: extern "C" fn(*mut std::ffi::c_void), context: *mut std::ffi::c_void) -> u32;
        }
        let callback = Box::new(callback.build_threadsafe_function::<()>().weak::<true>().build()?);
        let context = (&*callback as *const OutsideCallback).cast_mut().cast();
        let token = unsafe { klaus_appshot_observe_shortcut(modifier, outside_click, context) };
        if token == 0 { return Err(napi::Error::from_reason("Capture shortcut observation is unavailable")); }
        APPSHOT_CALLBACKS.lock().map_err(|_| napi::Error::from_reason("Capture shortcut state is unavailable"))?.insert(token, callback);
        Ok(token)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (modifier, callback);
        Err(napi::Error::from_reason("Native capture shortcut observation is unavailable"))
    }
}
#[napi]
pub fn stop_appshot_shortcut(token: u32) -> napi::Result<()> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn klaus_appshot_stop_shortcut(token: u32); }
        unsafe { klaus_appshot_stop_shortcut(token) };
        APPSHOT_CALLBACKS.lock().map_err(|_| napi::Error::from_reason("Capture shortcut state is unavailable"))?.remove(&token);
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = token; }
    Ok(())
}
