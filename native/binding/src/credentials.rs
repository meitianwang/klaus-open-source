use crate::failure;
use klaus_native_core::credentials::{
    is_product_keychain_service, Action, CredentialService, CredentialStore, McpKey,
    WorkBuddyRegion, MAX_RECORD_BYTES,
};
use napi::bindgen_prelude::PromiseRaw;
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use std::path::PathBuf;

/// Namespaces addons have always listed; kept for hosts that only read this list.
#[napi(js_name = "credentialKeychainServices")]
pub fn credential_keychain_services() -> Vec<String> {
    vec!["agent-engine".into(), "agent-engine-international".into()]
}

/// Whether this addon isolates credentials under `service`. Hosts check this
/// before constructing a credential resource for a non-legacy edition.
#[napi(js_name = "credentialKeychainServiceAccepted")]
pub fn credential_keychain_service_accepted(service: String) -> bool {
    is_product_keychain_service(&service)
}

#[napi]
pub struct NativeCredentials {
    service: CredentialService,
}

#[napi]
impl NativeCredentials {
    #[napi(constructor)]
    pub fn new(
        resource_id: String,
        config_root: String,
        user_home: String,
        keychain_service: Option<String>,
    ) -> Result<Self> {
        let store = CredentialStore::system_with_keychain_service(
            PathBuf::from(config_root),
            PathBuf::from(user_home),
            keychain_service.unwrap_or_else(|| "agent-engine".into()),
        )
        .map_err(failure)?;
        Ok(Self {
            service: CredentialService::new(resource_id, store).map_err(failure)?,
        })
    }

    #[napi(js_name = "readClaudeOAuth")]
    pub fn read_claude_oauth<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::ReadClaudeOAuth, deadline_ms)
    }

    #[napi(js_name = "readClaudeAccounts")]
    pub fn read_claude_accounts<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::ReadClaudeAccounts, deadline_ms)
    }

    #[napi(js_name = "writeClaudeAccounts")]
    pub fn write_claude_accounts<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        accounts_json: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        if accounts_json.len() > MAX_RECORD_BYTES / 2 {
            return Err(Error::new(Status::InvalidArg, "invalid_claude_credential"));
        }
        let accounts = serde_json::from_str(&accounts_json)
            .map_err(|_| Error::new(Status::InvalidArg, "invalid_claude_credential"))?;
        self.submit(
            env,
            operation_id,
            Action::WriteClaudeAccounts(accounts),
            deadline_ms,
        )
    }

    #[napi(js_name = "writeClaudeOAuth")]
    pub fn write_claude_oauth<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        tokens_json: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        if tokens_json.len() > MAX_RECORD_BYTES / 2 {
            return Err(Error::new(Status::InvalidArg, "invalid_claude_credential"));
        }
        let tokens = serde_json::from_str(&tokens_json)
            .map_err(|_| Error::new(Status::InvalidArg, "invalid_claude_credential"))?;
        self.submit(
            env,
            operation_id,
            Action::WriteClaudeOAuth(tokens),
            deadline_ms,
        )
    }

    #[napi(js_name = "removeClaudeOAuth")]
    pub fn remove_claude_oauth<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::RemoveClaudeOAuth, deadline_ms)
    }

    #[napi]
    pub fn read_local_claude_credential<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(
            env,
            operation_id,
            Action::ReadLocalClaudeCredential,
            deadline_ms,
        )
    }

    #[napi]
    pub fn read_cursor_credential<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(env, operation_id, Action::ReadCursorCredential, deadline_ms)
    }

    #[napi]
    pub fn read_qoder_ide_credential<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(
            env,
            operation_id,
            Action::ReadQoderIdeCredential,
            deadline_ms,
        )
    }

    #[napi]
    pub fn read_antigravity_keychain_secret<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(
            env,
            operation_id,
            Action::ReadAntigravityKeychainSecret,
            deadline_ms,
        )
    }

    #[napi]
    pub fn read_qoderwork_credential<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(
            env,
            operation_id,
            Action::ReadQoderWorkCredential,
            deadline_ms,
        )
    }

    #[napi]
    pub fn read_qwenwork_credential<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        self.submit(
            env,
            operation_id,
            Action::ReadQwenWorkCredential,
            deadline_ms,
        )
    }

    #[napi]
    pub fn read_workbuddy_credential<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        deadline_ms: u32,
        region: Option<String>,
    ) -> Result<PromiseRaw<'env, String>> {
        let region = region
            .map(|value| {
                WorkBuddyRegion::parse(&value)
                    .ok_or_else(|| Error::new(Status::InvalidArg, "INVALID_WORKBUDDY_REGION"))
            })
            .transpose()?;
        self.submit(
            env,
            operation_id,
            Action::ReadWorkBuddyCredential(region),
            deadline_ms,
        )
    }

    #[napi(js_name = "readMcpOAuthRecord")]
    pub fn read_mcp_oauth_record<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        server_key: String,
        part: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        let key = McpKey::new(&server_key, &part).map_err(failure)?;
        self.submit(
            env,
            operation_id,
            Action::ReadMcpOAuthRecord(key),
            deadline_ms,
        )
    }

    #[napi(js_name = "writeMcpOAuthRecord")]
    pub fn write_mcp_oauth_record<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        server_key: String,
        part: String,
        value_json: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        let key = McpKey::new(&server_key, &part).map_err(failure)?;
        if value_json.len() > MAX_RECORD_BYTES / 2 {
            return Err(Error::new(Status::InvalidArg, "invalid_mcp_credential"));
        }
        let value: serde_json::Value = serde_json::from_str(&value_json)
            .map_err(|_| Error::new(Status::InvalidArg, "invalid_mcp_credential"))?;
        if !value.is_object() {
            return Err(Error::new(Status::InvalidArg, "invalid_mcp_credential"));
        }
        self.submit(
            env,
            operation_id,
            Action::WriteMcpOAuthRecord(key, value),
            deadline_ms,
        )
    }

    #[napi(js_name = "removeMcpOAuthRecord")]
    pub fn remove_mcp_oauth_record<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
        server_key: String,
        part: String,
        deadline_ms: u32,
    ) -> Result<PromiseRaw<'env, String>> {
        let key = McpKey::new(&server_key, &part).map_err(failure)?;
        self.submit(
            env,
            operation_id,
            Action::RemoveMcpOAuthRecord(key),
            deadline_ms,
        )
    }

    #[napi]
    pub fn cancel(&self, operation_id: String) -> bool {
        self.service.cancel(&operation_id)
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

impl NativeCredentials {
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
        env.spawn_future(async move { ticket.wait().await.map(|v| v.to_string()).map_err(failure) })
    }
}

/// Only the separately built fixture addon exports this factory; production has no backend switch.
#[cfg(feature = "credential-fixtures")]
#[napi]
pub fn create_credential_fixture(
    resource_id: String,
    config_json: String,
    entries_json: String,
    latency_ms: u32,
) -> Result<NativeCredentials> {
    use klaus_native_core::credentials::{CredentialConfig, FixtureKeychain, Keychain, Platform};
    use klaus_native_core::{NativeError, Result as CoreResult};
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::Duration;

    struct DelayedFixture {
        inner: FixtureKeychain,
        latency: Duration,
    }
    impl Keychain for DelayedFixture {
        fn read(&self, service: &str, account: Option<&str>) -> CoreResult<Option<Vec<u8>>> {
            std::thread::sleep(self.latency);
            self.inner.read(service, account)
        }
        fn write(&self, service: &str, account: &str, bytes: &[u8]) -> CoreResult<()> {
            std::thread::sleep(self.latency);
            self.inner.write(service, account, bytes)
        }
        fn delete(&self, service: &str, account: &str) -> CoreResult<()> {
            std::thread::sleep(self.latency);
            self.inner.delete(service, account)
        }
    }
    let invalid = || Error::new(Status::InvalidArg, "invalid_credential_fixture");
    if latency_ms > 1000 || config_json.len() > 16_384 || entries_json.len() > MAX_RECORD_BYTES * 2
    {
        return Err(invalid());
    }
    let input: Value = serde_json::from_str(&config_json).map_err(|_| invalid())?;
    let text = |key| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(invalid)
    };
    let platform = match text("platform")?.as_str() {
        "darwin" => Platform::MacOs,
        "linux" => Platform::Linux,
        "win32" => Platform::Windows,
        _ => return Err(invalid()),
    };
    let config = CredentialConfig {
        config_root: PathBuf::from(text("configRoot")?),
        user_home: PathBuf::from(text("userHome")?),
        platform,
        keychain_service: match input.get("keychainService") {
            None => "agent-engine".into(),
            Some(Value::String(value)) => value.clone(),
            _ => return Err(invalid()),
        },
        qoder_state_db: input
            .get("qoderStateDb")
            .and_then(Value::as_str)
            .map(PathBuf::from),
    };
    let entries: Value = serde_json::from_str(&entries_json).map_err(|_| invalid())?;
    let fixture = FixtureKeychain::default();
    for entry in entries.as_array().ok_or_else(invalid)? {
        let field = |key| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::new("INVALID_FIXTURE", "missing field"))
        };
        fixture
            .write(
                field("service").map_err(failure)?,
                field("account").map_err(failure)?,
                field("raw").map_err(failure)?.as_bytes(),
            )
            .map_err(failure)?;
    }
    let store = CredentialStore::new(
        config,
        Arc::new(DelayedFixture {
            inner: fixture,
            latency: Duration::from_millis(u64::from(latency_ms)),
        }),
    )
    .map_err(failure)?;
    Ok(NativeCredentials {
        service: CredentialService::new(resource_id, store).map_err(failure)?,
    })
}
