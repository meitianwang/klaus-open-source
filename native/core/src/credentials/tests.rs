use super::*;
use std::time::{Duration, Instant};

fn config(dir: &Path, platform: Platform) -> CredentialConfig {
    CredentialConfig {
        config_root: dir.join("klaus"),
        user_home: dir.join("home"),
        platform,
        qoder_state_db: None,
        keychain_service: "agent-engine".into(),
    }
}

fn setup(platform: Platform) -> (tempfile::TempDir, CredentialStore, Arc<FixtureKeychain>) {
    let dir = tempfile::tempdir().unwrap();
    let keychain = Arc::new(FixtureKeychain::default());
    let store = CredentialStore::new(config(dir.path(), platform), keychain.clone()).unwrap();
    (dir, store, keychain)
}

/// Counts every OS keychain touch so a test can prove the Claude subscription
/// slot never reaches the keychain: the ecosystem entry is named after another
/// product, and on macOS touching it IS the system authorization prompt.
#[derive(Default)]
struct Counting {
    inner: FixtureKeychain,
    reads: AtomicU64,
    writes: AtomicU64,
    deletes: AtomicU64,
}
impl Keychain for Counting {
    fn read(&self, service: &str, account: Option<&str>) -> Result<Option<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.inner.read(service, account)
    }
    fn write(&self, service: &str, account: &str, bytes: &[u8]) -> Result<()> {
        self.writes.fetch_add(1, Ordering::Relaxed);
        self.inner.write(service, account, bytes)
    }
    fn delete(&self, service: &str, account: &str) -> Result<()> {
        self.deletes.fetch_add(1, Ordering::Relaxed);
        self.inner.delete(service, account)
    }
}

#[test]
fn mcp_records_keep_the_existing_flat_service_and_three_independent_slots() {
    let (_dir, store, keychain) = setup(Platform::MacOs);
    let server = "fixture-mcp|0123456789abcdef";
    let key = McpKey::new(server, "tokens").unwrap();
    keychain
        .write(
            "agent-engine",
            "mcp:oauth:fixture-mcp|0123456789abcdef:tokens",
            br#"{"tokens":{"access_token":"existing"},"expiresAt":1234}"#,
        )
        .unwrap();
    assert_eq!(
        store.read_mcp_oauth_record(&key)["value"]["tokens"]["access_token"],
        "existing"
    );
    let client = McpKey::new(server, "client").unwrap();
    assert_eq!(store.read_mcp_oauth_record(&client), json!({"value":null}));
    assert_eq!(
        store.write_mcp_oauth_record(&client, json!({"client_id":"fixture-client"})),
        json!({"success":true})
    );
    assert!(store.remove_mcp_oauth_record(&key));
    assert!(store.remove_mcp_oauth_record(&key));
    assert_eq!(
        store.read_mcp_oauth_record(&client)["value"]["client_id"],
        "fixture-client"
    );
    assert_eq!(store.read_mcp_oauth_record(&key), json!({"value":null}));
    assert!(!store
        .config
        .config_root
        .join(".mcp-credentials.json")
        .exists());
    for (server, part) in [
        (server, "pkce"),
        ("bad\nkey|0123456789abcdef", "tokens"),
        ("no-config-fingerprint", "tokens"),
    ] {
        assert!(McpKey::new(server, part).is_err());
    }
}

#[test]
fn mcp_product_namespaces_do_not_read_write_or_delete_each_other() {
    let (dir, domestic, keychain) = setup(Platform::MacOs);
    let mut international_config = config(dir.path(), Platform::MacOs);
    international_config.config_root = dir.path().join("international");
    international_config.keychain_service = "agent-engine-international".into();
    let international = CredentialStore::new(international_config, keychain.clone()).unwrap();
    let key = McpKey::new("fixture|0123456789abcdef", "tokens").unwrap();
    assert_eq!(
        domestic.write_mcp_oauth_record(&key, json!({"token":"domestic"})),
        json!({"success":true})
    );
    assert_eq!(
        international.read_mcp_oauth_record(&key),
        json!({"value":null})
    );
    assert_eq!(
        international.write_mcp_oauth_record(&key, json!({"token":"international"})),
        json!({"success":true})
    );
    assert_eq!(
        domestic.read_mcp_oauth_record(&key)["value"]["token"],
        "domestic"
    );
    assert_eq!(
        international.read_mcp_oauth_record(&key)["value"]["token"],
        "international"
    );
    assert!(international.remove_mcp_oauth_record(&key));
    assert_eq!(
        domestic.read_mcp_oauth_record(&key)["value"]["token"],
        "domestic"
    );
    assert!(domestic.remove_mcp_oauth_record(&key));
}

#[test]
fn subscription_copies_remain_local_to_each_config_root() {
    let (dir, domestic, keychain) = setup(Platform::MacOs);
    let mut international_config = config(dir.path(), Platform::MacOs);
    international_config.config_root = dir.path().join("international");
    international_config.keychain_service = "agent-engine-international".into();
    let international = CredentialStore::new(international_config, keychain).unwrap();
    assert_eq!(
        domestic.write_claude_oauth(json!({"accessToken":"domestic"}))["success"],
        true
    );
    assert_eq!(international.read_claude_oauth(), json!({"value":null}));
    assert_eq!(
        international.write_claude_oauth(json!({"accessToken":"international"}))["success"],
        true
    );
    assert_eq!(
        domestic.read_claude_oauth()["value"]["accessToken"],
        "domestic"
    );
    assert_eq!(
        international.read_claude_oauth()["value"]["accessToken"],
        "international"
    );
    assert!(international.remove_claude_oauth());
    assert_eq!(
        domestic.read_claude_oauth()["value"]["accessToken"],
        "domestic"
    );
}

#[test]
fn keychain_service_accepts_the_product_namespace_family() {
    let dir = tempfile::tempdir().unwrap();
    for service in [
        "agent-engine",
        "agent-engine-international",
        "agent-engine-sample",
        "agent-engine-a1-b2",
    ] {
        let mut config = config(dir.path(), Platform::MacOs);
        config.keychain_service = service.into();
        assert!(config.validate().is_ok(), "{service}");
        assert!(is_product_keychain_service(service), "{service}");
    }
}

#[test]
fn keychain_service_rejects_arbitrary_namespaces() {
    let dir = tempfile::tempdir().unwrap();
    let long = format!("agent-engine-{}", "a".repeat(52));
    for service in [
        "",
        "arbitrary",
        "agent-engine-",
        "agent-engine--sample",
        "agent-engine-Sample",
        "agent-engine_sample",
        "agent-enginesample",
        "xagent-engine",
        "agent-engine\n",
        "agent-engine-sample\n",
        long.as_str(),
    ] {
        let mut config = config(dir.path(), Platform::MacOs);
        config.keychain_service = service.into();
        assert_eq!(
            config.validate().unwrap_err().code,
            "INVALID_KEYCHAIN_SERVICE"
        );
    }
}

#[test]
fn mcp_corruption_and_denial_are_errors_and_do_not_enable_plaintext_fallback() {
    let (dir, store, keychain) = setup(Platform::MacOs);
    let key = McpKey::new("fixture|0123456789abcdef", "tokens").unwrap();
    keychain
        .write(
            "agent-engine",
            "mcp:oauth:fixture|0123456789abcdef:tokens",
            b"not-json",
        )
        .unwrap();
    assert_eq!(
        store.read_mcp_oauth_record(&key),
        json!({"value":null,"error":"mcp_credential_record_unreadable"})
    );
    let denied =
        CredentialStore::new(config(dir.path(), Platform::MacOs), Arc::new(Denied)).unwrap();
    assert_eq!(
        denied.read_mcp_oauth_record(&key),
        json!({"value":null,"error":"credential_keychain_denied"})
    );
    assert_eq!(
        denied.write_mcp_oauth_record(&key, json!({"tokens":{}})),
        json!({"success":false,"error":"credential_keychain_denied"})
    );
    assert!(!denied.remove_mcp_oauth_record(&key));
    for platform in [Platform::Windows, Platform::Linux] {
        let (_, unsupported, _) = setup(platform);
        assert_eq!(
            unsupported.read_mcp_oauth_record(&key),
            json!({"value":null,"error":"mcp_secure_storage_platform_unsupported"})
        );
        assert_eq!(
            unsupported.write_mcp_oauth_record(&key, json!({"tokens":{}})),
            json!({"success":false,"error":"mcp_secure_storage_platform_unsupported"})
        );
        assert!(!unsupported.remove_mcp_oauth_record(&key));
    }
    assert!(!store
        .config
        .config_root
        .join(".mcp-credentials.json")
        .exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_worker_admits_write_remove_and_read_in_call_order() {
    let (_dir, store, _) = setup(Platform::MacOs);
    let service = CredentialService::new("mcp-order".into(), store).unwrap();
    let key = || McpKey::new("fixture|0123456789abcdef", "tokens").unwrap();
    let write = service
        .prepare(
            "write".into(),
            Action::WriteMcpOAuthRecord(key(), json!({"tokens":{"access_token":"fixture"}})),
            2000,
        )
        .unwrap();
    let remove = service
        .prepare("remove".into(), Action::RemoveMcpOAuthRecord(key()), 2000)
        .unwrap();
    let read = service
        .prepare("read".into(), Action::ReadMcpOAuthRecord(key()), 2000)
        .unwrap();
    let (write, remove, read) = tokio::join!(write.wait(), remove.wait(), read.wait());
    assert_eq!(write.unwrap()["result"], json!({"success":true}));
    assert_eq!(remove.unwrap()["result"], true);
    assert_eq!(
        read.unwrap(),
        json!({"resourceId":"mcp-order","operationId":"read","result":{"value":null}})
    );
    assert_eq!(service.shutdown(1000).unwrap().await["complete"], true);
}

#[test]
fn the_subscription_copy_is_a_named_private_file_in_the_config_root() {
    let c = config(Path::new("/fixture"), Platform::MacOs);
    assert_eq!(
        c.subscription_path(),
        PathBuf::from("/fixture/klaus/claude-subscription-oauth.json")
    );
    assert_eq!(
        c.legacy_plaintext_path(),
        PathBuf::from("/fixture/klaus/.credentials.json")
    );
}

#[test]
fn reads_json_nul_and_legacy_hex_without_reinterpreting_non_objects() {
    let raw = b"{\"claudeAiOauth\":{\"accessToken\":\"fake\"}}\0";
    let expected = parse_record(raw).unwrap();
    let hex = raw.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(parse_record(hex.as_bytes()).unwrap(), expected);
    assert!(parse_record(b"[1,2]").is_err());
    assert!(parse_record(b"true").is_err());
    assert_eq!(
        parse_record(&vec![b'x'; MAX_RECORD_BYTES + 1])
            .unwrap_err()
            .code,
        "credential_record_too_large"
    );
}

/// The regression this pins: the Claude subscription slot is Klaus's own copy
/// and never touches the login keychain, because the ecosystem entry is named
/// after the Claude Code client and on macOS touching it IS the authorization
/// prompt — again on every refusal, which is how background status refreshes
/// became a prompt loop for users who reuse nothing.
#[test]
fn the_subscription_slot_never_touches_the_keychain_even_with_a_foreign_entry_present() {
    let dir = tempfile::tempdir().unwrap();
    let keychain = Arc::new(Counting::default());
    keychain
        .inner
        .write(
            "Claude Code-credentials",
            "another-account",
            b"{\"claudeAiOauth\":{\"accessToken\":\"foreign\"}}\0",
        )
        .unwrap();
    let store =
        CredentialStore::new(config(dir.path(), Platform::MacOs), keychain.clone()).unwrap();

    // Status polls: no keychain touch at all, and the foreign login stays
    // invisible instead of reading as a Klaus sign-in.
    assert_eq!(store.read_claude_oauth(), json!({"value": null}));
    assert_eq!(store.read_claude_oauth(), json!({"value": null}));
    assert_eq!(keychain.reads.load(Ordering::Relaxed), 0);

    // Login lands in the private copy; logout empties it. Neither touches the
    // keychain, so the other product's entry survives a Klaus logout intact.
    assert_eq!(
        store.write_claude_oauth(json!({"accessToken": "mine"})),
        json!({"success": true})
    );
    assert_eq!(store.read_claude_oauth()["value"]["accessToken"], "mine");
    assert!(store.remove_claude_oauth());
    assert_eq!(store.read_claude_oauth(), json!({"value": null}));
    assert_eq!(keychain.reads.load(Ordering::Relaxed), 0);
    assert_eq!(keychain.writes.load(Ordering::Relaxed), 0);
    assert_eq!(keychain.deletes.load(Ordering::Relaxed), 0);
    assert!(keychain
        .inner
        .read("Claude Code-credentials", Some("another-account"))
        .unwrap()
        .is_some());
}

/// The copy is owner-only on POSIX, preserves the metadata written beside the
/// tokens, and leaves no file behind once a logout empties it.
#[test]
fn the_copy_is_private_preserves_metadata_and_is_removed_when_emptied() {
    let (_dir, store, _) = setup(Platform::MacOs);
    assert_eq!(
        store.write_claude_oauth(json!({"accessToken": "at", "refreshToken": "rt"})),
        json!({"success": true})
    );
    let path = store.config.subscription_path();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // Account metadata written beside the tokens survives a token rewrite.
    atomic_write(
        &path,
        json!({"account": {"email_address": "kept@example.test"}, "claudeAiOauth": {"accessToken": "old"}})
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        store.write_claude_oauth(json!({"accessToken": "new"})),
        json!({"success": true})
    );
    let record = read_record_file(&path).unwrap().unwrap();
    assert_eq!(
        record["account"]["email_address"],
        json!("kept@example.test")
    );
    assert_eq!(record["claudeAiOauth"]["accessToken"], json!("new"));
    assert!(store.remove_claude_oauth());
    let after = read_record_file(&path).unwrap().unwrap();
    assert!(after.get("claudeAiOauth").is_none());
    assert_eq!(
        after["account"]["email_address"],
        json!("kept@example.test")
    );
    // A copy holding nothing but the login is removed outright.
    let (_empty_dir, empty_store, _) = setup(Platform::MacOs);
    assert_eq!(
        empty_store.write_claude_oauth(json!({"accessToken": "only"})),
        json!({"success": true})
    );
    assert!(empty_store.remove_claude_oauth());
    assert!(
        !empty_store.config.subscription_path().exists(),
        "an emptied copy leaves no file behind"
    );
    assert!(!empty_store.remove_claude_oauth());
}

/// A login left in the plaintext fallback file by an older build still reads
/// after the upgrade; the first write migrates it into the copy and prunes the
/// legacy login key, so a later logout cannot resurrect it.
#[test]
fn a_legacy_plaintext_login_reads_then_migrates_on_the_next_write() {
    let (_dir, store, _) = setup(Platform::MacOs);
    let legacy = store.config.legacy_plaintext_path();
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(
        &legacy,
        json!({"pluginSecrets": {"keep": "me"}, "claudeAiOauth": {"accessToken": "legacy"}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(store.read_claude_oauth()["value"]["accessToken"], "legacy");
    assert_eq!(
        store.write_claude_oauth(json!({"accessToken": "new"})),
        json!({"success": true})
    );
    assert_eq!(store.read_claude_oauth()["value"]["accessToken"], "new");
    // The legacy file keeps its unrelated keys and loses the login key.
    let record = read_record_file(&legacy).unwrap().unwrap();
    assert_eq!(record["pluginSecrets"]["keep"], json!("me"));
    assert!(record.get("claudeAiOauth").is_none());
    // Logout removes the login from the copy; the migrated non-login keys stay.
    assert!(store.remove_claude_oauth());
    assert_eq!(store.read_claude_oauth(), json!({"value": null}));
    let copy = read_record_file(&store.config.subscription_path())
        .unwrap()
        .unwrap();
    assert_eq!(copy["pluginSecrets"]["keep"], json!("me"));
}

/// A corrupted copy is an explicit error, never a silent signed-out, and never
/// silently replaced by a write.
#[test]
fn a_corrupt_copy_is_an_explicit_error_and_large_credentials_are_rejected() {
    let (_dir, store, _) = setup(Platform::MacOs);
    let path = store.config.subscription_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"corrupt").unwrap();
    assert_eq!(
        store.read_claude_oauth()["error"],
        json!("credential_record_unreadable")
    );
    assert_eq!(
        store.write_claude_oauth(json!({"accessToken": "fake"}))["error"],
        json!("credential_record_unreadable")
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        store.write_claude_oauth(json!({"accessToken": "x".repeat(MAX_RECORD_BYTES)}))["error"],
        json!("invalid_claude_credential")
    );
}

struct Denied;
impl Keychain for Denied {
    fn read(&self, _: &str, _: Option<&str>) -> Result<Option<Vec<u8>>> {
        Err(error("credential_keychain_denied"))
    }
    fn write(&self, _: &str, _: &str, _: &[u8]) -> Result<()> {
        Err(error("credential_keychain_denied"))
    }
    fn delete(&self, _: &str, _: &str) -> Result<()> {
        Err(error("credential_keychain_denied"))
    }
}

#[test]
fn local_import_prefers_the_existing_file_then_service_only_keychain() {
    let (_dir, store, keychain) = setup(Platform::MacOs);
    keychain
        .write(
            "Claude Code-credentials",
            "another-account",
            b"{\"claudeAiOauth\":{\"accessToken\":\"keychain-fixture\"}}\0",
        )
        .unwrap();
    assert!(store.read_local_claude_credential()["raw"]
        .as_str()
        .unwrap()
        .contains("keychain-fixture"));
    let local = store.config.user_home.join(".claude/.credentials.json");
    fs::create_dir_all(local.parent().unwrap()).unwrap();
    fs::write(&local, b"file-fixture-raw").unwrap();
    assert_eq!(
        store.read_local_claude_credential(),
        json!({"present":true,"raw":"file-fixture-raw"})
    );
    assert_eq!(fs::read(local).unwrap(), b"file-fixture-raw");
    assert_eq!(store.read_qoder_ide_credential(), json!({"present":false}));
    assert_eq!(store.read_qoderwork_credential(), json!({"present":false}));
    assert_eq!(store.read_qwenwork_credential(), json!({"present":false}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_keeps_write_logout_order_and_seals_its_resource() {
    let (_dir, store, _) = setup(Platform::MacOs);
    let service = CredentialService::new("credentials-order".into(), store).unwrap();
    let write = service
        .prepare(
            "write".into(),
            Action::WriteClaudeOAuth(json!({"accessToken":"ordered"})),
            2000,
        )
        .unwrap();
    let remove = service
        .prepare("logout".into(), Action::RemoveClaudeOAuth, 2000)
        .unwrap();
    let read = service
        .prepare("read".into(), Action::ReadClaudeOAuth, 2000)
        .unwrap();
    let (write, remove, read) = tokio::join!(write.wait(), remove.wait(), read.wait());
    assert_eq!(write.unwrap()["result"]["success"], true);
    assert_eq!(remove.unwrap()["result"], true);
    assert_eq!(
        read.unwrap(),
        json!({"resourceId":"credentials-order","operationId":"read","result":{"value":null}})
    );
    assert_eq!(service.shutdown(1000).unwrap().await["complete"], true);
    assert_eq!(service.shutdown(10).unwrap().await["complete"], true);
    assert_eq!(
        service
            .prepare("late".into(), Action::ReadClaudeOAuth, 100)
            .unwrap_err()
            .code,
        "CLOSED"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_os_calls_keep_queues_bounded_cancel_before_start_and_report_shutdown_deadline() {
    use std::sync::{mpsc, Condvar};
    struct Gated {
        entered: mpsc::Sender<()>,
        released: Arc<(Mutex<bool>, Condvar)>,
        writes: Arc<AtomicU64>,
    }
    impl Keychain for Gated {
        fn read(&self, _: &str, _: Option<&str>) -> Result<Option<Vec<u8>>> {
            self.entered.send(()).unwrap();
            let (lock, changed) = &*self.released;
            let mut ready = lock.lock().unwrap();
            while !*ready {
                ready = changed.wait(ready).unwrap();
            }
            Ok(None)
        }
        fn write(&self, _: &str, _: &str, _: &[u8]) -> Result<()> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        fn delete(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let (entered, receiver) = mpsc::channel();
    let released = Arc::new((Mutex::new(false), Condvar::new()));
    let writes = Arc::new(AtomicU64::new(0));
    let store = CredentialStore::new(
        config(dir.path(), Platform::MacOs),
        Arc::new(Gated {
            entered,
            released: released.clone(),
            writes: writes.clone(),
        }),
    )
    .unwrap();
    let service = CredentialService::new("credentials-blocked".into(), store).unwrap();
    // An MCP read is the OS-backed operation here: the subscription slot is a
    // plain file and never blocks on the keychain.
    let key = || McpKey::new("fixture|0123456789abcdef", "tokens").unwrap();
    let active = service
        .prepare("active".into(), Action::ReadMcpOAuthRecord(key()), 100)
        .unwrap();
    receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut queued = Vec::new();
    for i in 0..7 {
        queued.push(
            service
                .prepare(
                    format!("queued-{i}"),
                    Action::WriteMcpOAuthRecord(
                        key(),
                        json!({"tokens":{"access_token":"must-not-write"}}),
                    ),
                    2000,
                )
                .unwrap(),
        );
    }
    assert_eq!(
        service
            .prepare("overflow".into(), Action::ReadMcpOAuthRecord(key()), 2000)
            .unwrap_err()
            .code,
        "BUSY"
    );
    assert_eq!(
        service
            .prepare("queued-0".into(), Action::ReadMcpOAuthRecord(key()), 2000)
            .unwrap_err()
            .code,
        "DUPLICATE_OPERATION"
    );
    assert!(service.cancel("queued-0"));
    assert!(!service.cancel("active"));
    assert_eq!(
        active.wait().await.unwrap_err().code,
        "credential_operation_outcome_unknown"
    );
    let started = Instant::now();
    let report = service.shutdown(20).unwrap().await;
    assert_eq!(report["complete"], false);
    assert_eq!(report["pendingOperations"].as_array().unwrap().len(), 8);
    assert!(started.elapsed() < Duration::from_secs(1));
    *released.0.lock().unwrap() = true;
    released.1.notify_all();
    for ticket in queued {
        assert_eq!(ticket.wait().await.unwrap_err().code, "CANCELLED");
    }
    assert_eq!(service.shutdown(1000).unwrap().await["complete"], true);
    assert_eq!(writes.load(Ordering::Relaxed), 0);
}
