use crate::failure;
use klaus_native_core::ssh::{Action, SshService};
use napi::bindgen_prelude::PromiseRaw;
use napi::{Env, Error, Result, Status};
use napi_derive::napi;

#[napi]
pub struct NativeSsh {
    service: SshService,
}

#[napi]
impl NativeSsh {
    #[napi(constructor)]
    pub fn new(resource_id: String, options_json: String) -> Result<Self> {
        if options_json.len() > 16384 {
            return Err(Error::new(Status::InvalidArg, "SSH_INVALID_OPTIONS"));
        }
        let options = serde_json::from_str(&options_json)
            .map_err(|_| Error::new(Status::InvalidArg, "SSH_INVALID_OPTIONS"))?;
        Ok(Self {
            service: SshService::new(resource_id, options).map_err(failure)?,
        })
    }

    #[napi]
    pub fn list_hosts<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::ListHosts, deadline_ms)
    }
    #[napi]
    pub fn connect<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        target_json: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        if target_json.len() > 2048 {
            return Err(Error::new(Status::InvalidArg, "SSH_INVALID_TARGET"));
        }
        let target = serde_json::from_str(&target_json)
            .map_err(|_| Error::new(Status::InvalidArg, "SSH_INVALID_TARGET"))?;
        self.submit(env, operation_id, Action::Connect(target), deadline_ms)
    }
    #[napi]
    pub fn execute<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        command: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::Execute(command), deadline_ms)
    }
    #[napi]
    pub fn cancel(&self, operation_id: String) -> bool {
        self.service.cancel(&operation_id)
    }
    #[napi]
    pub fn answer(
        &self,
        operation_id: String,
        request_id: String,
        answer: Option<String>,
    ) -> Result<bool> {
        self.service
            .answer(&operation_id, &request_id, answer)
            .map_err(failure)
    }
    #[napi]
    pub fn read_event<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, Option<String>>> {
        let future = self.service.read_event().map_err(failure)?;
        env.spawn_future(async move {
            future
                .await
                .map(|event| {
                    event.map(|e| serde_json::to_string(&e).expect("serializable SSH event"))
                })
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
impl NativeSsh {
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
