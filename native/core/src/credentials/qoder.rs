use super::{Keychain, Platform, MAX_RECORD_BYTES};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;

const USER_INFO_SECRET: &str = "secret://aicoding.auth.userInfo";
const UNREADABLE: &str = "qoder_ide_secret_unreadable";

pub(super) fn read(path: &Path, platform: Platform, keychain: &dyn Keychain) -> Value {
    match path.try_exists() {
        Ok(false) => return json!({"present": false}),
        Err(_) => return json!({"present": true, "error": "qoder_ide_state_unreadable"}),
        Ok(true) => {}
    }
    let load = || -> Result<Value, &'static str> {
        let blob = read_blob(path)?;
        if platform != Platform::MacOs {
            return Err("qoder_ide_platform_unsupported");
        }
        let bytes = keychain
            .read("Qoder Safe Storage", Some("Qoder Key"))
            .map_err(|_| "qoder_ide_keychain_denied")?
            .ok_or("qoder_ide_keychain_denied")?;
        let secret = std::str::from_utf8(&bytes)
            .map_err(|_| "qoder_ide_keychain_denied")?
            .trim();
        if secret.is_empty() {
            return Err("qoder_ide_keychain_denied");
        }
        let plain = decrypt_safe_storage(&blob, secret)?;
        let ide: Value = serde_json::from_slice(&plain).map_err(|_| UNREADABLE)?;
        to_klaus_profile(&ide)
    };
    match load() {
        Ok(profile) => json!({"present": true, "userInfo": profile}),
        Err(error) => json!({"present": true, "error": error}),
    }
}

fn read_blob(path: &Path) -> Result<Vec<u8>, &'static str> {
    use rusqlite::{Connection, OpenFlags, OptionalExtension};
    // Keep WAL visibility: a live IDE may have a committed row only in its WAL.
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "qoder_ide_state_unreadable")?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|_| "qoder_ide_state_unreadable")?;
    let raw: Option<Option<String>> = connection.query_row(
        "SELECT CASE WHEN length(value) <= ?2 THEN value ELSE NULL END FROM ItemTable WHERE key = ?1",
        rusqlite::params![USER_INFO_SECRET, (MAX_RECORD_BYTES * 4) as i64],
        |row| row.get(0),
    ).optional().map_err(|_| "qoder_ide_state_unreadable")?;
    match raw {
        None => Err("qoder_ide_not_signed_in"),
        Some(None) => Err(UNREADABLE),
        Some(Some(text)) => decode_buffer(&text),
    }
}

fn decode_buffer(text: &str) -> Result<Vec<u8>, &'static str> {
    if text.len() > MAX_RECORD_BYTES * 4 {
        return Err(UNREADABLE);
    }
    let parsed: Value = serde_json::from_str(text).map_err(|_| UNREADABLE)?;
    if parsed.get("type").and_then(Value::as_str) != Some("Buffer") {
        return Err(UNREADABLE);
    }
    let data = parsed
        .get("data")
        .and_then(Value::as_array)
        .ok_or(UNREADABLE)?;
    if data.is_empty() {
        return Err("qoder_ide_not_signed_in");
    }
    if data.len() > MAX_RECORD_BYTES {
        return Err(UNREADABLE);
    }
    data.iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or(UNREADABLE)
        })
        .collect()
}

pub(super) fn decrypt_safe_storage(blob: &[u8], secret: &str) -> Result<Vec<u8>, &'static str> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = blob.strip_prefix(b"v10").ok_or(UNREADABLE)?;
    if body.is_empty() || !body.len().is_multiple_of(16) {
        return Err(UNREADABLE);
    }
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(secret.as_bytes(), b"saltysalt", 1003, &mut key)
        .map_err(|_| UNREADABLE)?;
    cbc::Decryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|_| UNREADABLE)
}

fn text_field(source: &Value, key: &str) -> Option<String> {
    match source.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

fn epoch_seconds(source: &Value, key: &str) -> Option<i64> {
    let value = match source.get(key) {
        Some(Value::Number(number)) => number.as_i64()?,
        Some(Value::String(text)) => text.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    Some(if value > 100_000_000_000 {
        value / 1000
    } else {
        value
    })
}

fn to_klaus_profile(ide: &Value) -> Result<Value, &'static str> {
    let token = text_field(ide, "token").ok_or("qoder_ide_not_signed_in")?;
    let uid = text_field(ide, "id")
        .or_else(|| text_field(ide, "uid"))
        .ok_or(UNREADABLE)?;
    let mut out = Map::new();
    out.insert("uid".into(), json!(uid));
    out.insert("security_oauth_token".into(), json!(token.clone()));
    out.insert("access_token".into(), json!(token));
    if let Some(refresh) = text_field(ide, "refreshToken") {
        out.insert("refresh_token".into(), json!(refresh));
    }
    for (from, to) in [
        ("expireTime", "expire_time"),
        ("refreshTokenExpireTime", "refresh_token_expire_time"),
    ] {
        if let Some(value) = epoch_seconds(ide, from) {
            out.insert(to.into(), json!(value));
        }
    }
    for (from, to) in [
        ("name", "name"),
        ("email", "email"),
        ("avatarUrl", "avatar_url"),
        ("orgId", "organization_id"),
        ("orgName", "organization_name"),
    ] {
        if let Some(value) = text_field(ide, from) {
            out.insert(to.into(), json!(value));
        }
    }
    out.insert(
        "data_policy_agreed".into(),
        json!(ide
            .get("privacyPolicyAgreed")
            .and_then(Value::as_bool)
            .unwrap_or(true)),
    );
    out.insert("organization_tags".into(), json!([]));
    out.insert("login_method".into(), json!("qoder-ide"));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::FixtureKeychain;

    #[test]
    fn malformed_bytes_are_rejected_instead_of_wrapped_or_replaced() {
        for value in [json!(256), json!(-1), json!(1.5), json!("23"), Value::Null] {
            assert_eq!(
                decode_buffer(&json!({"type":"Buffer", "data":[118,49,48,value]}).to_string()),
                Err(UNREADABLE)
            );
        }
        assert_eq!(
            decode_buffer(r#"{"type":"Array","data":[1]}"#),
            Err(UNREADABLE)
        );
    }

    #[test]
    fn reads_a_committed_wal_row_and_maps_engine_fields_without_writing_the_ide() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.vscdb");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);").unwrap();
        let secret = "fixture-safe-storage-key";
        let ide = json!({"id":123, "token":"fake-token", "refreshToken":"fake-refresh", "expireTime":"1790000000000", "refreshTokenExpireTime":1795000000, "orgId":"org", "privacyPolicyAgreed":false});
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2::<hmac::Hmac<sha1::Sha1>>(secret.as_bytes(), b"saltysalt", 1003, &mut key)
            .unwrap();
        let mut blob = b"v10".to_vec();
        blob.extend(
            cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
                .encrypt_padded_vec_mut::<Pkcs7>(ide.to_string().as_bytes()),
        );
        let raw = json!({"type":"Buffer", "data":blob}).to_string();
        connection
            .execute(
                "INSERT INTO ItemTable VALUES (?1, ?2)",
                rusqlite::params![USER_INFO_SECRET, raw],
            )
            .unwrap();
        let before = std::fs::read(&db).unwrap();
        let wal_before = std::fs::read(db.with_extension("vscdb-wal")).unwrap();
        let keychain = FixtureKeychain::default();
        keychain
            .write("Qoder Safe Storage", "Qoder Key", secret.as_bytes())
            .unwrap();
        let result = read(&db, Platform::MacOs, &keychain);
        assert_eq!(
            result["userInfo"],
            json!({"uid":"123", "security_oauth_token":"fake-token", "access_token":"fake-token", "refresh_token":"fake-refresh", "expire_time":1790000000, "refresh_token_expire_time":1795000000, "organization_id":"org", "data_policy_agreed":false, "organization_tags":[], "login_method":"qoder-ide"})
        );
        assert_eq!(std::fs::read(&db).unwrap(), before);
        assert_eq!(
            std::fs::read(db.with_extension("vscdb-wal")).unwrap(),
            wal_before
        );
        assert_eq!(
            read(&db, Platform::Linux, &keychain)["error"],
            "qoder_ide_platform_unsupported"
        );
        keychain
            .write("Qoder Safe Storage", "Qoder Key", b"wrong-key")
            .unwrap();
        assert_eq!(read(&db, Platform::MacOs, &keychain)["error"], UNREADABLE);
    }
}
