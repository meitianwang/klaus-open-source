use super::*;
use std::sync::atomic::AtomicU64;

struct Identity(String);
impl Identity {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        Self(format!(
            "ai.klaus.instance-fixture.{}.{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn options(&self) -> Options {
        Options {
            identity: self.0.clone(),
            cwd: "/fixture".into(),
            args: vec!["Klaus".into(), "klaus://settings".into()],
            timeout_ms: 2000,
        }
    }
    #[cfg(target_os = "macos")]
    fn socket(&self) -> String {
        format!("/tmp/{}_si.sock", self.0.replace(['.', '-'], "_"))
    }
}
impl Drop for Identity {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            let _ = std::fs::remove_file(self.socket());
            let _ = std::fs::remove_file(format!(
                "/tmp/{}_electron_si.lock",
                self.0.replace(['.', '-'], "_")
            ));
        }
    }
}

#[tokio::test]
async fn receiver_is_ready_before_sync_acquire_returns_and_secondary_cannot_release_it() {
    let identity = Identity::new();
    let primary = InstanceGuard::acquire_sync(identity.options()).unwrap();
    assert!(primary.acquisition().acquired);
    primary.assert_held().unwrap();
    let secondary = InstanceGuard::acquire_sync(identity.options()).unwrap();
    assert!(!secondary.acquisition().acquired);
    assert!(secondary.acquisition().forwarded && secondary.acquisition().acknowledged);
    assert!(secondary.close_sync(2000).unwrap().complete);
    primary.assert_held().unwrap();
    let event = tokio::time::timeout(Duration::from_secs(1), primary.read_event().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(event, Event::Activation { args, .. } if args == identity.options().args));
    assert!(primary.close_sync(2000).unwrap().complete);
    let next = InstanceGuard::acquire_sync(identity.options()).unwrap();
    assert!(next.acquisition().acquired);
    assert!(next.close_sync(2000).unwrap().complete);
}

#[test]
fn simultaneous_acquisitions_have_exactly_one_primary() {
    let identity = Identity::new();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let hold = Arc::new(std::sync::Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let options = identity.options();
            let barrier = barrier.clone();
            let hold = hold.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let guard = InstanceGuard::acquire_sync(options);
                let primary = guard
                    .as_ref()
                    .is_ok_and(|guard| guard.acquisition().acquired);
                hold.wait();
                let guard = guard.unwrap();
                assert!(guard.close_sync(2000).unwrap().complete);
                primary
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .filter_map(|thread| thread.join().unwrap().then_some(()))
            .count(),
        1
    );
}

#[tokio::test]
async fn cancelled_event_reader_releases_its_slot_and_close_drains_pending_read() {
    let identity = Identity::new();
    let guard = InstanceGuard::acquire_sync(identity.options()).unwrap();
    let read = guard.read_event().unwrap();
    assert!(guard.read_event().is_err());
    drop(read);
    let read = guard.read_event().unwrap();
    assert!(guard.close_sync(2000).unwrap().complete);
    assert!(tokio::time::timeout(Duration::from_secs(1), read)
        .await
        .unwrap()
        .is_none());
}

#[cfg(target_os = "macos")]
#[test]
fn unknown_orphan_and_foreign_replacement_are_never_unlinked() {
    use std::os::unix::net::UnixListener;
    let identity = Identity::new();
    let orphan = UnixListener::bind(identity.socket()).unwrap();
    drop(orphan);
    let failure = InstanceGuard::acquire_sync(identity.options())
        .err()
        .unwrap();
    assert_eq!(failure.code, "INSTANCE_UNKNOWN_ORPHAN");
    assert!(std::path::Path::new(&identity.socket()).exists());
    std::fs::remove_file(identity.socket()).unwrap();
    let primary = InstanceGuard::acquire_sync(identity.options()).unwrap();
    std::fs::remove_file(identity.socket()).unwrap();
    let foreign = UnixListener::bind(identity.socket()).unwrap();
    assert!(primary.assert_held().is_err());
    assert!(!primary.report().complete);
    use std::os::fd::AsRawFd;
    let lease = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!(
            "/tmp/{}_electron_si.lock",
            identity.0.replace(['.', '-'], "_")
        ))
        .unwrap();
    assert_ne!(
        unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0,
        "data-owner lease remains held after loss"
    );
    assert!(primary.close_sync(2000).unwrap().complete);
    assert_eq!(
        unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0,
        "explicit close releases the surviving lease"
    );
    assert!(std::path::Path::new(&identity.socket()).exists());
    drop(foreign);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn slow_and_oversized_senders_are_bounded_and_do_not_starve_close() {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    let identity = Identity::new();
    let primary = InstanceGuard::acquire_sync(identity.options()).unwrap();
    let mut oversized = UnixStream::connect(identity.socket()).unwrap();
    let _ = oversized.write_all(&vec![b'x'; MAX_PAYLOAD + 1]);
    drop(oversized);
    let slow: Vec<_> = (0..8)
        .map(|_| UnixStream::connect(identity.socket()).unwrap())
        .collect();
    let read = primary.read_event().unwrap();
    assert!(primary.close_sync(1000).unwrap().complete);
    assert!(read.await.is_none());
    drop(slow);
}

#[test]
fn bounded_native_queue_rejects_overflow_without_losing_guard() {
    let shared = Shared::new();
    for _ in 0..MAX_EVENTS {
        assert!(shared.activation(String::new(), vec!["Klaus".into()]));
    }
    assert!(!shared.activation(String::new(), vec!["Klaus".into()]));
    shared.fail("INSTANCE_ENDPOINT_LOST");
    let state = shared.state.lock().unwrap();
    assert_eq!(state.events.len(), 1);
    assert!(matches!(state.events.front(), Some(Event::Lost { .. })));
}

#[cfg(target_os = "macos")]
#[test]
fn a_zombie_owner_endpoint_is_recovered_instead_of_wedging_the_profile() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixListener;
    let identity = Identity::new();
    // The recorded owner must be a real zombie: a child that exits while this
    // test, its parent, deliberately declines to reap it.
    let mut child = std::process::Command::new("/bin/sleep").arg("0").spawn().unwrap();
    let zombie = child.id();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        super::macos::process_status(zombie),
        Some(libc::SZOMB as u8),
        "the fixture child must read as a zombie",
    );
    assert!(super::macos::owner_is_gone(zombie), "a zombie owner reads as gone");
    assert!(!super::macos::owner_is_gone(std::process::id()), "a live pid reads as present");

    // Stage the endpoint exactly as a dead primary would leave it: an owned,
    // unanswered socket file plus a lease record naming the zombie as owner.
    let socket_path = identity.socket();
    let listener = UnixListener::bind(&socket_path).unwrap();
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let meta = std::fs::symlink_metadata(&socket_path).unwrap();
    let owner = serde_json::json!({
        "version": 1,
        "pid": zombie,
        "socket": { "path": socket_path, "device": meta.dev(), "inode": meta.ino(), "uid": meta.uid() },
        "staging": format!("/tmp/klaus-si-{}-{}-9.sock", unsafe { libc::geteuid() }, std::process::id()),
    });
    let lock_path = format!("/tmp/{}_electron_si.lock", identity.0.replace(['.', '-'], "_"));
    std::fs::write(&lock_path, owner.to_string()).unwrap();
    std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    drop(listener);

    // Before this fix the same state returned INSTANCE_UNKNOWN_ORPHAN until an
    // unrelated process happened to reap the corpse.
    let guard = InstanceGuard::acquire_sync(identity.options()).unwrap();
    assert!(guard.acquisition().acquired);
    assert!(guard.close_sync(2000).unwrap().complete);
    assert!(!std::path::Path::new(&socket_path).exists(), "the recovered endpoint is cleaned");
    let _ = child.wait();
}
