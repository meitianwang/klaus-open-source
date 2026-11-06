#![cfg(windows)]

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

fn protect(data: &[u8]) -> Vec<u8> {
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
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
    assert_ne!(ok, 0, "CryptProtectData failed");
    let result = unsafe {
        std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
    };
    unsafe {
        if !output.pbData.is_null() {
            LocalFree(output.pbData as HLOCAL);
        }
    }
    result
}

fn v10(key: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let nonce = [0x33u8; 12];
    let cipher = Aes256Gcm::new_from_slice(key).unwrap();
    let mut result = b"v10".to_vec();
    result.extend_from_slice(&nonce);
    result.extend_from_slice(&cipher.encrypt(Nonce::from_slice(&nonce), plaintext).unwrap());
    result
}

#[test]
fn ndjson_helper_decrypts_a_synthetic_windows_profile() {
    let directory = tempfile::tempdir().unwrap();
    let key = [0x51u8; 32];
    let mut encrypted_key = b"DPAPI".to_vec();
    encrypted_key.extend_from_slice(&protect(&key));
    std::fs::write(
        directory.path().join("Local State"),
        serde_json::to_vec(&json!({
            "os_crypt": { "encrypted_key": STANDARD.encode(encrypted_key) }
        }))
        .unwrap(),
    )
    .unwrap();
    let ciphertext = v10(&key, b"protocol-secret");

    let mut child = Command::new(env!("CARGO_BIN_EXE_klaus-browser-import-windows"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();

    writeln!(
        input,
        "{}",
        json!({
            "op": "init",
            "family": "chrome",
            "userDataDir": directory.path().to_string_lossy(),
        })
    )
    .unwrap();
    output.read_line(&mut line).unwrap();
    let init: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(init["ok"], true);
    assert_eq!(init["op"], "init");

    line.clear();
    writeln!(
        input,
        "{}",
        json!({
            "op": "decrypt",
            "id": 1,
            "kind": "password",
            "data": STANDARD.encode(ciphertext),
        })
    )
    .unwrap();
    output.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["ok"], true);
    assert_eq!(
        STANDARD.decode(response["value"].as_str().unwrap()).unwrap(),
        b"protocol-secret"
    );

    line.clear();
    writeln!(input, "{}", json!({"op": "shutdown"})).unwrap();
    output.read_line(&mut line).unwrap();
    let shutdown: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(shutdown["ok"], true);
    assert!(child.wait().unwrap().success());
}
