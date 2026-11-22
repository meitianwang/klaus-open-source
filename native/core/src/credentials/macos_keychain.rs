//! Non-interactive macOS Keychain access for CLI-managed local credentials.
//!
//! Command-line login helpers on macOS store generic-password entries through
//! `/usr/bin/security`, which binds the item to the `apple-tool:` partition and
//! places `/usr/bin/security` on the passwordless decrypt ACL. Whenever those
//! tools refresh an OAuth token via `delete-generic-password` +
//! `add-generic-password` or `add-generic-password -U`, macOS resets the item's
//! `ACLAuthorizationPartitionID` back to `apple-tool:` (and on delete+add drops
//! third-party app entries), invalidating any prior "Always Allow" granted to
//! this app bundle.
//!
//! Querying an item's `SecKeychainItemRef` and inspecting its `SecAccessRef`
//! touches only unencrypted index metadata and never prompts. When the ACL
//! already grants passwordless decrypt to `/usr/bin/security` within
//! `apple-tool:`, reading through `/usr/bin/security` avoids prompting both on
//! first reuse and after upstream token refreshes. Entries owned by other GUI
//! apps (such as Safe Storage keys without `apple-tool:`) stay on the
//! in-process `SecItemCopyMatching` path so macOS attributes authorization to
//! Klaus.

use super::{error, is_product_keychain_service, MAX_RECORD_BYTES};
use crate::{NativeError, Result};
use std::ffi::{c_char, c_void};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ERR_SEC_SUCCESS: i32 = 0;
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
const K_SEC_KEYCHAIN_PROMPT_REQUIRE_PASSPHRASE: u16 = 0x0001;
const SECURITY_CLI_PATH: &str = "/usr/bin/security";
const SECURITY_CLI_TIMEOUT: Duration = Duration::from_secs(5);

type OSStatus = i32;
type CFIndex = isize;
type CFTypeRef = *const c_void;
type CFArrayRef = *const c_void;
type CFStringRef = *const c_void;
type CFDataRef = *const c_void;
#[cfg(test)]
type SecKeychainRef = *const c_void;
type SecKeychainItemRef = *const c_void;
type SecAccessRef = *const c_void;
type SecACLRef = *const c_void;
type SecTrustedApplicationRef = *const c_void;

extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFArrayGetCount(the_array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(the_array: CFArrayRef, idx: CFIndex) -> *const c_void;
    fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> u8;
    fn CFDataGetLength(the_data: CFDataRef) -> CFIndex;
    fn CFDataGetBytePtr(the_data: CFDataRef) -> *const u8;

    fn SecKeychainFindGenericPassword(
        keychain_or_array: CFTypeRef,
        service_name_length: u32,
        service_name: *const c_char,
        account_name_length: u32,
        account_name: *const c_char,
        password_length: *mut u32,
        password_data: *mut *mut c_void,
        item_ref: *mut SecKeychainItemRef,
    ) -> OSStatus;
    fn SecKeychainItemCopyAccess(
        item_ref: SecKeychainItemRef,
        access: *mut SecAccessRef,
    ) -> OSStatus;
    fn SecAccessCopyACLList(access_ref: SecAccessRef, acl_list: *mut CFArrayRef) -> OSStatus;
    fn SecACLCopyAuthorizations(acl_ref: SecACLRef) -> CFArrayRef;
    fn SecACLCopyContents(
        acl_ref: SecACLRef,
        application_list: *mut CFArrayRef,
        description: *mut CFStringRef,
        prompt_selector: *mut u16,
    ) -> OSStatus;
    fn SecTrustedApplicationCopyData(
        app_ref: SecTrustedApplicationRef,
        data: *mut CFDataRef,
    ) -> OSStatus;
    #[cfg(test)]
    fn SecKeychainOpen(path_name: *const c_char, keychain: *mut SecKeychainRef) -> OSStatus;
}

struct CfGuard(CFTypeRef);

impl Drop for CfGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

enum LookupRef {
    Found(CfGuard),
    Missing,
    Unavailable,
}

pub(super) fn read_generic_password(
    service: &str,
    account: Option<&str>,
) -> Result<Option<Vec<u8>>> {
    if !is_product_keychain_service(service) {
        match lookup_item_ref(std::ptr::null(), service, account) {
            LookupRef::Missing => return Ok(None),
            LookupRef::Found(item_ref) => {
                if item_allows_security_cli_without_prompt(item_ref.0) {
                    if let Ok(found) = read_via_security_cli(None, service, account) {
                        return match found {
                            Some(bytes) if bytes.len() > MAX_RECORD_BYTES => {
                                Err(error("credential_record_too_large"))
                            }
                            other => Ok(other),
                        };
                    }
                }
            }
            LookupRef::Unavailable => {}
        }
    }
    read_in_process(service, account)
}

fn read_in_process(service: &str, account: Option<&str>) -> Result<Option<Vec<u8>>> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit, SearchResult};
    let mut options = ItemSearchOptions::new();
    options
        .class(ItemClass::generic_password())
        .service(service)
        .load_data(true)
        .limit(Limit::Max(1));
    if let Some(account) = account {
        options.account(account);
    }
    match options.search() {
        Ok(items) => match items.into_iter().next() {
            Some(SearchResult::Data(bytes)) => {
                if bytes.len() > MAX_RECORD_BYTES {
                    Err(error("credential_record_too_large"))
                } else {
                    Ok(Some(bytes))
                }
            }
            None => Ok(None),
            _ => Err(error("credential_keychain_unreadable")),
        },
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(NativeError::new(
            "credential_keychain_denied",
            format!("OSStatus {}", e.code()),
        )),
    }
}

fn lookup_item_ref(
    keychain_or_array: CFTypeRef,
    service: &str,
    account: Option<&str>,
) -> LookupRef {
    let Ok(service_len) = u32::try_from(service.len()) else {
        return LookupRef::Unavailable;
    };
    let (account_len, account_ptr) = match account {
        Some(value) => match u32::try_from(value.len()) {
            Ok(len) => (len, value.as_ptr().cast::<c_char>()),
            Err(_) => return LookupRef::Unavailable,
        },
        None => (0, std::ptr::null()),
    };
    let mut item_ref: SecKeychainItemRef = std::ptr::null();
    let status = unsafe {
        SecKeychainFindGenericPassword(
            keychain_or_array,
            service_len,
            service.as_ptr().cast::<c_char>(),
            account_len,
            account_ptr,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut item_ref,
        )
    };
    if status == ERR_SEC_ITEM_NOT_FOUND {
        return LookupRef::Missing;
    }
    if status != ERR_SEC_SUCCESS || item_ref.is_null() {
        return LookupRef::Unavailable;
    }
    LookupRef::Found(CfGuard(item_ref))
}

pub(super) fn item_allows_security_cli_without_prompt(item_ref: SecKeychainItemRef) -> bool {
    if item_ref.is_null() {
        return false;
    }
    let mut access_ref: SecAccessRef = std::ptr::null();
    if unsafe { SecKeychainItemCopyAccess(item_ref, &mut access_ref) } != ERR_SEC_SUCCESS
        || access_ref.is_null()
    {
        return false;
    }
    let _access_guard = CfGuard(access_ref);

    let mut acl_list: CFArrayRef = std::ptr::null();
    if unsafe { SecAccessCopyACLList(access_ref, &mut acl_list) } != ERR_SEC_SUCCESS
        || acl_list.is_null()
    {
        return false;
    }
    let _acl_list_guard = CfGuard(acl_list);

    let mut security_cli_decrypt_allowed = false;
    let mut saw_partition_acl = false;
    let mut apple_tool_partition = false;

    let acl_count = unsafe { CFArrayGetCount(acl_list) };
    for idx in 0..acl_count {
        let acl = unsafe { CFArrayGetValueAtIndex(acl_list, idx) };
        if acl.is_null() {
            continue;
        }
        let auths_ref = unsafe { SecACLCopyAuthorizations(acl) };
        if auths_ref.is_null() {
            continue;
        }
        let _auths_guard = CfGuard(auths_ref);
        let auths = cf_string_array_to_vec(auths_ref);
        let has_decrypt = auths.iter().any(|s| s == "ACLAuthorizationDecrypt");
        let has_partition = auths.iter().any(|s| s == "ACLAuthorizationPartitionID");
        if !has_decrypt && !has_partition {
            continue;
        }

        let mut app_list: CFArrayRef = std::ptr::null();
        let mut description: CFStringRef = std::ptr::null();
        let mut prompt_selector: u16 = 0;
        let content_status = unsafe {
            SecACLCopyContents(acl, &mut app_list, &mut description, &mut prompt_selector)
        };
        let _app_list_guard = CfGuard(app_list);
        let _desc_guard = CfGuard(description);
        if content_status != ERR_SEC_SUCCESS {
            continue;
        }

        if has_partition {
            saw_partition_acl = true;
            if let Some(desc_text) = cf_string_to_string(description) {
                if partition_description_includes_apple_tool(&desc_text) {
                    apple_tool_partition = true;
                }
            }
        }

        if has_decrypt
            && (prompt_selector & K_SEC_KEYCHAIN_PROMPT_REQUIRE_PASSPHRASE) == 0
            && (app_list.is_null() || trusted_app_list_contains_security_cli(app_list))
        {
            security_cli_decrypt_allowed = true;
        }
    }

    security_cli_decrypt_allowed && (!saw_partition_acl || apple_tool_partition)
}

fn trusted_app_list_contains_security_cli(app_list: CFArrayRef) -> bool {
    let count = unsafe { CFArrayGetCount(app_list) };
    for idx in 0..count {
        let app = unsafe { CFArrayGetValueAtIndex(app_list, idx) };
        if app.is_null() {
            continue;
        }
        let mut data_ref: CFDataRef = std::ptr::null();
        if unsafe { SecTrustedApplicationCopyData(app, &mut data_ref) } != ERR_SEC_SUCCESS
            || data_ref.is_null()
        {
            continue;
        }
        let _data_guard = CfGuard(data_ref);
        let len = unsafe { CFDataGetLength(data_ref) };
        let ptr = unsafe { CFDataGetBytePtr(data_ref) };
        if len <= 0 || ptr.is_null() {
            continue;
        }
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
        let trimmed = bytes.strip_suffix(b"\0").unwrap_or(bytes);
        if trimmed == SECURITY_CLI_PATH.as_bytes() {
            return true;
        }
    }
    false
}

fn cf_string_array_to_vec(array: CFArrayRef) -> Vec<String> {
    let count = unsafe { CFArrayGetCount(array) };
    let mut out = Vec::with_capacity(count.max(0) as usize);
    for idx in 0..count {
        let item = unsafe { CFArrayGetValueAtIndex(array, idx) };
        if let Some(value) = cf_string_to_string(item) {
            out.push(value);
        }
    }
    out
}

fn cf_string_to_string(string_ref: CFStringRef) -> Option<String> {
    if string_ref.is_null() {
        return None;
    }
    let utf16_len = unsafe { CFStringGetLength(string_ref) };
    let max_bytes =
        unsafe { CFStringGetMaximumSizeForEncoding(utf16_len, K_CF_STRING_ENCODING_UTF8) } + 1;
    if max_bytes <= 0 || max_bytes > 256 * 1024 {
        return None;
    }
    let mut buf = vec![0u8; max_bytes as usize];
    let ok = unsafe {
        CFStringGetCString(
            string_ref,
            buf.as_mut_ptr().cast::<c_char>(),
            max_bytes,
            K_CF_STRING_ENCODING_UTF8,
        )
    };
    if ok == 0 {
        return None;
    }
    let nul_pos = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..nul_pos].to_vec()).ok()
}

pub(super) fn partition_description_includes_apple_tool(desc: &str) -> bool {
    let trimmed = desc.trim();
    if !trimmed.is_empty()
        && trimmed.len().is_multiple_of(2)
        && trimmed.bytes().all(|b| b.is_ascii_hexdigit())
    {
        if let Ok(decoded) = decode_hex(trimmed.as_bytes()) {
            if let Ok(xml) = std::str::from_utf8(&decoded) {
                return xml.contains("<string>apple-tool:</string>");
            }
        }
    }
    trimmed.contains("<string>apple-tool:</string>")
        || trimmed.split(',').any(|part| part.trim() == "apple-tool:")
}

pub(super) fn read_via_security_cli(
    keychain_path: Option<&Path>,
    service: &str,
    account: Option<&str>,
) -> std::result::Result<Option<Vec<u8>>, ()> {
    if service.is_empty()
        || service.starts_with('-')
        || account.is_some_and(|a| a.is_empty() || a.starts_with('-'))
    {
        return Err(());
    }
    let mut cmd = Command::new(SECURITY_CLI_PATH);
    cmd.arg("find-generic-password")
        .arg("-g")
        .arg("-s")
        .arg(service);
    if let Some(account) = account {
        cmd.arg("-a").arg(account);
    }
    if let Some(path) = keychain_path {
        cmd.arg(path);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|_| ())?;
    let mut stderr = child.stderr.take().ok_or(())?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let cap = (MAX_RECORD_BYTES * 4 + 4096) as u64;
        stderr
            .by_ref()
            .take(cap)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });

    let deadline = Instant::now() + SECURITY_CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err(());
            }
        }
    };

    let stderr_bytes = reader.join().map_err(|_| ())?.map_err(|_| ())?;
    if status.code() == Some(44) {
        return Ok(None);
    }
    if !status.success() {
        return Err(());
    }
    parse_security_cli_stderr(&stderr_bytes).map(Some)
}

pub(super) fn parse_security_cli_stderr(stderr: &[u8]) -> std::result::Result<Vec<u8>, ()> {
    for raw_line in stderr.split(|&b| b == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        let Some(rest) = line.strip_prefix(b"password: ") else {
            continue;
        };
        if rest.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(after_hex) = rest.strip_prefix(b"0x") {
            let hex_len = after_hex
                .iter()
                .take_while(|b| b.is_ascii_hexdigit())
                .count();
            if hex_len == 0
                || !hex_len.is_multiple_of(2)
                || (hex_len < after_hex.len() && after_hex[hex_len] != b' ')
            {
                return Err(());
            }
            return decode_hex(&after_hex[..hex_len]);
        }
        if rest.len() >= 2 && rest[0] == b'"' && rest[rest.len() - 1] == b'"' {
            return Ok(rest[1..rest.len() - 1].to_vec());
        }
        return Err(());
    }
    Err(())
}

fn decode_hex(hex: &[u8]) -> std::result::Result<Vec<u8>, ()> {
    if !hex.len().is_multiple_of(2) {
        return Err(());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for pair in hex.chunks_exact(2) {
        let hi = hex_nibble(pair[0]).ok_or(())?;
        let lo = hex_nibble(pair[1]).ok_or(())?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
pub(super) fn inspect_keychain_file_acl_allows_security_cli(
    keychain_path: &Path,
    service: &str,
    account: Option<&str>,
) -> Option<bool> {
    let c_path = std::ffi::CString::new(keychain_path.to_str()?).ok()?;
    let mut kc_ref: SecKeychainRef = std::ptr::null();
    if unsafe { SecKeychainOpen(c_path.as_ptr(), &mut kc_ref) } != ERR_SEC_SUCCESS
        || kc_ref.is_null()
    {
        return None;
    }
    let _kc_guard = CfGuard(kc_ref);
    match lookup_item_ref(kc_ref, service, account) {
        LookupRef::Found(item_ref) => Some(item_allows_security_cli_without_prompt(item_ref.0)),
        LookupRef::Missing | LookupRef::Unavailable => None,
    }
}
