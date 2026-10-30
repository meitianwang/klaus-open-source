use crate::failure;
use klaus_native_core::instance::{InstanceGuard, Options};
use napi::bindgen_prelude::PromiseRaw;
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

#[napi]
pub struct NativeInstanceGuard {
    guard: InstanceGuard,
}

#[napi]
impl NativeInstanceGuard {
    /// Construction intentionally completes before returning to the JS event loop.
    #[napi(constructor)]
    pub fn new(options_json: String) -> Result<Self> {
        if options_json.len() > 64 * 1024 {
            return Err(Error::new(Status::InvalidArg, "INSTANCE_INVALID_OPTIONS"));
        }
        let options: Options = serde_json::from_str(&options_json)
            .map_err(|_| Error::new(Status::InvalidArg, "INSTANCE_INVALID_OPTIONS"))?;
        Ok(Self {
            guard: InstanceGuard::acquire_sync(options).map_err(failure)?,
        })
    }
    #[napi]
    pub fn acquisition(&self) -> String {
        serde_json::to_string(self.guard.acquisition()).unwrap()
    }
    #[napi]
    pub fn assert_held(&self) -> Result<()> {
        self.guard.assert_held().map_err(failure)
    }
    #[napi]
    pub fn report(&self) -> String {
        serde_json::to_string(&self.guard.report()).unwrap()
    }
    #[napi]
    pub fn read_event<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, Option<String>>> {
        let future = self.guard.read_event().map_err(failure)?;
        env.spawn_future(async move {
            Ok(future
                .await
                .map(|event| serde_json::to_string(&event).unwrap()))
        })
    }
    /// Bounded native close also works before app.ready or during a startup error.
    #[napi]
    pub fn close_sync(&self, timeout_ms: u32) -> Result<String> {
        self.guard
            .close_sync(timeout_ms)
            .map(|report| serde_json::to_string(&report).unwrap())
            .map_err(failure)
    }
}
