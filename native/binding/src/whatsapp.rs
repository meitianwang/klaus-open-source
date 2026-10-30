use crate::failure;
use klaus_native_core::whatsapp::{Action, Options, WhatsAppService};
use napi::bindgen_prelude::PromiseRaw;
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

fn options(raw: &str) -> Result<Options> {
    if raw.len() > 8192 {
        return Err(Error::new(Status::InvalidArg, "WHATSAPP_INVALID_OPTIONS"));
    }
    serde_json::from_str(raw)
        .map_err(|_| Error::new(Status::InvalidArg, "WHATSAPP_INVALID_OPTIONS"))
}
#[napi]
pub struct NativeWhatsApp {
    service: WhatsAppService,
}
#[napi]
impl NativeWhatsApp {
    #[napi(constructor)]
    pub fn new(resource_id: String, options_json: String) -> Result<Self> {
        Ok(Self {
            service: WhatsAppService::new(resource_id, options(&options_json)?).map_err(failure)?,
        })
    }
    #[napi]
    pub fn open<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::Open, deadline_ms)
    }
    #[napi]
    pub fn send_text<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        jid: String,
        text: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(
            env,
            operation_id,
            Action::SendText { jid, text },
            deadline_ms,
        )
    }
    #[napi]
    pub fn cancel(&self, operation_id: String) -> bool {
        self.service.cancel(&operation_id)
    }
    #[napi]
    pub fn read_event<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, Option<String>>> {
        let future = self.service.read_event().map_err(failure)?;
        env.spawn_future(async move {
            future
                .await
                .map(|event| event.map(|value| value.to_string()))
                .map_err(failure)
        })
    }
    #[napi]
    pub fn report(&self) -> String {
        self.service.report().to_string()
    }
    #[napi]
    pub fn shutdown<'env>(
        &self,
        env: &'env Env,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        let future = self.service.shutdown(deadline_ms).map_err(failure)?;
        env.spawn_future(async move { Ok(future.await.to_string()) })
    }
}
impl NativeWhatsApp {
    fn submit<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        action: Action,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        let ticket = self
            .service
            .prepare(operation_id, action, deadline_ms)
            .map_err(failure)?;
        env.spawn_future(async move {
            ticket
                .wait()
                .await
                .map(|value| value.to_string())
                .map_err(failure)
        })
    }
}
#[cfg(feature = "whatsapp-fixtures")]
#[napi]
pub fn create_whats_app_fixture(
    resource_id: String,
    options_json: String,
    base: String,
) -> Result<NativeWhatsApp> {
    Ok(NativeWhatsApp {
        service: WhatsAppService::fixture(resource_id, options(&options_json)?, &base)
            .map_err(failure)?,
    })
}
