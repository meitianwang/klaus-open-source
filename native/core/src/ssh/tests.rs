use super::config::{Endpoint, Target};
use super::fixture::Fixture;
use super::{known_hosts, Action, SshOptions, SshService};
use base64::Engine as _;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::{Algorithm, PrivateKey};
use sha1::Sha1;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn service(home: &Path, id: &str) -> SshService {
    SshService::new(
        id.into(),
        SshOptions {
            user_home: home.into(),
            local_user: "fixture".into(),
            agent_path: None,
        },
    )
    .unwrap()
}
fn target(fixture: &Fixture, user: &str) -> Target {
    Target {
        host: "127.0.0.1".into(),
        user: Some(user.into()),
        port: Some(fixture.port),
    }
}
async fn password_connect(service: &SshService, fixture: &Fixture) {
    let ticket = service
        .prepare(
            "connect".into(),
            Action::Connect(target(fixture, "fixture")),
            5000,
        )
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(3), service.read_event().unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(event.operation_id, "connect");
    assert_eq!(event.sequence, 1);
    assert!(!service
        .answer("wrong", &event.request_id, Some("fixture-password".into()))
        .unwrap());
    assert!(service
        .answer(
            "connect",
            &event.request_id,
            Some("fixture-password".into())
        )
        .unwrap());
    assert_eq!(ticket.wait().await.unwrap()["result"]["connected"], true);
}
async fn stopped(service: &SshService, fixture: &Fixture) {
    assert_eq!(service.shutdown(3000).unwrap().await["complete"], true);
    assert!(service.read_event().unwrap().await.unwrap().is_none());
    assert_eq!(service.shutdown(100).unwrap().await["complete"], true);
    assert!(service
        .prepare("late".into(), Action::ListHosts, 100)
        .is_err());
    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture.stats.active.load(Ordering::Acquire) != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn password_auth_reuses_one_connection_and_preserves_binary_output_and_exit() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    let ssh = service(home.path(), "binary");
    password_connect(&ssh, &fixture).await;
    let result = ssh
        .prepare(
            "binary-op".into(),
            Action::Execute("fixture:binary".into()),
            3000,
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
    let base64 = base64::engine::general_purpose::STANDARD;
    assert_eq!(
        base64
            .decode(result["result"]["stdoutBase64"].as_str().unwrap())
            .unwrap(),
        [0, 255, 1, 195, 169]
    );
    assert_eq!(
        base64
            .decode(result["result"]["stderrBase64"].as_str().unwrap())
            .unwrap(),
        b"fixture stderr"
    );
    assert_eq!(result["result"]["exitCode"], 7);
    assert_eq!(result["result"]["outputComplete"], true);
    ssh.prepare("second".into(), Action::Execute("second".into()), 3000)
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(fixture.stats.accepted.load(Ordering::Acquire), 1);
    assert_eq!(fixture.stats.authenticated.load(Ordering::Acquire), 1);
    stopped(&ssh, &fixture).await;
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keyboard_challenges_are_sequenced_and_cancel_stops_the_auth_ladder() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    let ssh = service(home.path(), "interactive");
    let ticket = ssh
        .prepare(
            "auth".into(),
            Action::Connect(target(&fixture, "interactive")),
            5000,
        )
        .unwrap();
    for (sequence, echo, answer) in [(1, true, "fixture-user"), (2, false, "fixture-otp")] {
        let event = ssh.read_event().unwrap().await.unwrap().unwrap();
        assert_eq!((event.sequence, event.echo), (sequence, echo));
        assert!(ssh
            .answer("auth", &event.request_id, Some(answer.into()))
            .unwrap());
        assert!(!ssh
            .answer("auth", &event.request_id, Some(answer.into()))
            .unwrap());
    }
    ticket.wait().await.unwrap();
    stopped(&ssh, &fixture).await;
    let cancelled = service(home.path(), "cancelled");
    let ticket = cancelled
        .prepare(
            "auth".into(),
            Action::Connect(target(&fixture, "interactive")),
            5000,
        )
        .unwrap();
    let event = cancelled.read_event().unwrap().await.unwrap().unwrap();
    assert!(cancelled.answer("auth", &event.request_id, None).unwrap());
    assert_eq!(ticket.wait().await.unwrap_err().code, "CANCELLED");
    stopped(&cancelled, &fixture).await;
    assert_eq!(fixture.stats.authenticated.load(Ordering::Acquire), 1);
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_queued_requests_settle_without_waiting_for_active_auth() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    let ssh = service(home.path(), "bounded");
    let auth = ssh
        .prepare(
            "auth".into(),
            Action::Connect(target(&fixture, "fixture")),
            5000,
        )
        .unwrap();
    let event = ssh.read_event().unwrap().await.unwrap().unwrap();
    let mut queued = Vec::new();
    for index in 0..7 {
        queued.push(
            ssh.prepare(format!("queued-{index}"), Action::ListHosts, 5000)
                .unwrap(),
        );
    }
    assert_eq!(
        ssh.prepare("full".into(), Action::ListHosts, 100)
            .err()
            .unwrap()
            .code,
        "BUSY"
    );
    assert!(ssh.cancel("queued-0"));
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(200), queued.remove(0).wait())
            .await
            .unwrap()
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    let reader = ssh.read_event().unwrap();
    assert_eq!(
        ssh.read_event().err().unwrap().code,
        "SSH_EVENT_READER_BUSY"
    );
    assert_eq!(ssh.shutdown(3000).unwrap().await["complete"], true);
    assert!(reader.await.unwrap().is_none());
    assert!(!ssh
        .answer("auth", &event.request_id, Some("fixture-password".into()))
        .unwrap());
    assert_eq!(auth.wait().await.unwrap_err().code, "CANCELLED");
    for ticket in queued {
        assert!(ticket.wait().await.is_err());
    }
    stopped(&ssh, &fixture).await;
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_exec_timeout_is_unknown_and_is_never_replayed() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    let ssh = service(home.path(), "timeout");
    password_connect(&ssh, &fixture).await;
    let result = ssh
        .prepare("hang".into(), Action::Execute("fixture:hang".into()), 250)
        .unwrap()
        .wait()
        .await;
    assert_eq!(result.unwrap_err().code, "SSH_OPERATION_OUTCOME_UNKNOWN");
    stopped(&ssh, &fixture).await;
    assert_eq!(*fixture.stats.commands.lock().unwrap(), ["fixture:hang"]);
    assert_eq!(fixture.stats.accepted.load(Ordering::Acquire), 1);
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_limit_and_missing_status_are_errors_without_partial_success() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    for (index, command, error) in [
        (0, "fixture:overflow", "SSH_OUTPUT_LIMIT"),
        (1, "fixture:no-status", "SSH_OPERATION_OUTCOME_UNKNOWN"),
    ] {
        let ssh = service(home.path(), &format!("limit-{index}"));
        password_connect(&ssh, &fixture).await;
        let result = ssh
            .prepare("exec".into(), Action::Execute(command.into()), 5000)
            .unwrap()
            .wait()
            .await;
        assert_eq!(result.unwrap_err().code, error);
        stopped(&ssh, &fixture).await;
    }
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_key_auth_and_encrypted_key_prompt_use_only_explicit_fixture_paths() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    let dir = home.path().join(".ssh");
    std::fs::create_dir_all(&dir).unwrap();
    for encrypted in [false, true] {
        let key = if encrypted {
            fixture
                .client_key
                .encrypt(&mut rand::rng(), "fixture-passphrase")
                .unwrap()
        } else {
            fixture.client_key.clone()
        };
        std::fs::write(
            dir.join("client"),
            key.to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        std::fs::write(
            dir.join("config"),
            format!(
                "Host *\n IdentityAgent none\n IdentityFile ~/.ssh/client\n BatchMode {}\n",
                if encrypted { "no" } else { "yes" }
            ),
        )
        .unwrap();
        let ssh = service(
            home.path(),
            if encrypted {
                "encrypted-key"
            } else {
                "plain-key"
            },
        );
        let ticket = ssh
            .prepare(
                "auth".into(),
                Action::Connect(target(&fixture, "fixture")),
                10000,
            )
            .unwrap();
        if encrypted {
            let event = ssh.read_event().unwrap().await.unwrap().unwrap();
            assert!(event.prompt.contains("Passphrase"));
            assert!(ssh
                .answer("auth", &event.request_id, Some("fixture-passphrase".into()))
                .unwrap());
        }
        assert_eq!(ticket.wait().await.unwrap()["result"]["connected"], true);
        stopped(&ssh, &fixture).await;
    }
    fixture.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_interrupts_an_unresponsive_handshake() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let ssh = service(home.path(), "handshake");
    let ticket = ssh
        .prepare(
            "open".into(),
            Action::Connect(Target {
                host: "127.0.0.1".into(),
                user: None,
                port: Some(port),
            }),
            120_000,
        )
        .unwrap();
    let (mut tcp, _) = listener.accept().await.unwrap();
    assert_eq!(ssh.shutdown(2000).unwrap().await["complete"], true);
    assert_eq!(ticket.wait().await.unwrap_err().code, "CANCELLED");
    let mut bytes = Vec::new();
    use tokio::io::AsyncReadExt;
    tokio::time::timeout(Duration::from_secs(1), tcp.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_agent_transport_signs_with_a_configured_identity_without_a_private_file() {
    let _serial = SERIAL.lock().await;
    let home = tempfile::tempdir().unwrap();
    let fixture = Fixture::start(None).await;
    let dir = home.path().join(".ssh");
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(
        dir.join("config"),
        "Host *\n IdentityFile ~/.ssh/agent-only\n IdentitiesOnly yes\n BatchMode yes\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("agent-only.pub"),
        fixture.client_key.public_key().to_openssh().unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    let agent_path = home.path().join("agent.sock");
    #[cfg(unix)]
    let listener = tokio::net::UnixListener::bind(&agent_path).unwrap();
    #[cfg(windows)]
    let agent_path = std::path::PathBuf::from(format!(
        r"\\.\pipe\klaus-ssh-fixture-{}",
        std::process::id()
    ));
    #[cfg(windows)]
    let listener = tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&agent_path)
        .unwrap();
    let key = fixture.client_key.clone();
    let agent = tokio::spawn(async move {
        #[cfg(unix)]
        let (stream, _) = listener.accept().await.unwrap();
        #[cfg(windows)]
        let stream = {
            listener.connect().await.unwrap();
            listener
        };
        fixture_agent(stream, key).await
    });
    let ssh = SshService::new(
        "agent".into(),
        SshOptions {
            user_home: home.path().into(),
            local_user: "fixture".into(),
            agent_path: Some(agent_path),
        },
    )
    .unwrap();
    ssh.prepare(
        "connect".into(),
        Action::Connect(target(&fixture, "fixture")),
        5000,
    )
    .unwrap()
    .wait()
    .await
    .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), agent)
            .await
            .unwrap()
            .unwrap(),
        1
    );
    assert_eq!(ssh.report()["lastSequence"], 0);
    stopped(&ssh, &fixture).await;
    fixture.stop().await;
}

/// A bounded test implementation of SSH_AGENTC_REQUEST_IDENTITIES and SSH_AGENTC_SIGN_REQUEST.
async fn fixture_agent(
    mut stream: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    key: PrivateKey,
) -> usize {
    use russh::keys::signature::Signer;
    use russh::keys::ssh_encoding::Encode;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn field(out: &mut Vec<u8>, value: &[u8]) {
        out.extend_from_slice(&(value.len() as u32).to_be_bytes());
        out.extend_from_slice(value);
    }
    fn take<'a>(bytes: &mut &'a [u8]) -> &'a [u8] {
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let value = &bytes[4..4 + length];
        *bytes = &bytes[4 + length..];
        value
    }
    let public = key.public_key().to_bytes().unwrap();
    let mut signatures = 0;
    while let Ok(size) = stream.read_u32().await {
        assert!(size <= 256 * 1024);
        let mut bytes = vec![0; size as usize];
        stream.read_exact(&mut bytes).await.unwrap();
        let response = match bytes[0] {
            11 => {
                let mut out = vec![12];
                out.extend_from_slice(&1u32.to_be_bytes());
                field(&mut out, &public);
                field(&mut out, b"synthetic identity");
                out
            }
            13 => {
                let mut input = &bytes[1..];
                assert_eq!(take(&mut input), public);
                let data = take(&mut input);
                assert_eq!(input, 0u32.to_be_bytes());
                let signature: russh::keys::ssh_key::Signature = key.try_sign(data).unwrap();
                let mut encoded = Vec::new();
                signature.encode(&mut encoded).unwrap();
                let mut out = vec![14];
                field(&mut out, &encoded);
                signatures += 1;
                out
            }
            other => panic!("unexpected agent request {other}"),
        };
        stream.write_u32(response.len() as u32).await.unwrap();
        stream.write_all(&response).await.unwrap();
        stream.flush().await.unwrap();
    }
    signatures
}

#[test]
fn known_hosts_rejects_changed_revoked_and_unwritable_keys_and_supports_hashes() {
    let home = tempfile::tempdir().unwrap();
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let endpoint = Endpoint {
        host: "example.test".into(),
        port: 2222,
        user: "fixture".into(),
        identity_files: vec![],
        known_hosts: home.path().join("known_hosts"),
        agent: None,
        identities_only: false,
        batch_mode: false,
        accept_new: true,
    };
    known_hosts::check(&endpoint, key.public_key()).unwrap();
    let saved = std::fs::read(&endpoint.known_hosts).unwrap();
    known_hosts::check(&endpoint, key.public_key()).unwrap();
    assert_eq!(std::fs::read(&endpoint.known_hosts).unwrap(), saved);
    assert_eq!(
        known_hosts::check(&endpoint, other.public_key())
            .unwrap_err()
            .code,
        "SSH_HOST_KEY_CHANGED"
    );
    let salt = b"fixture known host salt";
    let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
    mac.update(b"[example.test]:2222");
    let base64 = base64::engine::general_purpose::STANDARD;
    let hashed = format!(
        "|1|{}|{} {}\n",
        base64.encode(salt),
        base64.encode(mac.finalize().into_bytes()),
        key.public_key().to_openssh().unwrap()
    );
    std::fs::write(&endpoint.known_hosts, &hashed).unwrap();
    known_hosts::check(&endpoint, key.public_key()).unwrap();
    std::fs::write(
        &endpoint.known_hosts,
        format!(
            "{hashed}@revoked [example.test]:2222 {}\n",
            key.public_key().to_openssh().unwrap()
        ),
    )
    .unwrap();
    assert_eq!(
        known_hosts::check(&endpoint, key.public_key())
            .unwrap_err()
            .code,
        "SSH_HOST_KEY_REVOKED"
    );
    std::fs::write(&endpoint.known_hosts, b"broken record").unwrap();
    assert_eq!(
        known_hosts::check(&endpoint, key.public_key())
            .unwrap_err()
            .code,
        "SSH_KNOWN_HOSTS_INVALID"
    );
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&endpoint.known_hosts)
        .unwrap();
    locked.lock().unwrap();
    assert_eq!(
        known_hosts::check(&endpoint, key.public_key())
            .unwrap_err()
            .code,
        "SSH_KNOWN_HOSTS_BUSY"
    );
}
