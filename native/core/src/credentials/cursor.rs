use super::{Platform, MAX_RECORD_BYTES};
use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

const ACCESS_TOKEN_KEY: &str = "cursorAuth/accessToken";
const ACCOUNT_KEY: &str = "cursorAuth/cachedEmail";
const APPLICATION_USER_KEY: &str =
    "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";
const MAX_TOKEN_BYTES: usize = 32 * 1024;
const MAX_ACCOUNT_BYTES: usize = 1024;
const STATE_UNREADABLE: &str = "cursor_local_state_unreadable";
const SECRET_UNREADABLE: &str = "cursor_local_secret_unreadable";
const METADATA_UNREADABLE: &str = "cursor_local_metadata_unreadable";

pub(super) fn read(home: &Path, platform: Platform) -> Value {
    let (root, versions) = match platform {
        Platform::MacOs => (
            home.join("Library/Application Support/Cursor/User/globalStorage"),
            vec![
                home.join("Applications/Cursor.app/Contents/Resources/app/package.json"),
                PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/package.json"),
            ],
        ),
        Platform::Linux => (
            home.join(".config/Cursor/User/globalStorage"),
            vec![
                PathBuf::from("/usr/share/cursor/resources/app/package.json"),
                PathBuf::from("/opt/cursor/resources/app/package.json"),
            ],
        ),
        Platform::Windows => (
            home.join("AppData/Roaming/Cursor/User/globalStorage"),
            vec![home.join("AppData/Local/Programs/cursor/resources/app/package.json")],
        ),
        Platform::Unsupported => {
            return json!({"present": false, "error": "cursor_local_platform_unsupported"});
        }
    };
    read_paths(&root, &versions)
}

fn read_paths(root: &Path, versions: &[PathBuf]) -> Value {
    let state_path = root.join("state.vscdb");
    match state_path.try_exists() {
        Ok(false) => return json!({"present": false}),
        Err(_) => return json!({"present": true, "error": STATE_UNREADABLE}),
        Ok(true) => {}
    }
    let load = || -> Result<Value, &'static str> {
        let snapshot = read_snapshot(&state_path)?;
        let (access_token, account) = (snapshot.access_token, snapshot.account);
        let mut info = Map::new();
        if let Some(expiry) = token_expiry_ms(&access_token) {
            info.insert("expiresAt".into(), json!(expiry));
        }
        info.insert("accessToken".into(), json!(access_token));
        if let Some(account) = account {
            info.insert("account".into(), json!(account));
        }
        if let Some(application_user) = snapshot.application_user {
            let metadata: Value =
                serde_json::from_str(&application_user).map_err(|_| METADATA_UNREADABLE)?;
            if !metadata.is_object() {
                return Err(METADATA_UNREADABLE);
            }
            if let Some(credentials) = metadata.get("cursorCreds") {
                if !credentials.is_object() {
                    return Err(METADATA_UNREADABLE);
                }
                for (source, target) in [
                    ("backendUrl", "backendUrl"),
                    ("localLoopInferenceUrl", "inferenceUrl"),
                ] {
                    if let Some(value) = credentials.get(source) {
                        info.insert(target.into(), json!(service_origin(value)?));
                    }
                }
                if let Some(origins) = credentials.get("agentBackendUrlNonPrivacy") {
                    let origins = origins.as_object().ok_or(METADATA_UNREADABLE)?;
                    if let Some(value) = origins.get("default") {
                        info.insert("inferenceUrl".into(), json!(service_origin(value)?));
                    }
                }
            }
        }
        if let Some(metadata) = read_json(&root.join("storage.json"), METADATA_UNREADABLE)? {
            if let Some(identity) = request_identity(&metadata)? {
                info.insert("clientIdentity".into(), json!(identity));
            }
        }
        for path in versions {
            if let Some(metadata) = read_json(path, METADATA_UNREADABLE)? {
                let version = metadata
                    .get("version")
                    .and_then(|value| header_text(value, 128))
                    .filter(|value| {
                        value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
                    })
                    .ok_or(METADATA_UNREADABLE)?;
                info.insert("clientVersion".into(), json!(version));
                break;
            }
        }
        Ok(Value::Object(info))
    };
    match load() {
        Ok(info) => json!({"present": true, "userInfo": info}),
        Err(error) => json!({"present": true, "error": error}),
    }
}

fn request_identity(metadata: &Value) -> Result<Option<String>, &'static str> {
    let component = |key| -> Result<Option<&str>, &'static str> {
        metadata
            .get(key)
            .map(|value| {
                header_text(value, 256)
                    .filter(|text| {
                        text.bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
                    })
                    .ok_or(METADATA_UNREADABLE)
            })
            .transpose()
    };
    let machine = component("telemetry.machineId")?;
    let platform = component("telemetry.macMachineId")?;
    match (machine, platform) {
        (Some(machine), Some(platform)) => Ok(Some(format!("{machine}/{platform}"))),
        (Some(machine), None) => Ok(Some(machine.into())),
        (None, None) => Ok(None),
        (None, Some(_)) => Err(METADATA_UNREADABLE),
    }
}

struct Snapshot {
    access_token: String,
    account: Option<String>,
    application_user: Option<String>,
}

fn read_snapshot(path: &Path) -> Result<Snapshot, &'static str> {
    // A normal read-only connection sees committed WAL data without checkpointing it.
    let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| STATE_UNREADABLE)?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|_| STATE_UNREADABLE)?;
    let transaction = connection.transaction().map_err(|_| STATE_UNREADABLE)?;
    let mut query = transaction
        .prepare(
            "SELECT key, CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= \
             CASE WHEN key = ?3 THEN ?4 ELSE ?5 END THEN value ELSE NULL END \
             FROM ItemTable WHERE key IN (?1, ?2, ?3)",
        )
        .map_err(|_| STATE_UNREADABLE)?;
    let rows = query
        .query_map(
            rusqlite::params![
                ACCESS_TOKEN_KEY,
                ACCOUNT_KEY,
                APPLICATION_USER_KEY,
                MAX_RECORD_BYTES as i64,
                MAX_TOKEN_BYTES as i64
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map_err(|_| STATE_UNREADABLE)?;
    let mut token = None;
    let mut account = None;
    let mut application_user = None;
    for row in rows {
        let (key, value) = row.map_err(|_| STATE_UNREADABLE)?;
        let value = value.ok_or(SECRET_UNREADABLE)?;
        if key == ACCESS_TOKEN_KEY {
            if value.trim().is_empty() {
                return Err("cursor_local_not_signed_in");
            }
            if !value.bytes().all(|byte| byte.is_ascii_graphic()) {
                return Err(SECRET_UNREADABLE);
            }
            token = Some(value);
        } else if key == ACCOUNT_KEY && !value.trim().is_empty() {
            if value.len() > MAX_ACCOUNT_BYTES || value.chars().any(char::is_control) {
                return Err(SECRET_UNREADABLE);
            }
            account = Some(value.trim().to_string());
        } else if key == APPLICATION_USER_KEY {
            application_user = Some(value);
        }
    }
    Ok(Snapshot {
        access_token: token.ok_or("cursor_local_not_signed_in")?,
        account,
        application_user,
    })
}

fn service_origin(value: &Value) -> Result<String, &'static str> {
    let text = header_text(value, 2048).ok_or(METADATA_UNREADABLE)?;
    let url = reqwest::Url::parse(text).map_err(|_| METADATA_UNREADABLE)?;
    let host = url.host_str().ok_or(METADATA_UNREADABLE)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !["cursor.sh", "cursorapi.com"]
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
    {
        return Err(METADATA_UNREADABLE);
    }
    Ok(url.origin().ascii_serialization())
}

fn read_json(path: &Path, error: &'static str) -> Result<Option<Value>, &'static str> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(error);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| error)?;
    if !value.is_object() {
        return Err(error);
    }
    Ok(Some(value))
}

fn header_text(value: &Value, limit: usize) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty()
            && value.len() <= limit
            && value.bytes().all(|byte| byte.is_ascii_graphic())
    })
}

fn token_expiry_ms(token: &str) -> Option<i64> {
    let mut parts = token.split('.');
    parts.next()?;
    let payload = parts.next()?;
    parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    // This unverified claim schedules re-import; it is never an authentication verdict.
    claims
        .get("exp")?
        .as_i64()?
        .checked_mul(1000)
        .filter(|value| *value > 0 && *value <= 8_640_000_000_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(root: &Path, token: Option<&str>) -> Connection {
        std::fs::create_dir_all(root).unwrap();
        let db = Connection::open(root.join("state.vscdb")).unwrap();
        db.execute_batch("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
            .unwrap();
        if let Some(token) = token {
            insert(&db, ACCESS_TOKEN_KEY, token);
        }
        db
    }

    fn insert(db: &Connection, key: &str, value: &str) {
        db.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .unwrap();
    }

    fn jwt(exp: Value) -> String {
        format!(
            "header.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(json!({"exp": exp}).to_string())
        )
    }

    #[test]
    fn imports_only_the_access_snapshot_and_real_metadata_without_changing_inputs() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let token = jwt(json!(1_900_000_000_i64));
        let db = database(root, Some(&token));
        insert(&db, ACCOUNT_KEY, "fixture@example.invalid");
        insert(
            &db,
            "cursorAuth/refreshToken",
            &"never-import-this".repeat(MAX_RECORD_BYTES / 8),
        );
        insert(
            &db,
            APPLICATION_USER_KEY,
            &json!({"cursorCreds": {
                "backendUrl": "https://api2.cursor.sh/",
                "localLoopInferenceUrl": "https://agentn.global.api5.cursor.sh",
                "unrelatedSecret": "never-import-this"
            }})
            .to_string(),
        );
        drop(db);
        let package = root.join("package.json");
        std::fs::write(&package, r#"{"version":"9.2.3-test","other":"private"}"#).unwrap();
        let before = std::fs::read(root.join("state.vscdb")).unwrap();
        assert_eq!(
            read_paths(root, std::slice::from_ref(&package)),
            json!({"present": true, "userInfo": {
                "accessToken": token, "expiresAt": 1_900_000_000_000_i64,
                "account": "fixture@example.invalid", "clientVersion": "9.2.3-test",
                "backendUrl": "https://api2.cursor.sh", "inferenceUrl": "https://agentn.global.api5.cursor.sh"
            }})
        );
        assert_eq!(std::fs::read(root.join("state.vscdb")).unwrap(), before);
        assert_eq!(
            std::fs::read_to_string(package).unwrap(),
            r#"{"version":"9.2.3-test","other":"private"}"#
        );
    }

    #[test]
    fn reads_a_committed_access_snapshot_from_the_live_wal() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let db = database(root, Some("old-token"));
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
            .unwrap();
        insert(&db, ACCESS_TOKEN_KEY, "current-token");
        insert(&db, ACCOUNT_KEY, "current@example.invalid");
        assert_eq!(
            read_paths(root, &[]),
            json!({"present": true, "userInfo": {"accessToken": "current-token", "account": "current@example.invalid"}})
        );
    }

    #[test]
    fn imports_required_request_identity_and_active_model_origin_without_changing_sources() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let db = database(root, Some("fixture-token"));
        insert(
            &db,
            APPLICATION_USER_KEY,
            &json!({"cursorCreds": {
                "backendUrl": "https://api2.cursor.sh/",
                "localLoopInferenceUrl": "https://unused.cursor.sh",
                "agentBackendUrlNonPrivacy": {"default": "https://models.cursor.sh"}
            }})
            .to_string(),
        );
        drop(db);
        let storage = root.join("storage.json");
        let content = json!({
            "telemetry.machineId": "fixture-machine",
            "telemetry.macMachineId": "fixture-platform",
            "unrelatedSecret": "never-import-this"
        })
        .to_string();
        std::fs::write(&storage, &content).unwrap();
        let state_before = std::fs::read(root.join("state.vscdb")).unwrap();
        assert_eq!(
            read_paths(root, &[]),
            json!({"present": true, "userInfo": {
                "accessToken": "fixture-token",
                "clientIdentity": "fixture-machine/fixture-platform",
                "backendUrl": "https://api2.cursor.sh",
                "inferenceUrl": "https://models.cursor.sh"
            }})
        );
        assert_eq!(std::fs::read_to_string(storage).unwrap(), content);
        assert_eq!(
            std::fs::read(root.join("state.vscdb")).unwrap(),
            state_before
        );
    }

    #[test]
    fn rejects_malformed_request_identity_without_returning_its_content() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let db = database(root, Some("fixture-token"));
        drop(db);
        for value in [
            json!(""),
            json!("private\nvalue"),
            json!("private/value"),
            json!("x".repeat(257)),
            json!(17),
        ] {
            std::fs::write(
                root.join("storage.json"),
                json!({"telemetry.machineId": value}).to_string(),
            )
            .unwrap();
            assert_eq!(
                read_paths(root, &[]),
                json!({"present": true, "error": METADATA_UNREADABLE})
            );
        }
        assert_eq!(
            request_identity(&json!({"telemetry.macMachineId": "orphan"})),
            Err(METADATA_UNREADABLE)
        );
        assert_eq!(
            request_identity(&json!({"telemetry.machineId": "fixture-machine"})),
            Ok(Some("fixture-machine".into()))
        );
    }

    #[test]
    fn missing_and_signed_out_stores_are_distinct_and_never_created() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("absent");
        assert_eq!(read_paths(&root, &[]), json!({"present": false}));
        assert!(!root.exists());
        let db = database(&root, None);
        assert_eq!(
            read_paths(&root, &[]),
            json!({"present": true, "error": "cursor_local_not_signed_in"})
        );
        insert(&db, ACCESS_TOKEN_KEY, "  ");
        assert_eq!(
            read_paths(&root, &[])["error"],
            "cursor_local_not_signed_in"
        );
    }

    #[test]
    fn malformed_and_oversized_values_return_only_safe_error_codes() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        std::fs::write(root.join("state.vscdb"), "sensitive-invalid-db").unwrap();
        assert_eq!(
            read_paths(root, &[]),
            json!({"present": true, "error": STATE_UNREADABLE})
        );
        std::fs::remove_file(root.join("state.vscdb")).unwrap();
        let db = database(root, Some(&"s".repeat(MAX_TOKEN_BYTES + 1)));
        assert_eq!(
            read_paths(root, &[]),
            json!({"present": true, "error": SECRET_UNREADABLE})
        );
        insert(&db, ACCESS_TOKEN_KEY, "valid-token");
        insert(&db, ACCOUNT_KEY, &"e".repeat(MAX_ACCOUNT_BYTES + 1));
        assert_eq!(read_paths(root, &[])["error"], SECRET_UNREADABLE);
        insert(&db, ACCOUNT_KEY, "fixture@example.invalid");
        assert_eq!(
            read_paths(root, &[])["userInfo"]["accessToken"],
            "valid-token"
        );
    }

    #[test]
    fn expiry_is_optional_milliseconds_and_does_not_renew_or_discard_expired_tokens() {
        assert_eq!(
            token_expiry_ms(&jwt(json!(1_900_000_000_i64))),
            Some(1_900_000_000_000)
        );
        for value in [
            json!(-1),
            json!(0),
            json!("1900000000"),
            json!(1.5),
            json!(i64::MAX),
        ] {
            assert_eq!(token_expiry_ms(&jwt(value)), None);
        }
        assert_eq!(token_expiry_ms("opaque-token"), None);
        assert_eq!(token_expiry_ms("header.invalid.signature"), None);
        let fixture = tempfile::tempdir().unwrap();
        let token = jwt(json!(1));
        let db = database(fixture.path(), Some(&token));
        assert_eq!(
            read_paths(fixture.path(), &[])["userInfo"]["expiresAt"],
            1000
        );
        drop(db);
    }

    #[test]
    fn service_origins_accept_only_trusted_https_hosts_without_other_url_parts() {
        for value in ["https://api2.cursor.sh", "https://edge.cursorapi.com/"] {
            assert!(service_origin(&json!(value)).is_ok());
        }
        for value in [
            "http://api2.cursor.sh",
            "https://localhost",
            "https://127.0.0.1",
            "https://api2.cursor.sh.evil.invalid",
            "https://cursor.sh@evil.invalid",
            "https://user@api2.cursor.sh",
            "https://api2.cursor.sh:8443",
            "https://api2.cursor.sh/route",
            "https://api2.cursor.sh?key=secret",
            "https://api2.cursor.sh#secret",
            "file:///private/secret",
        ] {
            assert_eq!(service_origin(&json!(value)), Err(METADATA_UNREADABLE));
        }
        let fixture = tempfile::tempdir().unwrap();
        let db = database(fixture.path(), Some("valid-token"));
        insert(
            &db,
            APPLICATION_USER_KEY,
            &json!({"cursorCreds": {
                "backendUrl": "https://evil.invalid"
            }})
            .to_string(),
        );
        assert_eq!(
            read_paths(fixture.path(), &[]),
            json!({"present": true, "error": METADATA_UNREADABLE})
        );
    }

    #[test]
    fn bounds_application_metadata_and_validates_installed_version_fields() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path();
        let db = database(root, Some("valid-token"));
        insert(&db, APPLICATION_USER_KEY, &" ".repeat(MAX_RECORD_BYTES + 1));
        assert_eq!(read_paths(root, &[])["error"], SECRET_UNREADABLE);
        insert(&db, APPLICATION_USER_KEY, "{}");
        let package = root.join("package.json");
        std::fs::write(&package, " ".repeat(MAX_RECORD_BYTES + 1)).unwrap();
        assert_eq!(
            read_paths(root, std::slice::from_ref(&package))["error"],
            METADATA_UNREADABLE
        );
        std::fs::write(&package, r#"{"version":"bad version"}"#).unwrap();
        assert_eq!(
            read_paths(root, std::slice::from_ref(&package))["error"],
            METADATA_UNREADABLE
        );
    }

    #[test]
    fn a_busy_database_fails_within_the_bounded_lock_wait() {
        let fixture = tempfile::tempdir().unwrap();
        let db = database(fixture.path(), Some("valid-token"));
        db.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let start = std::time::Instant::now();
        assert_eq!(
            read_paths(fixture.path(), &[]),
            json!({"present": true, "error": STATE_UNREADABLE})
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
