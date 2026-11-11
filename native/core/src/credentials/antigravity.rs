use super::Keychain;
use serde_json::{json, Value};

/// Recent builds keep the OAuth token in a login-keychain generic password under
/// this service/account pair instead of the standalone file older builds wrote.
pub(super) const KEYCHAIN_SERVICE: &str = "gemini";
pub(super) const KEYCHAIN_ACCOUNT: &str = "antigravity";

/// Return the raw secret so the host can unwrap its envelope and validate the
/// token schema; the native layer deliberately does not parse provider documents.
pub(super) fn read_secret(keychain: &dyn Keychain) -> Value {
    match keychain.read(KEYCHAIN_SERVICE, Some(KEYCHAIN_ACCOUNT)) {
        Ok(None) => json!({"present": false}),
        Ok(Some(bytes)) => match String::from_utf8(bytes) {
            Ok(text) if !text.trim().is_empty() => json!({"present": true, "raw": text}),
            _ => json!({"present": true, "error": "antigravity_local_unreadable"}),
        },
        Err(_) => json!({"present": true, "error": "antigravity_local_keychain_denied"}),
    }
}
