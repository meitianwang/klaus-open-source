use super::*;
use tempfile::tempdir;

#[tokio::test]
async fn unopened_resource_closes_and_refuses_new_work() {
    let root = tempdir().unwrap();
    let service = WhatsAppService::new(
        "resource".into(),
        Options {
            auth_dir: root.path().join("auth"),
        },
    )
    .unwrap();
    let event = service.read_event().unwrap();
    assert_eq!(
        service.read_event().err().unwrap().code,
        "WHATSAPP_EVENT_READER_BUSY"
    );
    let report = service.shutdown(3000).unwrap().await;
    assert_eq!(report["complete"], true);
    assert!(event.await.unwrap().is_none());
    assert!(!root.path().join("auth").exists());
    assert_eq!(
        service
            .prepare("late".into(), Action::Open, 1000)
            .err()
            .unwrap()
            .code,
        "CLOSED"
    );
}
#[tokio::test]
async fn event_flood_fails_visibly_and_has_a_hard_memory_bound() {
    let root = tempdir().unwrap();
    let service = WhatsAppService::new(
        "flood".into(),
        Options {
            auth_dir: root.path().into(),
        },
    )
    .unwrap();
    for _ in 0..129 {
        service
            .shared
            .publish(json!({"kind":"qr","code":"synthetic","expiresInMs":1000}));
    }
    assert_eq!(service.report()["error"], "WHATSAPP_EVENT_QUEUE_FULL");
    assert!(service.report()["queuedEvents"].as_u64().unwrap() <= 128);
    assert_eq!(service.shutdown(3000).unwrap().await["complete"], true);
}
#[test]
fn profile_preserves_existing_bytes_and_rejects_duplicate_owners() {
    let root = tempdir().unwrap();
    let dir = root.path().join("auth");
    std::fs::create_dir(&dir).unwrap();
    let bytes = b"existing SQLite profile sentinel";
    std::fs::write(dir.join("store.db"), bytes).unwrap();
    let first = Profile::acquire(&dir).unwrap();
    assert_eq!(
        Profile::acquire(&dir).err().unwrap().code,
        "WHATSAPP_PROFILE_BUSY"
    );
    assert_eq!(std::fs::read(dir.join("store.db")).unwrap(), bytes);
    drop(first);
    assert!(Profile::acquire(&dir).is_ok());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
#[test]
fn legacy_and_symlink_profiles_are_not_replaced() {
    let root = tempdir().unwrap();
    std::fs::write(root.path().join("creds.json"), b"legacy").unwrap();
    assert_eq!(
        Profile::acquire(root.path()).err().unwrap().code,
        "WHATSAPP_LEGACY_PROFILE_REQUIRES_PAIRING"
    );
    assert!(!root.path().join("store.db").exists());
    #[cfg(unix)]
    {
        let target = root.path().join("outside");
        std::fs::write(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, root.path().join("store.db")).unwrap();
        assert_eq!(
            Profile::acquire(root.path()).err().unwrap().code,
            "WHATSAPP_PROFILE_INVALID_FILE"
        );
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    }
}
#[test]
fn projection_limits_qr_payload_before_queue_admission() {
    use wacore::types::events::Event;
    assert_eq!(
        events::project(&Event::PairingQrCode {
            code: "x".repeat(4097),
            timeout: Duration::from_secs(60)
        })
        .err()
        .unwrap()
        .code,
        "WHATSAPP_EVENT_SIZE_LIMIT"
    );
    let projected = events::project(&Event::PairingQrCode {
        code: "synthetic,keys".into(),
        timeout: Duration::from_secs(60),
    })
    .unwrap()
    .unwrap();
    assert_eq!(projected["expiresInMs"], 60_000);
}

#[tokio::test]
async fn scoped_runtime_waits_for_a_cancelled_tasks_actual_blocking_work() {
    let root = tempdir().unwrap();
    let service = WhatsAppService::new(
        "runtime-scope".into(),
        Options {
            auth_dir: root.path().into(),
        },
    )
    .unwrap();
    let scope = ScopedRuntime::new(&service.shared);
    let (release, wait) = std::sync::mpsc::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let operation = scope.spawn_blocking(Box::new(move || {
        let _ = started.send(());
        let _ = wait.recv();
    }));
    let task = tokio::spawn(operation);
    ready.await.unwrap();
    task.abort();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), scope.close())
            .await
            .is_err()
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), scope.close())
        .await
        .unwrap();
    let ran = Arc::new(AtomicBool::new(false));
    let copy = Arc::clone(&ran);
    scope
        .spawn(Box::pin(async move {
            copy.store(true, Ordering::Release);
        }))
        .detach();
    tokio::task::yield_now().await;
    assert!(!ran.load(Ordering::Acquire));
    assert_eq!(service.shutdown(3000).unwrap().await["complete"], true);
}
