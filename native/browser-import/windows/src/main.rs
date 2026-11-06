use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};
use std::path::Path;
use zeroize::{Zeroize, Zeroizing};

#[cfg(windows)]
use std::ptr::null_mut;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
#[cfg(windows)]
use windows_sys::Win32::Security::Cryptography::{
    CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_CIPHERTEXT_BYTES: usize = 256 * 1024;
const MAX_PLAINTEXT_BYTES: usize = 64 * 1024;
const MAX_LOCAL_STATE_BYTES: u64 = 16 * 1024 * 1024;
const PROTOCOL_VERSION: u64 = 1;

#[derive(Clone, Copy, Debug)]
struct HelperError {
    code: &'static str,
    message: &'static str,
}

impl HelperError {
    const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[cfg(not(windows))]
fn unsupported() -> HelperError {
    HelperError::new(
        "unsupported_platform_encryption",
        "Encrypted browser profile values are not supported on this platform.",
    )
}

#[cfg(windows)]
fn make_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, HelperError> {
    let mut input = make_blob(blob);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            null_mut(),
            std::ptr::null(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(HelperError::new(
            "windows_dpapi_failed",
            "The Windows data protection key could not be decrypted.",
        ));
    }
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        if !output.pbData.is_null() {
            LocalFree(output.pbData as HLOCAL);
        }
    }
    Ok(Zeroizing::new(result))
}

#[cfg(not(windows))]
fn dpapi_unprotect(_blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, HelperError> {
    Err(unsupported())
}

#[cfg(all(test, windows))]
#[allow(clippy::unnecessary_mut_passed)]
fn dpapi_protect_for_test(data: &[u8]) -> Result<Vec<u8>, HelperError> {
    use windows_sys::Win32::Security::Cryptography::CryptProtectData;
    let mut input = make_blob(data);
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(HelperError::new(
            "windows_dpapi_protect_failed",
            "The Windows data protection key could not be protected.",
        ));
    }
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        if !output.pbData.is_null() {
            LocalFree(output.pbData as HLOCAL);
        }
    }
    Ok(result)
}

struct HelperState {
    family: String,
    key: Option<Zeroizing<Vec<u8>>>,
}

impl HelperState {
    fn initialize(request: &Value) -> Result<Self, HelperError> {
        let family = request
            .get("family")
            .and_then(Value::as_str)
            .ok_or(HelperError::new(
                "invalid_request",
                "The init request has no source family.",
            ))?;
        if !matches!(family, "chrome" | "chromium" | "edge") {
            return Err(HelperError::new(
                "unsupported_source",
                "The selected browser source is not supported.",
            ));
        }
        let user_data_dir = request
            .get("userDataDir")
            .and_then(Value::as_str)
            .ok_or(HelperError::new(
                "windows_local_state_required",
                "The Windows source profile root is required.",
            ))?;
        if !Path::new(user_data_dir).is_absolute() {
            return Err(HelperError::new(
                "invalid_request",
                "The Windows source profile root must be absolute.",
            ));
        }
        let key = load_windows_key(user_data_dir)?;
        Ok(Self {
            family: family.to_string(),
            key: Some(key),
        })
    }

    fn decrypt(
        &self,
        data: &[u8],
        kind: &str,
        host: Option<&str>,
        database_version: u64,
    ) -> Result<Zeroizing<Vec<u8>>, HelperError> {
        if kind != "cookie" && kind != "password" {
            return Err(HelperError::new(
                "invalid_request",
                "The decrypt request has an unknown kind.",
            ));
        }
        let key = self.key.as_ref().ok_or_else(|| {
            HelperError::new("not_initialized", "The helper has no browser key.")
        })?;
        let mut plaintext = if data.starts_with(b"v20") {
            return Err(HelperError::new(
                "app_bound_encryption_unsupported",
                "App-bound browser encryption is not supported.",
            ));
        } else if data.starts_with(b"v10") {
            decrypt_v10(key, &data[3..])?
        } else if data.starts_with(b"v") {
            return Err(HelperError::new(
                "unsupported_encryption",
                "The browser encryption format is not supported.",
            ));
        } else {
            dpapi_unprotect(data)?
        };

        if kind == "cookie" && database_version >= 24 {
            let host = host.ok_or(HelperError::new(
                "host_required",
                "A partitioned cookie check requires the host key.",
            ))?;
            let expected = Sha256::digest(host.as_bytes());
            if plaintext.len() < expected.len()
                || plaintext[..expected.len()] != expected[..]
            {
                plaintext.zeroize();
                return Err(HelperError::new(
                    "host_hash_mismatch",
                    "The encrypted cookie host hash does not match.",
                ));
            }
            plaintext.drain(..expected.len());
        }
        if plaintext.len() > MAX_PLAINTEXT_BYTES {
            plaintext.zeroize();
            return Err(HelperError::new(
                "plaintext_too_large",
                "The decrypted value exceeds the supported size.",
            ));
        }
        Ok(plaintext)
    }
}

impl Drop for HelperState {
    fn drop(&mut self) {
        self.family.zeroize();
        if let Some(mut key) = self.key.take() {
            key.zeroize();
        }
    }
}

fn load_windows_key(user_data_dir: &str) -> Result<Zeroizing<Vec<u8>>, HelperError> {
    let path = Path::new(user_data_dir).join("Local State");
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
        HelperError::new(
            "windows_local_state_unreadable",
            "The Windows Local State file could not be read.",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(HelperError::new(
            "windows_local_state_unreadable",
            "The Windows Local State file is not a regular file.",
        ));
    }
    if metadata.len() > MAX_LOCAL_STATE_BYTES {
        return Err(HelperError::new(
            "windows_local_state_too_large",
            "The Windows Local State file exceeds the supported size.",
        ));
    }
    let bytes = std::fs::read(&path).map_err(|_| {
        HelperError::new(
            "windows_local_state_unreadable",
            "The Windows Local State file could not be read.",
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        HelperError::new(
            "windows_local_state_invalid",
            "The Windows Local State file is not valid JSON.",
        )
    })?;
    let encoded = value
        .get("os_crypt")
        .and_then(|value| value.get("encrypted_key"))
        .and_then(Value::as_str)
        .ok_or(HelperError::new(
            "windows_key_missing",
            "The Windows browser profile has no encryption key.",
        ))?;
    let decoded = STANDARD.decode(encoded).map_err(|_| {
        HelperError::new(
            "windows_key_invalid",
            "The Windows browser profile encryption key is invalid.",
        )
    })?;
    if !decoded.starts_with(b"DPAPI") || decoded.len() <= 5 {
        return Err(HelperError::new(
            "windows_key_invalid",
            "The Windows browser profile encryption key is invalid.",
        ));
    }
    let mut key = dpapi_unprotect(&decoded[5..])?;
    if key.len() != 32 {
        key.zeroize();
        return Err(HelperError::new(
            "windows_key_invalid",
            "The Windows browser profile encryption key has an unsupported length.",
        ));
    }
    Ok(key)
}

fn decrypt_v10(
    key: &Zeroizing<Vec<u8>>,
    body: &[u8],
) -> Result<Zeroizing<Vec<u8>>, HelperError> {
    if body.len() < 12 + 16 {
        return Err(HelperError::new(
            "decryption_failed",
            "The encrypted browser value is malformed.",
        ));
    }
    let (nonce, ciphertext) = body.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key.as_slice()).map_err(|_| {
        HelperError::new("windows_key_invalid", "The Windows browser key is invalid.")
    })?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| {
            HelperError::new(
                "decryption_failed",
                "The encrypted browser value could not be decrypted.",
            )
        })?;
    Ok(Zeroizing::new(plaintext))
}

fn write_response(value: &Value) -> io::Result<()> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    serde_json::to_writer(&mut lock, value)?;
    lock.write_all(b"\n")?;
    lock.flush()
}

fn write_error(id: Option<u64>, error: HelperError) -> io::Result<()> {
    let mut value = json!({
        "ok": false,
        "code": error.code,
        "message": error.message,
    });
    if let Some(id) = id {
        value["id"] = json!(id);
    }
    write_response(&value)
}

fn parse_base64(value: &Value) -> Result<Vec<u8>, HelperError> {
    let encoded = value.as_str().ok_or(HelperError::new(
        "invalid_request",
        "The encrypted value is missing.",
    ))?;
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        HelperError::new("invalid_request", "The encrypted value is not valid base64.")
    })?;
    if bytes.len() > MAX_CIPHERTEXT_BYTES {
        return Err(HelperError::new(
            "request_too_large",
            "The encrypted value exceeds the supported size.",
        ));
    }
    Ok(bytes)
}

fn handle_line(line: &str, state: &mut Option<HelperState>) -> Result<bool, HelperError> {
    let request: Value = serde_json::from_str(line).map_err(|_| {
        HelperError::new("invalid_request", "The helper request is not valid JSON.")
    })?;
    let operation = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or(HelperError::new(
            "invalid_request",
            "The helper request has no operation.",
        ))?;
    match operation {
        "init" => {
            let next = HelperState::initialize(&request)?;
            *state = Some(next);
            write_response(&json!({
                "ok": true,
                "op": "init",
                "protocol": PROTOCOL_VERSION,
            }))
            .map_err(|_| HelperError::new("write_failed", "The response could not be written."))?;
            Ok(true)
        }
        "decrypt" => {
            let id = request.get("id").and_then(Value::as_u64).ok_or(
                HelperError::new("invalid_request", "The decrypt request has no id."),
            )?;
            let state = state.as_ref().ok_or(HelperError::new(
                "not_initialized",
                "The helper was not initialized.",
            ))?;
            let kind = request
                .get("kind")
                .and_then(Value::as_str)
                .ok_or(HelperError::new(
                    "invalid_request",
                    "The decrypt request has no kind.",
                ))?;
            let data = parse_base64(request.get("data").unwrap_or(&Value::Null))?;
            let host = request.get("host").and_then(Value::as_str);
            let version = request
                .get("databaseVersion")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let plaintext = state.decrypt(&data, kind, host, version)?;
            let encoded = STANDARD.encode(plaintext.as_slice());
            write_response(&json!({
                "id": id,
                "ok": true,
                "value": encoded,
            }))
            .map_err(|_| HelperError::new("write_failed", "The response could not be written."))?;
            Ok(true)
        }
        "shutdown" => {
            *state = None;
            write_response(&json!({"ok": true, "op": "shutdown"}))
                .map_err(|_| HelperError::new("write_failed", "The response could not be written."))?;
            Ok(false)
        }
        _ => Err(HelperError::new(
            "unsupported_operation",
            "The helper operation is not supported.",
        )),
    }
}

fn run() -> i32 {
    let stdin = io::stdin();
    let mut state: Option<HelperState> = None;
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => {
                let _ = write_error(None, HelperError::new(
                    "read_failed",
                    "The helper request could not be read.",
                ));
                return 1;
            }
        };
        if line.len() > MAX_LINE_BYTES {
            let _ = write_error(None, HelperError::new(
                "request_too_large",
                "The helper request exceeds the supported line size.",
            ));
            return 1;
        }
        match handle_line(line.trim_end_matches('\r'), &mut state) {
            Ok(true) => {}
            Ok(false) => return 0,
            Err(error) => {
                let id = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|value| value.get("id").and_then(Value::as_u64));
                let _ = write_error(id, error);
            }
        }
    }
    drop(state);
    0
}

fn main() {
    std::process::exit(run());
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;

    fn local_state(dir: &Path, key: &[u8]) {
        let protected = dpapi_protect_for_test(key).unwrap();
        let mut encoded = b"DPAPI".to_vec();
        encoded.extend_from_slice(&protected);
        fs::write(
            dir.join("Local State"),
            serde_json::to_vec(&json!({
                "os_crypt": { "encrypted_key": STANDARD.encode(encoded) }
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn v10(key: &[u8], plaintext: &[u8], nonce: [u8; 12]) -> Vec<u8> {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let mut result = b"v10".to_vec();
        result.extend_from_slice(&nonce);
        result.extend_from_slice(&cipher.encrypt(Nonce::from_slice(&nonce), plaintext).unwrap());
        result
    }

    fn state(dir: &Path) -> HelperState {
        HelperState::initialize(&json!({
            "family": "chrome",
            "userDataDir": dir.to_string_lossy(),
        }))
        .unwrap()
    }

    #[test]
    fn decrypts_v10_aes_gcm_cookie_and_password() {
        let dir = tempfile::tempdir().unwrap();
        let key = [0x42u8; 32];
        local_state(dir.path(), &key);
        let state = state(dir.path());
        let encrypted = v10(&key, b"password-secret", [0x11; 12]);
        assert_eq!(
            state.decrypt(&encrypted, "password", None, 0).unwrap().as_slice(),
            b"password-secret"
        );

        let mut cookie_plain = Sha256::digest(b"example.test").to_vec();
        cookie_plain.extend_from_slice(b"cookie-secret");
        let cookie = v10(&key, &cookie_plain, [0x12; 12]);
        assert_eq!(
            state
                .decrypt(&cookie, "cookie", Some("example.test"), 24)
                .unwrap()
                .as_slice(),
            b"cookie-secret"
        );
        assert_eq!(
            state
                .decrypt(&cookie, "cookie", Some("wrong.test"), 24)
                .unwrap_err()
                .code,
            "host_hash_mismatch"
        );
    }

    #[test]
    fn decrypts_legacy_dpapi_and_rejects_app_bound() {
        let dir = tempfile::tempdir().unwrap();
        let key = [0x24u8; 32];
        local_state(dir.path(), &key);
        let state = state(dir.path());
        let legacy = dpapi_protect_for_test(b"legacy-secret").unwrap();
        assert_eq!(
            state.decrypt(&legacy, "password", None, 0).unwrap().as_slice(),
            b"legacy-secret"
        );
        assert_eq!(
            state
                .decrypt(b"v20app-bound", "password", None, 0)
                .unwrap_err()
                .code,
            "app_bound_encryption_unsupported"
        );
    }
}
