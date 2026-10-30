use super::{error, CredentialStore, Platform, MAX_RECORD_BYTES, TRANSACTION};
use crate::Result;
use serde_json::{json, Value};

/// Only the three host-owned OAuth records may use the product keychain service.
pub struct McpKey(String);

impl McpKey {
    pub fn new(server_key: &str, part: &str) -> Result<Self> {
        let valid_suffix = server_key.rsplit_once('|').is_some_and(|(name, hash)| {
            !name.is_empty()
                && hash.len() == 16
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        if server_key.len() > 1024
            || server_key.chars().any(char::is_control)
            || !valid_suffix
            || !matches!(part, "discovery" | "client" | "tokens")
        {
            return Err(error("invalid_mcp_credential_key"));
        }
        Ok(Self(format!("mcp:oauth:{server_key}:{part}")))
    }
}

impl CredentialStore {
    pub fn read_mcp_oauth_record(&self, key: &McpKey) -> Value {
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        let result = (|| {
            if self.config.platform != Platform::MacOs {
                return Err(error("mcp_secure_storage_platform_unsupported"));
            }
            let Some(bytes) = self
                .keychain
                .read(&self.config.keychain_service, Some(&key.0))?
            else {
                return Ok(None);
            };
            if bytes.len() > MAX_RECORD_BYTES / 2 {
                return Err(error("mcp_credential_record_too_large"));
            }
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| error("mcp_credential_record_unreadable"))?;
            if !value.is_object() {
                return Err(error("mcp_credential_record_unreadable"));
            }
            Ok(Some(value))
        })();
        match result {
            Ok(value) => json!({"value": value}),
            Err(cause) => json!({"value": null, "error": cause.code}),
        }
    }

    pub fn write_mcp_oauth_record(&self, key: &McpKey, value: Value) -> Value {
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        let result = (|| {
            if self.config.platform != Platform::MacOs {
                return Err(error("mcp_secure_storage_platform_unsupported"));
            }
            let bytes = serde_json::to_vec(&value).map_err(|_| error("invalid_mcp_credential"))?;
            if !value.is_object() || bytes.len() > MAX_RECORD_BYTES / 2 {
                return Err(error("invalid_mcp_credential"));
            }
            self.keychain
                .write(&self.config.keychain_service, &key.0, &bytes)
        })();
        match result {
            Ok(()) => json!({"success": true}),
            Err(cause) => json!({"success": false, "error": cause.code}),
        }
    }

    pub fn remove_mcp_oauth_record(&self, key: &McpKey) -> bool {
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        self.config.platform == Platform::MacOs
            && self
                .keychain
                .delete(&self.config.keychain_service, &key.0)
                .is_ok()
    }
}
