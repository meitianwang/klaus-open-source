//! Narrow credential storage and local import capabilities. Authentication belongs to TypeScript.

mod antigravity;
mod cursor;
mod mcp;
mod qoder;
mod qoderwork;
mod qwenwork;
mod service;
mod workbuddy;

pub use mcp::McpKey;
pub use service::{Action, CredentialService, Ticket};
pub use workbuddy::WorkBuddyRegion;

use crate::{NativeError, Result};
use serde_json::{json, Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const MAX_RECORD_BYTES: usize = 1024 * 1024;
static TRANSACTION: Mutex<()> = Mutex::new(());
static TEMP_SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
    Unsupported,
}

/// Product credential namespaces: `agent-engine`, optionally followed by
/// lowercase alphanumeric `-segments`, at most 64 bytes. Each desktop edition
/// owns one namespace; anything outside this family is refused.
pub fn is_product_keychain_service(service: &str) -> bool {
    const ROOT: &str = "agent-engine";
    if service.len() > 64 {
        return false;
    }
    let Some(rest) = service.strip_prefix(ROOT) else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    let Some(segments) = rest.strip_prefix('-') else {
        return false;
    };
    segments.split('-').all(|segment| {
        !segment.is_empty()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

#[derive(Clone, Debug)]
pub struct CredentialConfig {
    pub config_root: PathBuf,
    pub user_home: PathBuf,
    pub platform: Platform,
    pub qoder_state_db: Option<PathBuf>,
    pub keychain_service: String,
}

impl CredentialConfig {
    /// Capture trusted main-process environment once; renderer input cannot select identities.
    pub fn from_environment(config_root: PathBuf, user_home: PathBuf) -> Result<Self> {
        let env = |key| std::env::var(key).ok();
        let config = Self {
            config_root,
            user_home,
            platform: if cfg!(target_os = "macos") {
                Platform::MacOs
            } else if cfg!(target_os = "linux") {
                Platform::Linux
            } else if cfg!(target_os = "windows") {
                Platform::Windows
            } else {
                Platform::Unsupported
            },
            keychain_service: "agent-engine".into(),
            qoder_state_db: env("QODER_IDE_STATE_DB")
                .filter(|s| !s.trim().is_empty())
                .map(|s| PathBuf::from(s.trim())),
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if !self.config_root.is_absolute() || !self.user_home.is_absolute() {
            return Err(error("INVALID_PATH"));
        }
        if !is_product_keychain_service(&self.keychain_service) {
            return Err(error("INVALID_KEYCHAIN_SERVICE"));
        }
        Ok(())
    }

    /// Klaus's own copy of the Claude subscription credential.
    ///
    /// A private owner-only file, the same carrier the Codex subscription uses,
    /// and deliberately NOT the login keychain: the ecosystem entry is named
    /// after the Claude Code client, so reading it makes macOS ask the user to
    /// authorize THIS app against another product's secret — again on every
    /// refused read, which turned background status polls into a prompt loop.
    /// A copy Klaus owns needs no authorization from anyone.
    pub fn subscription_path(&self) -> PathBuf {
        self.config_root.join("claude-subscription-oauth.json")
    }

    /// The pre-copy carrier some profiles still hold a login in: the plaintext
    /// record file older builds fell back to when the keychain refused a write.
    /// Read as a migration source only, never written.
    fn legacy_plaintext_path(&self) -> PathBuf {
        self.config_root.join(".credentials.json")
    }

    fn qoder_path(&self) -> PathBuf {
        self.qoder_state_db.clone().unwrap_or_else(|| {
            let root = if self.platform == Platform::MacOs {
                self.user_home.join("Library/Application Support/Qoder")
            } else {
                self.user_home.join(".config/Qoder")
            };
            root.join("User/globalStorage/state.vscdb")
        })
    }
}

pub trait Keychain: Send + Sync + 'static {
    fn read(&self, service: &str, account: Option<&str>) -> Result<Option<Vec<u8>>>;
    fn write(&self, service: &str, account: &str, bytes: &[u8]) -> Result<()>;
    fn delete(&self, service: &str, account: &str) -> Result<()>;
}

pub struct SystemKeychain;

#[cfg(target_os = "macos")]
impl Keychain for SystemKeychain {
    fn read(&self, service: &str, account: Option<&str>) -> Result<Option<Vec<u8>>> {
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
            Err(e) if e.code() == -25300 => Ok(None),
            Err(e) => Err(NativeError::new(
                "credential_keychain_denied",
                format!("OSStatus {}", e.code()),
            )),
        }
    }

    fn write(&self, service: &str, account: &str, bytes: &[u8]) -> Result<()> {
        security_framework::passwords::set_generic_password(service, account, bytes).map_err(|e| {
            NativeError::new(
                "credential_keychain_denied",
                format!("OSStatus {}", e.code()),
            )
        })
    }

    fn delete(&self, service: &str, account: &str) -> Result<()> {
        match security_framework::passwords::delete_generic_password(service, account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(e) => Err(NativeError::new(
                "credential_keychain_denied",
                format!("OSStatus {}", e.code()),
            )),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl Keychain for SystemKeychain {
    fn read(&self, _service: &str, _account: Option<&str>) -> Result<Option<Vec<u8>>> {
        Err(error("credential_keychain_platform_unsupported"))
    }
    fn write(&self, _service: &str, _account: &str, _bytes: &[u8]) -> Result<()> {
        Err(error("credential_keychain_platform_unsupported"))
    }
    fn delete(&self, _service: &str, _account: &str) -> Result<()> {
        Err(error("credential_keychain_platform_unsupported"))
    }
}

pub struct CredentialStore {
    config: CredentialConfig,
    keychain: Arc<dyn Keychain>,
}

impl CredentialStore {
    pub fn new(config: CredentialConfig, keychain: Arc<dyn Keychain>) -> Result<Self> {
        config.validate()?;
        Ok(Self { config, keychain })
    }

    pub fn system(config_root: PathBuf, user_home: PathBuf) -> Result<Self> {
        Self::new(
            CredentialConfig::from_environment(config_root, user_home)?,
            Arc::new(SystemKeychain),
        )
    }

    pub fn system_with_keychain_service(
        config_root: PathBuf,
        user_home: PathBuf,
        keychain_service: String,
    ) -> Result<Self> {
        let mut config = CredentialConfig::from_environment(config_root, user_home)?;
        config.keychain_service = keychain_service;
        Self::new(config, Arc::new(SystemKeychain))
    }

    /// The stored Claude subscription record: Klaus's own copy first, then the
    /// plaintext file older builds fell back to as a migration source. The
    /// legacy file is read, never written.
    fn record(&self) -> Result<Option<Map<String, Value>>> {
        if let Some(record) = read_record_file(&self.config.subscription_path())? {
            return Ok(Some(record));
        }
        match read_record_file(&self.config.legacy_plaintext_path())? {
            Some(record)
                if record.contains_key("claudeAiOauth") || record.contains_key("tokens") =>
            {
                Ok(Some(record))
            }
            Some(_) | None => Ok(None),
        }
    }

    pub fn read_claude_oauth(&self) -> Value {
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        match self.record() {
            Ok(record) => {
                let value = record
                    .and_then(|mut r| {
                        r.remove("claudeAiOauth").or_else(|| {
                            r.remove("tokens").filter(|v| {
                                v.get("accessToken")
                                    .and_then(Value::as_str)
                                    .is_some_and(|s| !s.is_empty())
                            })
                        })
                    })
                    .unwrap_or(Value::Null);
                json!({"value": value})
            }
            Err(e) => json!({"value": null, "error": e.code}),
        }
    }

    /// The stored Claude subscription as an account queue, head first. The
    /// file's `accounts` array is authoritative; a file that still carries the
    /// historical single `claudeAiOauth` key reads as one legacy account
    /// without being rewritten. Accounts without an access token are dropped.
    pub fn read_claude_accounts(&self) -> Value {
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        match self.record() {
            Ok(record) => {
                let accounts = record.map(claude_accounts_of).unwrap_or_default();
                json!({"accounts": accounts})
            }
            Err(e) => json!({"accounts": [], "error": e.code}),
        }
    }

    /// Persist the account queue. The payload is the full `accounts` array;
    /// the write takes the cross-process directory lock the engine's rotation
    /// writer uses, so a rotation reorder and a host append cannot lose each
    /// other.
    pub fn write_claude_accounts(&self, accounts: Value) -> Value {
        let accounts = match accounts.as_array() {
            Some(accounts) if accounts.len() <= 32 => accounts.clone(),
            _ => return json!({"success": false, "error": "invalid_claude_credential"}),
        };
        if accounts
            .iter()
            .any(|entry| !entry.is_object() || entry.to_string().len() > MAX_RECORD_BYTES / 4)
        {
            return json!({"success": false, "error": "invalid_claude_credential"});
        }
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        let write = || -> Result<()> {
            let path = self.config.subscription_path();
            let lock_dir = self
                .config
                .config_root
                .join(".locks")
                .join("claude-accounts-rotation.lock");
            with_account_lock(&lock_dir, || {
                let mut record = read_record_file(&path)?.unwrap_or_default();
                record.insert("accounts".into(), Value::Array(accounts.clone()));
                atomic_write(&path, &serialize_record(&record)?)?;
                Ok(())
            })?;
            // The legacy file is a migration source; a login key left in it
            // would resurrect after a later logout.
            let _ = self.prune_legacy_login();
            Ok(())
        };
        match write() {
            Ok(()) => json!({"success": true}),
            Err(e) => json!({"success": false, "error": e.code}),
        }
    }

    pub fn write_claude_oauth(&self, tokens: Value) -> Value {
        if !tokens.is_object() || tokens.to_string().len() > MAX_RECORD_BYTES / 2 {
            return json!({"success": false, "error": "invalid_claude_credential"});
        }
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        let write = || -> Result<()> {
            let mut record = self.record()?.unwrap_or_default();
            record.insert("claudeAiOauth".into(), tokens);
            atomic_write(
                &self.config.subscription_path(),
                &serialize_record(&record)?,
            )?;
            // The legacy file is a migration source; a login key left in it
            // would resurrect after a later logout.
            let _ = self.prune_legacy_login();
            Ok(())
        };
        match write() {
            Ok(()) => json!({"success": true}),
            Err(e) => json!({"success": false, "error": e.code}),
        }
    }

    pub fn remove_claude_oauth(&self) -> bool {
        let _transaction = TRANSACTION.lock().unwrap_or_else(|p| p.into_inner());
        let copy = self.prune_file_login(&self.config.subscription_path());
        let legacy = self.prune_legacy_login();
        match (copy, legacy) {
            (Ok(copy), Ok(legacy)) => copy || legacy,
            (Ok(copy), Err(_)) => copy,
            (Err(_), _) => false,
        }
    }

    /// Remove the login keys from the legacy plaintext file, deleting it when
    /// nothing else lives in it. A corrupted legacy file is reported, not
    /// silently skipped: the caller decides how much it blocks.
    fn prune_legacy_login(&self) -> Result<bool> {
        self.prune_file_login(&self.config.legacy_plaintext_path())
    }

    fn prune_file_login(&self, path: &Path) -> Result<bool> {
        let Some(mut record) = read_record_file(path)? else {
            return Ok(false);
        };
        if !prune_oauth(&mut record) {
            return Ok(false);
        }
        if record.is_empty() {
            fs::remove_file(path).map_err(|_| error("credential_file_write_failed"))?;
        } else {
            atomic_write(path, &serialize_record(&record)?)?;
        }
        Ok(true)
    }

    pub fn read_local_claude_credential(&self) -> Value {
        let local = self.config.user_home.join(".claude/.credentials.json");
        match read_optional(&local) {
            Ok(Some(bytes)) => match String::from_utf8(bytes) {
                Ok(raw) => return json!({"present": true, "raw": raw}),
                Err(_) => {
                    return json!({"present": true, "error": "local_claude_credential_unreadable"})
                }
            },
            Err(e) => return json!({"present": true, "error": e.code}),
            Ok(None) => {}
        }
        if self.config.platform != Platform::MacOs {
            return json!({"present": false});
        }
        match self.keychain.read("Claude Code-credentials", None) {
            Ok(Some(bytes)) => match parse_record(&bytes) {
                Ok(record) => json!({"present": true, "raw": Value::Object(record).to_string()}),
                Err(_) => json!({"present": true, "error": "local_claude_credential_unreadable"}),
            },
            Ok(None) => json!({"present": false}),
            Err(e) => json!({"present": true, "error": e.code}),
        }
    }

    pub fn read_qoder_ide_credential(&self) -> Value {
        qoder::read(
            &self.config.qoder_path(),
            self.config.platform,
            self.keychain.as_ref(),
        )
    }

    pub fn read_antigravity_keychain_secret(&self) -> Value {
        antigravity::read_secret(self.keychain.as_ref())
    }

    pub fn read_cursor_credential(&self) -> Value {
        cursor::read(&self.config.user_home, self.config.platform)
    }

    pub fn read_qoderwork_credential(&self) -> Value {
        qoderwork::read(
            &self.config.user_home,
            self.config.platform,
            self.keychain.as_ref(),
        )
    }

    pub fn read_qwenwork_credential(&self) -> Value {
        qwenwork::read(
            &self.config.user_home,
            self.config.platform,
            self.keychain.as_ref(),
        )
    }

    /// A login WorkBuddy AI already holds.
    ///
    /// No keychain read: WorkBuddy keeps its key inside its own Electron binary,
    /// so the decryption is delegated to that binary rather than reproduced here.
    pub fn read_workbuddy_credential(&self, region: Option<WorkBuddyRegion>) -> Value {
        workbuddy::read(&self.config.user_home, self.config.platform, region)
    }
}

pub(super) fn error(code: &'static str) -> NativeError {
    NativeError::new(code, code)
}

fn prune_oauth(record: &mut Map<String, Value>) -> bool {
    let a = record.remove("claudeAiOauth").is_some();
    let b = record.remove("tokens").is_some();
    a || b
}

/// Project a stored Claude record onto its account queue, head first. The
/// `accounts` array is authoritative; the historical single `claudeAiOauth`
/// key reads as one legacy account so older profiles keep working until their
/// next write rewrites the file in the new shape.
fn claude_accounts_of(record: Map<String, Value>) -> Vec<Value> {
    if let Some(accounts) = record.get("accounts").and_then(Value::as_array) {
        return accounts
            .iter()
            .filter(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
                    && entry
                        .pointer("/tokens/accessToken")
                        .and_then(Value::as_str)
                        .is_some_and(|token| !token.is_empty())
            })
            .cloned()
            .collect();
    }
    let mut tokens = record.get("claudeAiOauth").and_then(Value::as_object);
    if tokens.is_none() {
        // A bare tokens record (no wrapper key) is the oldest spelling; treat
        // the record itself as the token set.
        tokens = record
            .get("accessToken")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(|_| &record);
    }
    match tokens {
        Some(tokens)
            if tokens
                .get("accessToken")
                .and_then(Value::as_str)
                .is_some_and(|token| !token.is_empty()) =>
        {
            vec![json!({ "id": "legacy", "tokens": Value::Object(tokens.clone()) })]
        }
        _ => Vec::new(),
    }
}

/// Cross-process directory lock shared with the engine's rotation writer:
/// `mkdir` is atomic, a stale lock older than two minutes is reclaimed, and
/// the holder refreshes nothing (the critical section is a single file
/// rewrite).
fn with_account_lock<T>(lock_dir: &Path, run: impl FnOnce() -> Result<T>) -> Result<T> {
    if let Some(parent) = lock_dir.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        match fs::create_dir(lock_dir) {
            Ok(()) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(error("credential_file_write_failed")),
        }
        let stale = fs::metadata(lock_dir)
            .and_then(|meta| meta.modified())
            .map(|modified| {
                std::time::SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or_default()
                    > std::time::Duration::from_secs(120)
            })
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_dir(lock_dir);
            continue;
        }
        if std::time::Instant::now() >= deadline {
            return Err(error("credential_file_write_failed"));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let result = run();
    let _ = fs::remove_dir(lock_dir);
    result
}

fn serialize_record(record: &Map<String, Value>) -> Result<Vec<u8>> {
    let bytes = Value::Object(record.clone()).to_string().into_bytes();
    if bytes.len() > MAX_RECORD_BYTES {
        Err(error("credential_record_too_large"))
    } else {
        Ok(bytes)
    }
}

pub fn parse_record(bytes: &[u8]) -> Result<Map<String, Value>> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(error("credential_record_too_large"));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| error("credential_record_unreadable"))?
        .trim_matches('\0')
        .trim();
    if let Ok(Value::Object(record)) = serde_json::from_str(text) {
        return Ok(record);
    }
    if !text.is_empty()
        && text.len().is_multiple_of(2)
        && text.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let decoded: Vec<u8> = (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex checked"))
            .collect();
        if let Ok(s) = std::str::from_utf8(&decoded) {
            if let Ok(Value::Object(record)) = serde_json::from_str(s.trim_matches('\0').trim()) {
                return Ok(record);
            }
        }
    }
    Err(error("credential_record_unreadable"))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("credential_file_read_failed")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("credential_file_read_failed"))?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(error("credential_record_too_large"));
    }
    Ok(Some(bytes))
}

/// One credential file as a record, or None when the file is simply absent.
fn read_record_file(path: &Path) -> Result<Option<Map<String, Value>>> {
    match read_optional(path)? {
        Some(bytes) => parse_record(&bytes).map(Some),
        None => Ok(None),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| error("INVALID_PATH"))?;
    fs::create_dir_all(parent).map_err(|_| error("credential_file_write_failed"))?;
    let tmp = parent.join(format!(
        ".credentials-{}-{}.tmp",
        std::process::id(),
        TEMP_SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|_| error("credential_file_write_failed"))?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|_| error("credential_file_write_failed"))
}

/// This backend is absent from release builds unless a separate fixture feature is selected.
#[cfg(any(test, feature = "credential-fixtures"))]
#[derive(Default)]
pub struct FixtureKeychain {
    entries: Mutex<std::collections::HashMap<(String, String), Vec<u8>>>,
}

#[cfg(any(test, feature = "credential-fixtures"))]
impl Keychain for FixtureKeychain {
    fn read(&self, service: &str, account: Option<&str>) -> Result<Option<Vec<u8>>> {
        let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        Ok(entries
            .iter()
            .find(|((s, a), _)| s == service && account.is_none_or(|expected| expected == a))
            .map(|(_, bytes)| bytes.clone()))
    }
    fn write(&self, service: &str, account: &str, bytes: &[u8]) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert((service.into(), account.into()), bytes.to_vec());
        Ok(())
    }
    fn delete(&self, service: &str, account: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&(service.into(), account.into()));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
