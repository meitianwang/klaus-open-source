use super::qoder::decrypt_safe_storage;
use super::{Keychain, Platform, MAX_RECORD_BYTES};
use serde_json::{json, Map, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

const UNREADABLE: &str = "qwenwork_local_secret_unreadable";

struct Candidate {
    path: PathBuf,
    service: &'static str,
    account: &'static str,
}

pub(super) fn read(home: &Path, platform: Platform, keychain: &dyn Keychain) -> Value {
    // The retired QoderWork store is never a QwenWork fallback location.
    let candidates = [Candidate {
        path: home.join("Library/Application Support/QwenWorkCN/auth-v2.dat"),
        service: "QwenWorkCN Safe Storage",
        account: "QwenWorkCN Key",
    }];
    let candidate = match candidates
        .into_iter()
        .find(|candidate| candidate.path.exists())
    {
        Some(candidate) => candidate,
        None => return json!({"present": false}),
    };
    let load = || -> Result<Value, &'static str> {
        if platform != Platform::MacOs {
            return Err("qwenwork_local_platform_unsupported");
        }
        let blob = read_bounded(&candidate.path)?;
        let bytes = keychain
            .read(candidate.service, Some(candidate.account))
            .map_err(|_| "qwenwork_local_keychain_denied")?
            .ok_or("qwenwork_local_keychain_denied")?;
        let secret = std::str::from_utf8(&bytes)
            .map_err(|_| "qwenwork_local_keychain_denied")?
            .trim();
        if secret.is_empty() {
            return Err("qwenwork_local_keychain_denied");
        }
        let plain = decrypt_safe_storage(&blob, secret).map_err(|_| UNREADABLE)?;
        let stored: Value = serde_json::from_slice(&plain).map_err(|_| UNREADABLE)?;
        to_klaus_credential(home, &stored)
    };
    match load() {
        Ok(credential) => json!({
            "present": true,
            "userInfo": credential["userInfo"].clone(),
            "machineId": credential["machineId"].clone(),
        }),
        Err(error) => json!({"present": true, "error": error}),
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, &'static str> {
    let file = std::fs::File::open(path).map_err(|_| "qwenwork_local_state_unreadable")?;
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "qwenwork_local_state_unreadable")?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(UNREADABLE);
    }
    Ok(bytes)
}

fn text(source: &Value, key: &str) -> Option<String> {
    match source.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn timestamp(source: &Value, key: &str) -> Option<i64> {
    match source.get(key) {
        Some(Value::String(value)) => chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|value| value.timestamp())
            .or_else(|| value.trim().parse::<i64>().ok().map(normalize_epoch)),
        Some(Value::Number(value)) => value.as_i64().map(normalize_epoch),
        _ => None,
    }
}

fn normalize_epoch(value: i64) -> i64 {
    if value > 100_000_000_000 {
        value / 1000
    } else {
        value
    }
}

fn valid_machine_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn machine_id(home: &Path, stored: &Value) -> Option<String> {
    text(stored, "loginDeviceId")
        .filter(|value| valid_machine_id(value))
        .or_else(|| {
            std::fs::read_to_string(home.join(".qwenworkcn/machine-id"))
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| valid_machine_id(value))
        })
}

fn copy_text(source: &Value, target: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(value) = text(source, from) {
        target.insert(to.into(), json!(value));
    }
}

fn to_klaus_credential(home: &Path, stored: &Value) -> Result<Value, &'static str> {
    if stored.get("schemaVersion").and_then(Value::as_i64) != Some(2) {
        return Err(UNREADABLE);
    }
    let token = text(stored, "token").ok_or("qwenwork_local_not_signed_in")?;
    let user = stored
        .get("user")
        .filter(|value| value.is_object())
        .ok_or(UNREADABLE)?;
    let uid = text(user, "id").ok_or(UNREADABLE)?;
    let machine_id = machine_id(home, stored).ok_or("qwenwork_local_machine_id_missing")?;
    let mut out = Map::new();
    out.insert("uid".into(), json!(uid));
    out.insert("security_oauth_token".into(), json!(token.clone()));
    out.insert("access_token".into(), json!(token));
    if let Some(refresh) = text(stored, "refreshToken") {
        out.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(value) = timestamp(stored, "expiresAt") {
        out.insert("expire_time".into(), json!(value));
    }
    if let Some(value) = timestamp(stored, "refreshTokenExpiresAt") {
        out.insert("refresh_token_expire_time".into(), json!(value));
    }
    for (from, to) in [
        ("name", "name"),
        ("email", "email"),
        ("imageUrl", "avatar_url"),
        ("orgId", "organization_id"),
        ("orgName", "organization_name"),
        ("orgType", "org_type"),
        ("teamId", "team_id"),
        ("planName", "plan_name"),
        ("planId", "plan_id"),
    ] {
        copy_text(user, &mut out, from, to);
    }
    if let Some(value) = user.get("isBiz").and_then(Value::as_bool) {
        out.insert("is_biz".into(), json!(value));
    }
    if let Some(tags) = user.get("orgTags").and_then(Value::as_array) {
        out.insert(
            "organization_tags".into(),
            Value::Array(
                tags.iter()
                    .filter_map(Value::as_str)
                    .map(|value| json!(value))
                    .collect(),
            ),
        );
    } else {
        out.insert("organization_tags".into(), json!([]));
    }
    let detail = user.get("detail").unwrap_or(&Value::Null);
    if let Some(value) = user
        .get("dataPolicyAgreed")
        .or_else(|| user.get("privacyPolicyAgreed"))
        .or_else(|| detail.get("dataPolicyAgreed"))
        .or_else(|| detail.get("privacyPolicyAgreed"))
        .and_then(Value::as_bool)
    {
        out.insert("data_policy_agreed".into(), json!(value));
    }
    copy_text(stored, &mut out, "loginMethod", "login_method");
    copy_text(stored, &mut out, "refreshStrategy", "refresh_strategy");
    copy_text(stored, &mut out, "oauthClientId", "oauth_client_id");
    copy_text(stored, &mut out, "oauthRedirectUri", "oauth_redirect_uri");
    copy_text(stored, &mut out, "openApiBase", "open_api_base");
    if let Some(value) = timestamp(stored, "loginTimestamp") {
        out.insert("login_timestamp".into(), json!(value));
    }
    Ok(json!({"machineId": machine_id, "userInfo": Value::Object(out)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::FixtureKeychain;

    #[test]
    fn imports_schema_two_without_changing_the_official_store() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path();
        let path = home.join("Library/Application Support/QwenWorkCN/auth-v2.dat");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let secret = "fixture-safe-storage-key";
        let stored = json!({
            "schemaVersion": 2,
            "token": "fake-qwenwork-token",
            "refreshToken": "fake-refresh",
            "expiresAt": "2027-01-15T08:00:00Z",
            "refreshTokenExpiresAt": "2027-02-15T08:00:00Z",
            "user": {
                "id": "fixture-user",
                "name": "Fixture User",
                "orgId": "fixture-org",
                "orgTags": ["enterprise"],
                "isBiz": true
            },
            "loginMethod": "device",
            "refreshStrategy": "device",
            "loginDeviceId": "01234567-89ab-cdef-0123-456789abcdef"
        });
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(secret.as_bytes(), b"saltysalt", 1003, &mut key)
            .unwrap();
        let mut blob = b"v10".to_vec();
        blob.extend(
            cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
                .encrypt_padded_vec_mut::<Pkcs7>(stored.to_string().as_bytes()),
        );
        std::fs::write(&path, &blob).unwrap();
        let before = std::fs::read(&path).unwrap();
        let keychain = FixtureKeychain::default();
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../contracts/vectors/qwenwork-login-vectors.json"
        ))
        .unwrap();
        let local_import = &vectors["localImport"];
        keychain
            .write(
                local_import["keychainService"].as_str().unwrap(),
                local_import["keychainAccount"].as_str().unwrap(),
                secret.as_bytes(),
            )
            .unwrap();

        let result = read(home, Platform::MacOs, &keychain);
        assert_eq!(result["present"], true);
        assert_eq!(result["machineId"], "01234567-89ab-cdef-0123-456789abcdef");
        assert_eq!(result["userInfo"]["uid"], "fixture-user");
        assert_eq!(
            result["userInfo"]["security_oauth_token"],
            "fake-qwenwork-token"
        );
        assert_eq!(
            result["userInfo"]["organization_tags"],
            json!(["enterprise"])
        );
        assert_eq!(result["userInfo"]["refresh_strategy"], "device");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn falls_back_to_the_qwenworkcn_machine_id_file_and_rejects_non_macos() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path();
        std::fs::create_dir_all(home.join(".qwenworkcn")).unwrap();
        std::fs::write(
            home.join(".qwenworkcn/machine-id"),
            "01234567-89ab-cdef-0123-456789abcdef\n",
        )
        .unwrap();
        let stored = json!({
            "schemaVersion": 2,
            "token": "fake-token",
            "refreshToken": "fake-refresh",
            "expiresAt": "2027-01-15T08:00:00Z",
            "user": {"id": "fixture-user"}
        });
        let credential = to_klaus_credential(home, &stored).unwrap();
        assert_eq!(
            credential["machineId"],
            "01234567-89ab-cdef-0123-456789abcdef"
        );

        let path = home.join("Library/Application Support/QwenWorkCN/auth-v2.dat");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"v10fixture").unwrap();
        assert_eq!(
            read(home, Platform::Linux, &FixtureKeychain::default())["error"],
            "qwenwork_local_platform_unsupported"
        );
    }

    #[test]
    fn does_not_read_the_independent_qoderwork_store() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path();
        let path = home.join("Library/Application Support/QoderWork/auth-v2.dat");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"v10fixture").unwrap();
        let keychain = FixtureKeychain::default();
        keychain
            .write(
                "QoderWork Safe Storage",
                "QoderWork Key",
                b"fixture-safe-storage-key",
            )
            .unwrap();

        assert_eq!(
            read(home, Platform::MacOs, &keychain),
            json!({"present": false})
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"v10fixture");
    }
}
