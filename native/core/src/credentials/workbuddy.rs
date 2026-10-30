//! Reading a login WorkBuddy AI already has.
//!
//! WorkBuddy encrypts its credential fields with a key that is compiled into its
//! OWN fork of Electron and reachable only through a private binding
//! (`workbuddyStorage.loggerGet`) — it is not in the macOS keychain, unlike the
//! Qoder and QwenWork stores. Reproducing that decryption inside Klaus would mean
//! extracting Tencent's build-time key and baking it into this repository, where
//! it would silently break the day they rotate it.
//!
//! So the decryption is delegated: Klaus spawns WorkBuddy's own Electron in
//! `ELECTRON_RUN_AS_NODE` mode with a fixed read-only script, and that process
//! answers with the plaintext tokens. Two properties follow from this, and both
//! are deliberate:
//!
//!   * No WorkBuddy key material ever enters Klaus's source, binary or logs.
//!   * Reusing the local login requires WorkBuddy AI to be installed — which it
//!     has to be anyway, since that install is where the login lives.
//!
//! The script is a compile-time constant and takes its inputs from the
//! ENVIRONMENT, never from string interpolation: a path containing a quote or a
//! newline would otherwise be executable code inside the child.

use super::Platform;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// How long the delegated decrypt may take. Electron's cold start dominates; the
/// crypto itself is microseconds.
const DECRYPT_TIMEOUT: Duration = Duration::from_secs(25);
/// Bound on what the child may say. The real answer is ~2.5 KB of JSON.
const MAX_CHILD_STDOUT: usize = 64 * 1024;

const UNREADABLE: &str = "workbuddy_local_secret_unreadable";

/// Legacy callers without an edition retain the international-first discovery order.
const AUTH_IDS: [&str; 2] = ["workbuddy-desktop-ai", "workbuddy-desktop"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkBuddyRegion {
    Cn,
    Intl,
}

impl WorkBuddyRegion {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "cn" => Some(Self::Cn),
            "intl" => Some(Self::Intl),
            _ => None,
        }
    }

    fn auth_id(self) -> &'static str {
        match self {
            Self::Cn => "workbuddy-desktop",
            Self::Intl => "workbuddy-desktop-ai",
        }
    }

    fn metadata(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Cn => ("cn", "workbuddy", "www.codebuddy.cn"),
            Self::Intl => ("intl", "workbuddy-ai", "www.workbuddy.ai"),
        }
    }
}

/// Read-only decryption, run inside WorkBuddy's own Electron.
///
/// Reproduces exactly what the official client does to its own file: derive the
/// at-rest protector key from the build-time payload, then open each field
/// envelope with AES-256-GCM under the framing the client uses for credential
/// fields. It prints ONE JSON object and exits; it never writes, never touches
/// the network, and never prints the key.
const DECRYPT_SCRIPT: &str = r#"
// `-e` evaluates this as a SCRIPT, where a top-level `return` is a syntax
// error, so the whole body lives in one immediately-invoked function.
(function () {
const crypto = require('crypto');
const fs = require('fs');
const fail = (error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
  process.exit(0);
};
let binding;
try {
  binding = process._linkedBinding('electron_browser_workbuddy_storage');
} catch (error) {
  return fail('no_workbuddy_storage_binding');
}
if (!binding || typeof binding.loggerGet !== 'function') return fail('no_workbuddy_storage_binding');
let payload;
try {
  payload = JSON.parse(binding.loggerGet());
} catch (error) {
  return fail('key_payload_unreadable');
}
if (typeof payload.atRestSecretKey !== 'string' || !payload.atRestSecretKey) {
  return fail('key_payload_unreadable');
}
// The client's own key derivation: sha256 over the base64 TEXT of the secret.
const key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

// AAD framing, byte for byte as the client's at-rest library builds it for a
// credential FIELD: domain, version, format id, scheme, suite, key id, framing
// code, absent sequence, absent final flag.
const enc32 = (n) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; };
const lp = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([enc32(b.length), b]); };
const aad = (id, suite) => Buffer.concat([
  Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'),
  enc32(suite), lp(id), Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
]);

let raw;
try {
  raw = fs.readFileSync(process.env.KLAUS_WORKBUDDY_AUTH_FILE, 'utf8');
} catch (error) {
  return fail('state_unreadable');
}
let stored;
try {
  stored = JSON.parse(raw);
} catch (error) {
  return fail('state_unparseable');
}
const open = (field) => {
  if (typeof field !== 'object' || field === null) return undefined;
  if (typeof field === 'string') return field;
  if (field.$wbEncrypted !== 1 || typeof field.envelope !== 'string') return undefined;
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
  } catch (error) {
    return undefined;
  }
  if (!envelope || typeof envelope.keyId !== 'string') return undefined;
  if (envelope.keyId !== keyId) return undefined;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 },
    );
    decipher.setAAD(aad(envelope.keyId, envelope.suite ?? 1));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    return undefined;
  }
};

const auth = stored.auth || {};
const account = stored.account || {};
const accessToken = open(auth.accessToken);
if (!accessToken) return fail('not_signed_in');
const out = {
  ok: true,
  keyId,
  accessToken,
  refreshToken: open(auth.refreshToken) || undefined,
  nickname: open(account.nickname) || undefined,
  expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : undefined,
  refreshExpiresAt: typeof auth.refreshExpiresAt === 'number' ? auth.refreshExpiresAt : undefined,
  tokenType: typeof auth.tokenType === 'string' ? auth.tokenType : undefined,
  domain: typeof auth.domain === 'string' ? auth.domain : undefined,
  scope: typeof auth.scope === 'string' ? auth.scope : undefined,
  uid: typeof account.uid === 'string' ? account.uid : undefined,
  uin: typeof account.uin === 'string' ? account.uin : undefined,
  type: typeof account.type === 'string' ? account.type : undefined,
  enterpriseId: typeof account.enterpriseId === 'string' ? account.enterpriseId : undefined,
};
process.stdout.write(JSON.stringify(out));
process.exit(0);
})();
"#;

struct Candidate {
    auth_file: PathBuf,
    electron: PathBuf,
    region: WorkBuddyRegion,
}

pub(super) fn read(home: &Path, platform: Platform, region: Option<WorkBuddyRegion>) -> Value {
    if platform == Platform::Unsupported {
        return json!({"present": false});
    }
    read_candidates(candidates(home, platform, region))
}

/// Consume a discovered candidate list. Split out from [`read`] so the discovery
/// step — which probes the real filesystem for an installed app — stays out of the
/// unit tests, and so a machine that happens to have WorkBuddy installed cannot
/// change what these tests assert.
fn read_candidates(candidates: Vec<Candidate>) -> Value {
    // Two independent facts decide the answer, and conflating them would make an
    // uninstall read as a broken login:
    //   * a runtime — WorkBuddy AI is installed at all;
    //   * a store file — somebody has logged in with it.
    let installed = !candidates.is_empty();
    let mut candidates = candidates;
    candidates.retain(|candidate| candidate.auth_file.exists());
    if candidates.is_empty() {
        // `present` follows the INSTALL, matching the other local-import readers:
        // "nothing to import" and "the app is not here" are different sentences to
        // a user, and only the first one is actionable from Klaus's side.
        return json!({"present": installed});
    }
    let mut last_error = "workbuddy_local_runtime_missing";
    for candidate in &candidates {
        match decrypt_with_runtime(candidate) {
            Ok(mut credential) => {
                let (region, platform, domain) = candidate.region.metadata();
                let user_info = &mut credential["userInfo"];
                user_info["region"] = json!(region);
                user_info["platform"] = json!(platform);
                if text(user_info, "domain").is_none() {
                    user_info["domain"] = json!(domain);
                }
                return json!({
                    "present": true,
                    "userInfo": credential["userInfo"].clone(),
                    "machineId": credential["machineId"].clone(),
                });
            }
            Err(error) => last_error = error,
        }
    }
    json!({"present": true, "error": last_error})
}

/// Where each shipping variant keeps its store, and the Electron that can open it.
fn candidates(home: &Path, platform: Platform, region: Option<WorkBuddyRegion>) -> Vec<Candidate> {
    let Some(store_dir) = store_dir(home, platform) else {
        return Vec::new();
    };
    AUTH_IDS
        .iter()
        .filter(|id| region.is_none_or(|region| **id == region.auth_id()))
        .filter_map(|id| {
            Some(Candidate {
                auth_file: store_dir.join(format!("{id}.info")),
                electron: runtime_path(home, platform, id)?,
                region: if *id == WorkBuddyRegion::Cn.auth_id() {
                    WorkBuddyRegion::Cn
                } else {
                    WorkBuddyRegion::Intl
                },
            })
        })
        .collect()
}

/// WorkBuddy shares one credential directory across its variants, under the
/// CodeBuddy extension data root. The spelling differs per platform exactly as
/// the client's own path service does.
fn store_dir(home: &Path, platform: Platform) -> Option<PathBuf> {
    let root = match platform {
        Platform::MacOs => home.join("Library/Application Support/CodeBuddyExtension"),
        Platform::Windows => {
            let app_data = std::env::var("LOCALAPPDATA").ok()?;
            PathBuf::from(app_data).join("CodeBuddyExtension")
        }
        Platform::Linux => home.join(".local/share/CodeBuddyExtension"),
        Platform::Unsupported => return None,
    };
    Some(root.join("Data/Public/auth"))
}

/// The Electron binary whose private binding can open the store.
///
/// Located through the installed app rather than guessed, because the binary name
/// is the app's own and changes between the two variants.
fn runtime_path(home: &Path, platform: Platform, auth_id: &str) -> Option<PathBuf> {
    // A test-only seam. The child is spawned as a process, so the real path can
    // only be exercised against an actually installed WorkBuddy — which makes the
    // spawn/read/parse/project chain untestable on a machine without it. A stand-in
    // binary covers that chain deterministically. It is `cfg(test)` on purpose: a
    // shipped build must never let an environment variable redirect this to an
    // arbitrary binary.
    #[cfg(test)]
    if let Ok(value) = std::env::var("KLAUS_WORKBUDDY_TEST_RUNTIME") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let app_name = if auth_id == "workbuddy-desktop" {
        "WorkBuddy"
    } else {
        "WorkBuddy AI"
    };
    let candidates: Vec<PathBuf> = match platform {
        Platform::MacOs => vec![
            PathBuf::from(format!(
                "/Applications/{app_name}.app/Contents/MacOS/Electron"
            )),
            home.join(format!(
                "Applications/{app_name}.app/Contents/MacOS/Electron"
            )),
        ],
        Platform::Windows => {
            let mut roots = Vec::new();
            for key in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
                if let Ok(value) = std::env::var(key) {
                    if !value.trim().is_empty() {
                        roots.push(PathBuf::from(value));
                    }
                }
            }
            roots
                .into_iter()
                .map(|root| root.join(app_name).join(format!("{app_name}.exe")))
                .collect()
        }
        Platform::Linux => vec![
            PathBuf::from(format!("/opt/{app_name}/{app_name}")),
            PathBuf::from(format!("/usr/bin/{app_name}")),
        ],
        Platform::Unsupported => return None,
    };
    candidates.into_iter().find(|path| path.is_file())
}

/// The environment variable the fixed script reads its target from.
const AUTH_FILE_ENV: &str = "KLAUS_WORKBUDDY_AUTH_FILE";

/// Build the child command: WorkBuddy's own Electron, running the fixed script as
/// plain Node.
///
/// Two invariants live here and are asserted by the unit tests:
///   * `ELECTRON_RUN_AS_NODE` is what makes its private storage binding reachable
///     without opening a window;
///   * the store path travels in the ENVIRONMENT, never inside the script text. A
///     path containing a quote or a newline would otherwise be executable code in
///     the child, and that path is not ours — it comes from the machine's layout.
fn spawn_command(candidate: &Candidate) -> Command {
    let mut command = Command::new(&candidate.electron);
    command
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env(AUTH_FILE_ENV, &candidate.auth_file)
        .arg("-e")
        .arg(DECRYPT_SCRIPT);
    command
}

/// Run the fixed script inside WorkBuddy's Electron and project its answer.
fn decrypt_with_runtime(candidate: &Candidate) -> Result<Value, &'static str> {
    let mut child = spawn_command(candidate)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "workbuddy_local_runtime_missing")?;

    let stdout = read_bounded(&mut child, MAX_CHILD_STDOUT)?;
    let status = wait_bounded(child, DECRYPT_TIMEOUT).map_err(|_| UNREADABLE)?;
    if !status.success() {
        return Err("workbuddy_local_runtime_failed");
    }
    let parsed: Value = serde_json::from_slice(&stdout).map_err(|_| UNREADABLE)?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = parsed
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Err(match code {
            "not_signed_in" => "workbuddy_local_not_signed_in",
            "no_workbuddy_storage_binding" | "key_payload_unreadable" => {
                "workbuddy_local_runtime_incompatible"
            }
            _ => UNREADABLE,
        });
    }
    to_klaus_credential(&parsed)
}

/// stdout is bounded independently of the child, so a runaway writer cannot
/// outlive the operation's own deadline.
fn read_bounded(child: &mut std::process::Child, limit: usize) -> Result<Vec<u8>, &'static str> {
    let stdout = child.stdout.take().ok_or(UNREADABLE)?;
    let mut bytes = Vec::new();
    stdout
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| UNREADABLE)?;
    if bytes.len() > limit {
        return Err(UNREADABLE);
    }
    Ok(bytes)
}

/// `Child::wait` has no timeout, so the wait is polled against the deadline; the
/// child is killed rather than orphaned when it overruns.
fn wait_bounded(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, ()> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                return Err(());
            }
        }
    }
}

/// Project the decrypted session onto the shape the engine's `adoptCredential`
/// stores, so no WorkBuddy-specific field naming leaks past this module.
fn to_klaus_credential(decrypted: &Value) -> Result<Value, &'static str> {
    let access_token = text(decrypted, "accessToken").ok_or("workbuddy_local_not_signed_in")?;
    let mut user_info = serde_json::Map::new();
    user_info.insert("access_token".into(), json!(access_token));
    if let Some(refresh) = text(decrypted, "refreshToken") {
        user_info.insert("refresh_token".into(), json!(refresh));
    }
    if let Some(domain) = text(decrypted, "domain") {
        user_info.insert("domain".into(), json!(domain));
    }
    if let Some(uid) = text(decrypted, "uid") {
        user_info.insert("uid".into(), json!(uid));
    }
    if let Some(uin) = text(decrypted, "uin") {
        user_info.insert("uin".into(), json!(uin));
    }
    if let Some(kind) = text(decrypted, "type") {
        user_info.insert("type".into(), json!(kind));
    }
    if let Some(nickname) = text(decrypted, "nickname") {
        user_info.insert("nickname".into(), json!(nickname));
    }
    if let Some(enterprise_id) = text(decrypted, "enterpriseId") {
        user_info.insert("enterprise_id".into(), json!(enterprise_id));
    }
    // The store's expiries are absolute milliseconds; the engine normalizes them
    // on adopt, so they are passed through unchanged rather than converted twice.
    if let Some(expire) = decrypted.get("expiresAt").and_then(Value::as_i64) {
        user_info.insert("expiresAt".into(), json!(expire));
    }
    if let Some(scope) = text(decrypted, "scope") {
        user_info.insert("scope".into(), json!(scope));
    }
    Ok(json!({
        "userInfo": Value::Object(user_info),
        // The account uid is the identity WorkBuddy issued the token to. It travels
        // under the `machineId` key so the host's adopt path stays identical to the
        // other subscriptions; the engine stores it as its device identity.
        "machineId": text(decrypted, "uid").unwrap_or_default(),
    }))
}

fn text(source: &Value, key: &str) -> Option<String> {
    match source.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_reads_its_target_from_the_environment_never_from_its_own_text() {
        // The child runs this text as code. A store path interpolated into it
        // would make a path containing a quote executable, and that path is the
        // machine's layout, not ours. So the contract is: the script reads the
        // path from `process.env`, and it is a `&'static str` that no caller can
        // build a value into.
        assert!(
            DECRYPT_SCRIPT.contains(&format!("process.env.{AUTH_FILE_ENV}")),
            "the script must read its target from the environment"
        );
        // It must not read the path any other way, and must not be a format
        // template that a caller fills in.
        assert!(
            !DECRYPT_SCRIPT.contains("process.argv"),
            "the path must not arrive as an argument either"
        );
        assert!(
            !DECRYPT_SCRIPT.contains("{id}") && !DECRYPT_SCRIPT.contains("{path}"),
            "the script is a constant, not an interpolated template"
        );
    }

    #[test]
    fn the_childs_answer_carries_no_key_material() {
        // Reading `payload.atRestSecretKey` is the script's INPUT and cannot be
        // avoided — that is the whole point of delegating. What must hold is that
        // the answer it writes to stdout carries no key. Assert the output object
        // itself rather than grepping the source, which cannot tell an input read
        // from an output field.
        let start = DECRYPT_SCRIPT
            .find("const out = {")
            .expect("the script builds one output object");
        let end = DECRYPT_SCRIPT[start..]
            .find("\n};")
            .map(|offset| start + offset + 3)
            .expect("that object is closed");
        let block = &DECRYPT_SCRIPT[start..end];

        // `keyId` is allowed: it is a 16-hex FINGERPRINT that the client already
        // stores in plaintext in its keyblob, and it is what lets the projection
        // prove the envelope was opened with the right key. The secret is not.
        for forbidden in [
            "atRestSecretKey",
            "payload",
            "key,",
            "key:",
            " key ",
            "createHash",
            "digest",
        ] {
            assert!(
                !block.contains(forbidden),
                "the output object must not carry {forbidden:?}: {block}"
            );
        }
        assert!(block.contains("keyId,"), "the fingerprint stays: {block}");
        // And the only thing written is that one object.
        assert_eq!(
            DECRYPT_SCRIPT.matches("process.stdout.write").count(),
            2,
            "one write for the failure envelope, one for the answer"
        );
    }

    #[test]
    fn the_child_is_workbuddys_electron_running_the_script_as_node() {
        // Asserted on the real spawn path, not a restatement of it: the binary is
        // the candidate's own Electron, ELECTRON_RUN_AS_NODE makes its private
        // binding reachable without a window, and the store path rides in the env.
        let candidate = Candidate {
            auth_file: PathBuf::from("/tmp/a path with 'quote' and\nnewline.info"),
            electron: PathBuf::from("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron"),
            region: WorkBuddyRegion::Intl,
        };
        let command = spawn_command(&candidate);
        assert_eq!(command.get_program(), candidate.electron);
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], "-e");
        assert_eq!(
            args[1], DECRYPT_SCRIPT,
            "the fixed script is arg[1] verbatim"
        );
        let env: Vec<(String, String)> = command
            .get_envs()
            .filter_map(|(key, value)| {
                Some((
                    key.to_string_lossy().into_owned(),
                    value?.to_string_lossy().into_owned(),
                ))
            })
            .collect();
        let lookup = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(lookup("ELECTRON_RUN_AS_NODE").as_deref(), Some("1"));
        // The hostile path is carried as DATA in the environment, so the quote and
        // newline can never become code in the child.
        assert_eq!(
            lookup(AUTH_FILE_ENV).as_deref(),
            Some("/tmp/a path with 'quote' and\nnewline.info")
        );
    }

    #[test]
    fn the_store_directory_follows_each_platform_convention() {
        let home = Path::new("/Users/someone");
        assert_eq!(
            store_dir(home, Platform::MacOs),
            Some(PathBuf::from(
                "/Users/someone/Library/Application Support/CodeBuddyExtension/Data/Public/auth"
            ))
        );
        assert_eq!(
            store_dir(home, Platform::Linux),
            Some(PathBuf::from(
                "/Users/someone/.local/share/CodeBuddyExtension/Data/Public/auth"
            ))
        );
        assert_eq!(store_dir(home, Platform::Unsupported), None);
    }

    #[test]
    fn every_shipping_variant_is_tried_and_only_the_signed_in_one_wins() {
        // Both file stems are candidates; the overseas build comes first because
        // its gateway is the default endpoint.
        let home = Path::new("/Users/someone");
        let dir = store_dir(home, Platform::MacOs).expect("mac store dir");
        assert_eq!(
            AUTH_IDS
                .iter()
                .map(|id| dir.join(format!("{id}.info")))
                .collect::<Vec<_>>(),
            vec![
                PathBuf::from("/Users/someone/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info"),
                PathBuf::from("/Users/someone/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"),
            ]
        );
    }

    #[test]
    fn a_machine_without_workbuddy_reports_absent_not_broken() {
        // Driven through read_candidates, not read(): discovery probes the real
        // /Applications, so on a machine that HAS WorkBuddy the unsplit version
        // would report present. No candidate at all == not installed.
        assert_eq!(read_candidates(Vec::new()), json!({"present": false}));
    }

    #[test]
    fn an_installed_app_with_no_login_reports_present_but_imports_nothing() {
        // A runtime was found but the store file does not exist: `present` follows
        // the install (matching the other local-import readers), and there is no
        // error because nothing is broken — the user simply has not logged in.
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("does-not-exist.info");
        let candidates = vec![Candidate {
            auth_file: missing,
            electron: PathBuf::from("/bin/true"),
            region: WorkBuddyRegion::Intl,
        }];
        assert_eq!(read_candidates(candidates), json!({"present": true}));
    }

    #[test]
    fn the_decrypted_session_projects_onto_the_engine_credential_shape() {
        let decrypted = json!({
            "ok": true,
            "keyId": "9127dea1b44020a7",
            "accessToken": "header.payload.signature",
            "refreshToken": "refresh-value",
            "nickname": "fixture-user",
            "uid": "fixture-uid-0000-0000-000000000000",
            "uin": "450700000000",
            "type": "personal",
            "domain": "www.workbuddy.ai",
            "expiresAt": 1822047616094_i64,
            "scope": "openid profile offline_access email",
            "tokenType": "Bearer",
        });
        let credential = to_klaus_credential(&decrypted).expect("projection");
        assert_eq!(
            credential["machineId"],
            json!("fixture-uid-0000-0000-000000000000")
        );
        let user = &credential["userInfo"];
        assert_eq!(user["access_token"], json!("header.payload.signature"));
        assert_eq!(user["refresh_token"], json!("refresh-value"));
        assert_eq!(user["nickname"], json!("fixture-user"));
        assert_eq!(user["domain"], json!("www.workbuddy.ai"));
        assert_eq!(user["expiresAt"], json!(1822047616094_i64));
        // The key id is an implementation detail of the other client's encryption
        // and has no place in Klaus's credential.
        assert!(user.get("keyId").is_none());
        assert!(user.get("ok").is_none());
    }

    /// These tests set a process-global environment variable, so they must not run
    /// in parallel with each other.
    fn runtime_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    /// Restores the environment on drop, so a panicking assertion cannot leak a
    /// stand-in runtime into the rest of the binary. The variable is process
    /// state, which is why every test that sets one holds [`runtime_lock`].
    struct RuntimeGuard {
        previous: Option<String>,
    }

    impl RuntimeGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::var("KLAUS_WORKBUDDY_TEST_RUNTIME").ok();
            std::env::set_var("KLAUS_WORKBUDDY_TEST_RUNTIME", path);
            Self { previous }
        }
    }

    impl Drop for RuntimeGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var("KLAUS_WORKBUDDY_TEST_RUNTIME", value),
                None => std::env::remove_var("KLAUS_WORKBUDDY_TEST_RUNTIME"),
            }
        }
    }

    /// A stand-in for WorkBuddy's Electron: it answers with the JSON the real one
    /// would, and it FAILS LOUDLY if the store path did not arrive through the
    /// environment or does not name a readable file — which is what makes this
    /// exercise the real spawn contract rather than a stubbed return value.
    #[cfg(windows)]
    fn write_stand_in_runtime(dir: &Path, mode: &str) -> PathBuf {
        assert!(matches!(mode, "ok" | "not_signed_in" | "garbage" | "crash"));
        static RUNTIME: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
        let bytes = RUNTIME.get_or_init(|| {
            // Keep only executable bytes in the cache so the compiler's private
            // directory is removed before the first fixture is launched.
            let build = tempfile::tempdir().expect("runtime build directory");
            let source = build.path().join("stand_in.rs");
            let binary = build.path().join("stand_in.exe");
            std::fs::write(
                &source,
                r##"fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 || args.get(1).and_then(|arg| arg.to_str()) != Some("-e") {
        print!("{{\"ok\":false,\"error\":\"invalid_arguments\"}}");
        return;
    }
    if std::env::var("ELECTRON_RUN_AS_NODE").as_deref() != Ok("1") {
        print!("{{\"ok\":false,\"error\":\"not_node_mode\"}}");
        return;
    }
    let Some(auth_file) = std::env::var_os("KLAUS_WORKBUDDY_AUTH_FILE") else {
        print!("{{\"ok\":false,\"error\":\"no_env\"}}");
        return;
    };
    if std::fs::read(&auth_file).is_err() {
        print!("{{\"ok\":false,\"error\":\"state_unreadable\"}}");
        return;
    }
    let executable = std::env::current_exe().expect("fixture executable");
    let mode = std::fs::read_to_string(executable.with_extension("mode")).expect("fixture mode");
    match mode.as_str() {
        "store" => print!("{}", std::fs::read_to_string(&auth_file).expect("fixture store")),
        "ok" => print!("{}", r#"{"ok":true,"keyId":"fixture-key-id","accessToken":"fixture-access-token","refreshToken":"fixture-refresh-token","nickname":"Fixture User","expiresAt":1822047616094,"tokenType":"Bearer","domain":"www.workbuddy.ai","scope":"openid profile","uid":"fixture-uid-1234","uin":"450700000000","type":"personal"}"#),
        "not_signed_in" => print!("{{\"ok\":false,\"error\":\"not_signed_in\"}}"),
        "garbage" => print!("this is not json at all"),
        "crash" => std::process::exit(3),
        _ => panic!("unknown fixture mode"),
    }
}
"##,
            )
            .expect("runtime fixture source");
            let mut compiler = Command::new("rustc");
            compiler
                .args(["--edition=2021", "-D", "warnings", "--crate-name", "workbuddy_fixture"])
                .arg(&source)
                .arg("-o")
                .arg(&binary);
            eprintln!("[workbuddy-fixture] compiler: {compiler:?}");
            let output = compiler.output().expect("runtime fixture compiler");
            assert!(
                output.status.success(),
                "runtime fixture compilation failed: stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            std::fs::read(binary).expect("runtime fixture executable")
        });
        let path = dir.join("stand-in-runtime.exe");
        std::fs::write(&path, bytes).expect("stand-in executable written");
        std::fs::write(path.with_extension("mode"), mode).expect("stand-in mode written");
        path
    }

    #[cfg(not(windows))]
    fn write_stand_in_runtime(dir: &Path, mode: &str) -> PathBuf {
        let path = dir.join("stand-in-runtime.sh");
        let body = match mode {
            "store" => {
                r#"#!/bin/sh
cat "$KLAUS_WORKBUDDY_AUTH_FILE"
"#
            }
            "ok" => {
                r#"#!/bin/sh
if [ -z "$KLAUS_WORKBUDDY_AUTH_FILE" ]; then printf '%s' '{"ok":false,"error":"no_env"}'; exit 0; fi
if [ ! -f "$KLAUS_WORKBUDDY_AUTH_FILE" ]; then printf '%s' '{"ok":false,"error":"state_unreadable"}'; exit 0; fi
printf '%s' '{"ok":true,"keyId":"fixture-key-id","accessToken":"fixture-access-token","refreshToken":"fixture-refresh-token","nickname":"Fixture User","expiresAt":1822047616094,"tokenType":"Bearer","domain":"www.workbuddy.ai","scope":"openid profile","uid":"fixture-uid-1234","uin":"450700000000","type":"personal"}'
exit 0
"#
            }
            "not_signed_in" => {
                r#"#!/bin/sh
printf '%s' '{"ok":false,"error":"not_signed_in"}'
exit 0
"#
            }
            "garbage" => {
                r#"#!/bin/sh
printf '%s' 'this is not json at all'
exit 0
"#
            }
            "crash" => {
                r#"#!/bin/sh
exit 3
"#
            }
            other => panic!("unknown stand-in mode {other}"),
        };
        std::fs::write(&path, body).expect("stand-in written");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("stand-in executable");
        }
        path
    }

    /// Lay out the real directory tree a WorkBuddy install would have, so discovery
    /// finds the store file exactly as it would on a user's machine.
    fn write_store_file(home: &Path, auth_id: &str, contents: &str) -> PathBuf {
        let file = store_dir(home, Platform::MacOs)
            .expect("mac store dir")
            .join(format!("{auth_id}.info"));
        std::fs::create_dir_all(file.parent().expect("store dir")).expect("store dir created");
        std::fs::write(&file, contents).expect("store file written");
        file
    }

    /// Runs against the REAL WorkBuddy install on this machine, so it is ignored by
    /// default: it has no fixture to fall back on and asserts nothing about secrets,
    /// only that the delegated decryption answers with a usable session. Run with
    /// `cargo test -p klaus-native-core --lib -- --ignored real_workbuddy`.
    #[test]
    #[ignore = "needs WorkBuddy AI installed and signed in on this machine"]
    fn real_workbuddy_install_yields_a_usable_credential() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        // No stand-in: the discovery path must find the app and the store itself.
        std::env::remove_var("KLAUS_WORKBUDDY_TEST_RUNTIME");
        let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
        let result = read(&home, Platform::MacOs, None);
        assert_eq!(
            result["present"],
            json!(true),
            "WorkBuddy is installed here"
        );
        if result.get("error").is_some() {
            panic!("real decrypt failed: {result}");
        }
        let user = &result["userInfo"];
        let token = user["access_token"].as_str().expect("access token");
        // A WorkBuddy access token is a JWT: three dot-separated base64 segments.
        assert_eq!(token.split('.').count(), 3, "access token is a JWT");
        assert!(token.len() > 100, "a real JWT is not a stub");
        assert!(
            user.get("refresh_token").is_some(),
            "the store carries a refresh token too"
        );
        assert!(
            !result["machineId"].as_str().unwrap_or_default().is_empty(),
            "the account uid travels as the device identity"
        );
        // The other client's key fingerprint must not leak into our credential.
        assert!(user.get("keyId").is_none(), "{user}");
    }

    #[test]
    fn the_whole_child_chain_projects_a_real_install_into_a_credential() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home created");
        let runtime = write_stand_in_runtime(temp.path(), "ok");
        let _guard = RuntimeGuard::set(&runtime);
        // The store file must exist for discovery to consider this variant at all;
        // the stand-in then proves it received that exact path.
        write_store_file(
            &home,
            "workbuddy-desktop-ai",
            "{\"account\":{},\"auth\":{}}",
        );

        let result = read(&home, Platform::MacOs, None);
        assert_eq!(result["present"], json!(true), "{result}");
        assert_eq!(result["machineId"], json!("fixture-uid-1234"), "{result}");
        let user = &result["userInfo"];
        assert_eq!(user["access_token"], json!("fixture-access-token"));
        assert_eq!(user["refresh_token"], json!("fixture-refresh-token"));
        assert_eq!(user["nickname"], json!("Fixture User"));
        assert_eq!(user["domain"], json!("www.workbuddy.ai"));
        assert_eq!(user["expiresAt"], json!(1822047616094_i64));
        // The other client's encryption fingerprint is its business, not ours.
        assert!(user.get("keyId").is_none(), "{user}");
    }

    #[test]
    fn a_store_that_only_the_domestic_variant_has_is_still_found() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home created");
        let runtime = write_stand_in_runtime(temp.path(), "ok");
        let _guard = RuntimeGuard::set(&runtime);
        // Only the second candidate exists: the overseas build is absent, so the
        // first is skipped and the domestic one answers.
        write_store_file(&home, "workbuddy-desktop", "{\"account\":{},\"auth\":{}}");

        let result = read(&home, Platform::MacOs, None);
        assert_eq!(result["present"], json!(true), "{result}");
        assert_eq!(result["machineId"], json!("fixture-uid-1234"), "{result}");
    }

    #[test]
    fn selecting_an_edition_reads_only_its_store_when_both_are_signed_in() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let runtime = write_stand_in_runtime(temp.path(), "store");
        let _guard = RuntimeGuard::set(&runtime);
        for region in [WorkBuddyRegion::Cn, WorkBuddyRegion::Intl] {
            let (name, _, _) = region.metadata();
            write_store_file(&home, region.auth_id(), &json!({
                "ok": true, "accessToken": format!("{name}-token"), "uid": format!("{name}-user")
            }).to_string());
        }
        for region in [WorkBuddyRegion::Cn, WorkBuddyRegion::Intl] {
            let (name, platform, domain) = region.metadata();
            let result = read(&home, Platform::MacOs, Some(region));
            assert_eq!(result["userInfo"]["access_token"], format!("{name}-token"));
            assert_eq!(result["userInfo"]["region"], name);
            assert_eq!(result["userInfo"]["platform"], platform);
            assert_eq!(result["userInfo"]["domain"], domain);
            assert_eq!(result["machineId"], format!("{name}-user"));
        }
        assert_eq!(
            read(&home, Platform::MacOs, None)["userInfo"]["region"],
            "intl"
        );
    }

    #[test]
    fn a_missing_or_signed_out_selected_edition_never_imports_the_other_edition() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let runtime = write_stand_in_runtime(temp.path(), "store");
        let _guard = RuntimeGuard::set(&runtime);
        for region in [WorkBuddyRegion::Cn, WorkBuddyRegion::Intl] {
            let other = if region == WorkBuddyRegion::Cn {
                WorkBuddyRegion::Intl
            } else {
                WorkBuddyRegion::Cn
            };
            write_store_file(
                &home,
                other.auth_id(),
                &json!({"ok":true,"accessToken":"other-token"}).to_string(),
            );
            let selected = store_dir(&home, Platform::MacOs)
                .unwrap()
                .join(format!("{}.info", region.auth_id()));
            let _ = std::fs::remove_file(&selected);
            let missing = read(&home, Platform::MacOs, Some(region));
            assert!(missing.get("userInfo").is_none(), "{missing}");
            write_store_file(
                &home,
                region.auth_id(),
                &json!({"ok":false,"error":"not_signed_in"}).to_string(),
            );
            let signed_out = read(&home, Platform::MacOs, Some(region));
            assert_eq!(signed_out["error"], "workbuddy_local_not_signed_in");
            assert!(signed_out.get("userInfo").is_none(), "{signed_out}");
        }
    }

    #[test]
    fn a_runtime_that_reports_no_login_says_so_instead_of_inventing_one() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        std::fs::create_dir_all(&home).expect("home created");
        let runtime = write_stand_in_runtime(temp.path(), "not_signed_in");
        let _guard = RuntimeGuard::set(&runtime);
        write_store_file(
            &home,
            "workbuddy-desktop-ai",
            "{\"account\":{},\"auth\":{}}",
        );

        let result = read(&home, Platform::MacOs, None);
        assert_eq!(result["present"], json!(true));
        assert_eq!(result["error"], json!("workbuddy_local_not_signed_in"));
        assert!(result.get("userInfo").is_none(), "{result}");
    }

    #[test]
    fn a_child_that_answers_garbage_or_crashes_is_an_unreadable_secret_never_a_login() {
        let _lock = runtime_lock().lock().unwrap_or_else(|p| p.into_inner());
        for mode in ["garbage", "crash"] {
            let temp = tempfile::tempdir().expect("tempdir");
            let home = temp.path().join("home");
            std::fs::create_dir_all(&home).expect("home created");
            let runtime = write_stand_in_runtime(temp.path(), mode);
            let _guard = RuntimeGuard::set(&runtime);
            write_store_file(
                &home,
                "workbuddy-desktop-ai",
                "{\"account\":{},\"auth\":{}}",
            );

            let result = read(&home, Platform::MacOs, None);
            assert_eq!(result["present"], json!(true), "{mode}");
            assert!(
                matches!(
                    result["error"].as_str(),
                    Some("workbuddy_local_secret_unreadable")
                        | Some("workbuddy_local_runtime_failed")
                ),
                "{mode} must fail closed, got {result}"
            );
            assert!(result.get("userInfo").is_none(), "{mode}: {result}");
        }
    }

    #[test]
    fn a_session_without_an_access_token_is_not_a_login() {
        let decrypted = json!({ "ok": true, "refreshToken": "refresh", "uid": "u" });
        assert_eq!(
            to_klaus_credential(&decrypted),
            Err("workbuddy_local_not_signed_in")
        );
    }

    #[test]
    fn a_blank_token_string_is_treated_as_absent() {
        let decrypted = json!({ "ok": true, "accessToken": "   ", "uid": "u" });
        assert_eq!(
            to_klaus_credential(&decrypted),
            Err("workbuddy_local_not_signed_in")
        );
    }

    #[test]
    fn optional_fields_are_omitted_rather_than_written_as_null() {
        // The engine reads these by name; a present-but-null `refresh_token`
        // would be indistinguishable from "no refresh token" only by accident.
        let credential =
            to_klaus_credential(&json!({ "ok": true, "accessToken": "tok" })).expect("projection");
        let user = &credential["userInfo"];
        assert!(user.get("refresh_token").is_none());
        assert!(user.get("domain").is_none());
        assert!(user.get("expiresAt").is_none());
        assert_eq!(credential["machineId"], json!(""));
    }
}
