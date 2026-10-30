use super::{error, protocol, Acquisition, Options, Shared, MAX_PAYLOAD};
use crate::Result;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc::SyncSender, Arc};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Witness {
    path: PathBuf,
    device: u64,
    inode: u64,
    uid: u32,
}
impl Witness {
    fn read(path: &Path) -> Result<Self> {
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| error("INSTANCE_ENDPOINT_UNREADABLE"))?;
        if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
            return Err(error("INSTANCE_ENDPOINT_UNTRUSTED"));
        }
        Ok(Self {
            path: path.into(),
            device: meta.dev(),
            inode: meta.ino(),
            uid: meta.uid(),
        })
    }
    fn matches(&self) -> bool {
        std::fs::symlink_metadata(&self.path).is_ok_and(|meta| {
            meta.file_type().is_socket()
                && meta.dev() == self.device
                && meta.ino() == self.inode
                && meta.uid() == self.uid
        })
    }
    fn remove(&self) -> Result<()> {
        // Never unlink a replaced endpoint or an unknown legacy orphan.
        if self.matches() {
            std::fs::remove_file(&self.path).map_err(|_| error("INSTANCE_CLEANUP_FAILED"))?;
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    version: u32,
    pid: u32,
    socket: Witness,
    staging: PathBuf,
}

/// Byte layout of the kernel's per-process record published by
/// `sysctl(CTL_KERN, KERN_PROC, KERN_PROC_PID)`. The libc bindings ship no
/// `struct kinfo_proc` for this platform, so the two fields this check needs are
/// read at their documented offsets: `kp_proc.p_stat` at 36 and `kp_proc.p_pid`
/// at 40. The kernel only ever fills a whole record and refuses a short buffer,
/// so the record size is queried first and the status byte comes from a full read.
const KINFO_PROC_P_STAT_OFFSET: usize = 36;
const KINFO_PROC_P_PID_OFFSET: usize = 40;

pub(super) fn process_status(pid: u32) -> Option<u8> {
    let mut mib = [
        libc::CTL_KERN,
        libc::KERN_PROC,
        libc::KERN_PROC_PID,
        pid as libc::c_int,
    ];
    let mut size: libc::size_t = 0;
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 4, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    if size <= KINFO_PROC_P_PID_OFFSET + 4 {
        return None;
    }
    let mut record = vec![0u8; size];
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 4, record.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    if size <= KINFO_PROC_P_PID_OFFSET + 4 {
        return None;
    }
    let reported = i32::from_ne_bytes(
        record[KINFO_PROC_P_PID_OFFSET..KINFO_PROC_P_PID_OFFSET + 4]
            .try_into()
            .ok()?,
    );
    if reported != pid as i32 {
        return None;
    }
    Some(record[KINFO_PROC_P_STAT_OFFSET])
}

/// Whether a recorded owner pid can no longer serve its endpoint.
///
/// `kill(pid, 0)` alone is not enough: a child that exited while its parent was
/// stopped (or otherwise never reaped it) stays a zombie, and a zombie pid still
/// answers signal 0 even though its listener died with it. Treating that pid as
/// live wedges the profile behind `INSTANCE_UNKNOWN_ORPHAN` until some unrelated
/// process happens to reap the corpse, so the kernel's own process status is the
/// second half of the check. Anything the kernel cannot classify keeps the
/// fail-closed reading: an unknown pid state must look alive, never dead.
pub(super) fn owner_is_gone(pid: u32) -> bool {
    if unsafe { libc::kill(pid as _, 0) } == -1 {
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    }
    process_status(pid) == Some(libc::SZOMB as u8)
}

struct OwnedSocket {
    witness: Witness,
    listener: UnixListener,
}
impl Drop for OwnedSocket {
    fn drop(&mut self) {
        let _ = self.witness.remove();
    }
}

pub(super) fn held(shared: &Shared) -> bool {
    shared
        .witness
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(Witness::matches)
}

enum Lease {
    Owned(File),
    Existing(Acquisition),
}

fn lease(
    path: &Path,
    endpoint: &Path,
    options: &Options,
    deadline: Instant,
    shared: &Shared,
) -> Result<Lease> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| error("INSTANCE_LEASE_UNAVAILABLE"))?;
    let meta = file
        .metadata()
        .map_err(|_| error("INSTANCE_LEASE_UNAVAILABLE"))?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
    {
        return Err(error("INSTANCE_LEASE_UNTRUSTED"));
    }
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Lease::Owned(file));
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::WouldBlock {
            return Err(error("INSTANCE_LEASE_UNAVAILABLE"));
        }
        if let Some(result) = forward(endpoint, options, deadline)? {
            return Ok(Lease::Existing(result));
        }
        if shared.stopping.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err(error("INSTANCE_LEASE_BUSY"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn peer_is_current_user(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (0, 0);
    unsafe {
        libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid()
    }
}

fn poll_fd(fd: i32, events: i16, deadline: Instant) -> std::io::Result<()> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let mut poll = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().clamp(1, i32::MAX as u128) as i32,
            )
        };
        if result > 0 {
            return Ok(());
        }
        if result == 0 {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn connect(path: &Path, deadline: Instant) -> std::io::Result<UnixStream> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= address.sun_path.len() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    address.sun_family = libc::AF_UNIX as _;
    address.sun_len = std::mem::size_of::<libc::sockaddr_un>() as _;
    for (out, byte) in address.sun_path.iter_mut().zip(bytes) {
        *out = *byte as _;
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    stream.set_nonblocking(true)?;
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let result = unsafe {
        libc::connect(
            fd,
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as _,
        )
    };
    if result != 0 {
        let failure = std::io::Error::last_os_error();
        if failure.raw_os_error() != Some(libc::EINPROGRESS)
            && failure.kind() != std::io::ErrorKind::WouldBlock
        {
            return Err(failure);
        }
        poll_fd(fd, libc::POLLOUT, deadline)?;
        let mut socket_error: i32 = 0;
        let mut size = std::mem::size_of::<i32>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut socket_error as *mut i32).cast(),
                &mut size,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if socket_error != 0 {
            return Err(std::io::Error::from_raw_os_error(socket_error));
        }
    }
    Ok(stream)
}

fn forward(path: &Path, options: &Options, deadline: Instant) -> Result<Option<Acquisition>> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => {
            Witness::read(path)?;
        }
    }
    let mut stream = match connect(path, deadline) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
            ) =>
        {
            return Ok(None)
        }
        Err(_) => return Err(error("INSTANCE_ACTIVATION_FAILED")),
    };
    if !peer_is_current_user(&stream) {
        return Err(error("INSTANCE_ENDPOINT_UNTRUSTED"));
    }
    let bytes = protocol::encode_macos(options);
    let mut written = 0;
    while written < bytes.len() {
        match stream.write(&bytes[written..]) {
            Ok(0) => return Err(error("INSTANCE_ACTIVATION_FAILED")),
            Ok(count) => written += count,
            Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => {
                poll_fd(stream.as_raw_fd(), libc::POLLOUT, deadline)
                    .map_err(|_| error("INSTANCE_ACTIVATION_TIMEOUT"))?;
            }
            Err(_) => return Err(error("INSTANCE_ACTIVATION_FAILED")),
        }
    }
    stream
        .shutdown(Shutdown::Write)
        .map_err(|_| error("INSTANCE_ACTIVATION_FAILED"))?;
    let ack_deadline = deadline.min(Instant::now() + Duration::from_millis(200));
    let mut ack = Vec::new();
    loop {
        let mut bytes = [0u8; 6];
        match stream.read(&mut bytes) {
            Ok(0) => break,
            Ok(count) => {
                ack.extend_from_slice(&bytes[..count]);
                if ack.len() >= 5 {
                    break;
                }
            }
            Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => {
                if poll_fd(stream.as_raw_fd(), libc::POLLIN, ack_deadline).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(Some(Acquisition {
        acquired: false,
        forwarded: true,
        acknowledged: ack == b"KSI1\n",
    }))
}

fn recover(lease: &mut File, path: &Path) -> Result<()> {
    let mut record = String::new();
    lease
        .seek(SeekFrom::Start(0))
        .map_err(|_| error("INSTANCE_OWNER_UNREADABLE"))?;
    lease
        .take(8193)
        .read_to_string(&mut record)
        .map_err(|_| error("INSTANCE_OWNER_UNREADABLE"))?;
    let owner = serde_json::from_str::<Owner>(&record).ok();
    if let Some(owner) = owner.filter(|o| o.version == 1 && o.socket.path == path && o.pid > 0) {
        // Only a previous guard's recorded inode may be recovered, and only once its
        // process can no longer serve the endpoint. A zombie answers signal 0 even
        // though its listener died with it, so liveness alone is not the test.
        // PID reuse deliberately fails closed.
        if owner_is_gone(owner.pid) {
            owner.socket.remove()?;
            let mut staged = owner.socket;
            staged.path = owner.staging;
            staged.remove()?;
        }
    }
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(error("INSTANCE_UNKNOWN_ORPHAN"));
    }
    Ok(())
}

struct Connection {
    stream: UnixStream,
    bytes: Vec<u8>,
    deadline: Instant,
}

/// The serve loop's wake target, mirroring the Windows message wake: it blocks in
/// `poll` on the listener, the open connections and this pipe, with a bounded
/// witness-check timeout. `stop`/`fail` write one byte to end the block promptly.
pub(super) struct WakePipe {
    read: RawFd,
    write: RawFd,
}

impl WakePipe {
    fn new() -> Result<Self> {
        let mut fds = [0 as RawFd; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(error("INSTANCE_WAKE_FAILED"));
        }
        for fd in fds {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0
                || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0
                || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0
            {
                unsafe {
                    libc::close(fds[0]);
                    libc::close(fds[1]);
                }
                return Err(error("INSTANCE_WAKE_FAILED"));
            }
        }
        Ok(Self {
            read: fds[0],
            write: fds[1],
        })
    }

    /// Drop pending wake bytes before blocking again. A wake that arrives between
    /// this and the next `poll` still leaves its byte queued, so no wake is lost.
    fn drain(&self) {
        let mut buffer = [0u8; 64];
        while unsafe { libc::read(self.read, buffer.as_mut_ptr().cast(), buffer.len()) } > 0 {}
    }

    pub(super) fn read_fd(&self) -> RawFd {
        self.read
    }
}

/// Block until the listener can accept, an open connection is readable, the wake
/// pipe is signalled, or `SERVE_POLL_MS` elapses so the caller rechecks the
/// endpoint witness and the connection deadlines. The caller drains wake bytes
/// before rechecking the stop condition and waiting again.
fn serve_poll(listener: RawFd, wake_fd: RawFd, connections: &mut [Connection]) -> Result<()> {
    let mut fds: Vec<libc::pollfd> = Vec::with_capacity(connections.len() + 2);
    fds.push(libc::pollfd {
        fd: listener,
        events: libc::POLLIN,
        revents: 0,
    });
    fds.push(libc::pollfd {
        fd: wake_fd,
        events: libc::POLLIN,
        revents: 0,
    });
    for connection in connections.iter() {
        fds.push(libc::pollfd {
            fd: connection.stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        });
    }
    // The nearest connection deadline bounds the wait: a deadline must still close
    // its connection on time even though nothing is pending on any descriptor.
    let timeout = connections
        .iter()
        .filter_map(|connection| connection.deadline.checked_duration_since(Instant::now()))
        .min()
        .map_or(SERVE_POLL_MS, |remaining| {
            remaining.as_millis().clamp(1, SERVE_POLL_MS as u128) as i32
        });
    loop {
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if ready >= 0 {
            return Ok(());
        }
        // Not named `error`: that shadows this module's error constructor.
        let failure = std::io::Error::last_os_error();
        if failure.kind() != std::io::ErrorKind::Interrupted {
            return Err(error("INSTANCE_POLL_FAILED"));
        }
    }
}

impl Drop for WakePipe {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.read);
            libc::close(self.write);
        }
    }
}

/// End a blocked `poll` in the serve loop, mirroring the Windows message wake.
/// The pipe stays owned by `Shared` for its whole lifetime, so borrowing it here
/// proves the descriptor is still ours — a published raw fd could already have
/// been closed and handed to something else.
pub(super) fn wake(shared: &Shared) {
    let guard = shared
        .wake
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(pipe) = guard.as_ref() else { return };
    // Non-blocking pipe with a bounded queue: a full pipe means a wake is already
    // pending, so a short write is not an error.
    let _ = unsafe { libc::write(pipe.write, [0u8; 1].as_ptr().cast(), 1) };
}

/// Bound on one idle block. The loop must still notice a replaced endpoint and a
/// stale connection deadline without an event, but it no longer needs to check at
/// the 100 Hz rate that cost an idle primary ~118 wakeups per second.
const SERVE_POLL_MS: i32 = 500;

pub(super) fn run(
    options: &Options,
    deadline: Instant,
    shared: &Arc<Shared>,
    tx: &SyncSender<Result<Acquisition>>,
) -> Result<()> {
    let name = options.identity.replace(['.', '-'], "_");
    let path = PathBuf::from(format!("/tmp/{name}_si.sock"));
    if let Some(result) = forward(&path, options, deadline)? {
        let _ = tx.send(Ok(result));
        return Ok(());
    }
    // This inode is never removed, avoiding the unlink/recreate flock race.
    let lease = lease(
        Path::new(&format!("/tmp/{name}_electron_si.lock")),
        &path,
        options,
        deadline,
        shared,
    )?;
    let mut lease = match lease {
        Lease::Owned(file) => file,
        Lease::Existing(result) => {
            let _ = tx.send(Ok(result));
            return Ok(());
        }
    };
    if let Some(result) = forward(&path, options, deadline)? {
        let _ = tx.send(Ok(result));
        return Ok(());
    }
    recover(&mut lease, &path)?;
    if shared.stopping.load(Ordering::Acquire) {
        return Err(error("INSTANCE_ACQUIRE_TIMEOUT"));
    }
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let staged = PathBuf::from(format!(
        "/tmp/klaus-si-{}-{}-{}.sock",
        unsafe { libc::geteuid() },
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let listener = UnixListener::bind(&staged).map_err(|_| error("INSTANCE_BIND_FAILED"))?;
    let mut socket = OwnedSocket {
        witness: Witness::read(&staged)?,
        listener,
    };
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| error("INSTANCE_BIND_FAILED"))?;
    socket
        .listener
        .set_nonblocking(true)
        .map_err(|_| error("INSTANCE_BIND_FAILED"))?;
    let mut global_witness = socket.witness.clone();
    global_witness.path = path.clone();
    let owner = Owner {
        version: 1,
        pid: std::process::id(),
        socket: global_witness.clone(),
        staging: staged.clone(),
    };
    lease
        .set_len(0)
        .map_err(|_| error("INSTANCE_OWNER_WRITE_FAILED"))?;
    lease
        .seek(SeekFrom::Start(0))
        .map_err(|_| error("INSTANCE_OWNER_WRITE_FAILED"))?;
    serde_json::to_writer(&mut lease, &owner).map_err(|_| error("INSTANCE_OWNER_WRITE_FAILED"))?;
    lease
        .sync_all()
        .map_err(|_| error("INSTANCE_OWNER_WRITE_FAILED"))?;
    let from = std::ffi::CString::new(staged.to_str().unwrap()).unwrap();
    let to = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // The socket is already listening before it becomes discoverable. Never
    // overwrite a concurrently created legacy endpoint.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } != 0 {
        if let Some(result) = forward(&path, options, deadline)? {
            let _ = tx.send(Ok(result));
            return Ok(());
        }
        return Err(error("INSTANCE_PUBLISH_RACE"));
    }
    socket.witness = global_witness.clone();
    *shared.witness.lock().unwrap() = Some(global_witness);
    shared.primary.store(true, Ordering::Release);
    if shared.stopping.load(Ordering::Acquire) {
        return Err(error("INSTANCE_ACQUIRE_TIMEOUT"));
    }
    tx.send(Ok(Acquisition {
        acquired: true,
        forwarded: false,
        acknowledged: false,
    }))
    .map_err(|_| error("INSTANCE_ACQUIRE_TIMEOUT"))?;
    let serving = (|| -> Result<()> {
        let wake = WakePipe::new()?;
        let wake_fd = wake.read_fd();
        *shared
            .wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(wake);
        let mut connections: Vec<Connection> = Vec::new();
        while !shared.stopping.load(Ordering::Acquire) && !shared.failed() {
            if !socket.witness.matches() {
                return Err(error("INSTANCE_ENDPOINT_LOST"));
            }
            for _ in 0..8 {
                match socket.listener.accept() {
                    Ok((stream, _)) if connections.len() < 8 && peer_is_current_user(&stream) => {
                        stream
                            .set_nonblocking(true)
                            .map_err(|_| error("INSTANCE_LISTENER_FAILED"))?;
                        connections.push(Connection {
                            stream,
                            bytes: Vec::new(),
                            deadline: Instant::now() + Duration::from_millis(500),
                        });
                    }
                    Ok(_) => {}
                    Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => return Err(error("INSTANCE_LISTENER_FAILED")),
                }
            }
            // Blocks until a client connects, an open connection is readable, the
            // wake pipe fires, or a connection deadline forces a recheck. An idle
            // primary only wakes for events or the bounded witness-check timeout.
            serve_poll(socket.listener.as_raw_fd(), wake_fd, &mut connections)?;
            // Consume the wake byte before blocking again: leaving it queued would
            // make the next poll return immediately and turn the loop into a spin.
            if let Some(pipe) = shared
                .wake
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
            {
                pipe.drain();
            }
            connections.retain_mut(|connection| {
                if Instant::now() >= connection.deadline {
                    return false;
                }
                loop {
                    let mut buffer = [0u8; 4096];
                    match connection.stream.read(&mut buffer) {
                        Ok(0) => {
                            if let Ok((cwd, args)) = protocol::decode_macos(&connection.bytes) {
                                if shared.activation(cwd, args) {
                                    let _ = connection.stream.write_all(b"KSI1\n");
                                }
                            }
                            return false;
                        }
                        Ok(count) => {
                            connection.bytes.extend_from_slice(&buffer[..count]);
                            if connection.bytes.len() > MAX_PAYLOAD {
                                return false;
                            }
                        }
                        Err(failure) if failure.kind() == std::io::ErrorKind::WouldBlock => {
                            return true
                        }
                        Err(_) => return false,
                    }
                }
            });
            // Read deadlines, close, and endpoint replacement are checked independently
            // of slow or malicious senders. No JS event-loop progress is required, and
            // none is polled for.
        }
        drop(connections);
        *shared
            .wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        Ok(())
    })();
    if let Err(failure) = serving {
        shared.fail(failure.code);
    }
    // The application must close its data owners before even the surviving
    // new-client lease is released. Losing the public endpoint is not shutdown.
    if shared.failed() {
        shared.hold_until_close();
    }
    socket.witness.remove()?;
    drop(socket);
    lease
        .set_len(0)
        .map_err(|_| error("INSTANCE_CLEANUP_FAILED"))?;
    lease
        .sync_all()
        .map_err(|_| error("INSTANCE_CLEANUP_FAILED"))?;
    Ok(())
}

#[cfg(test)]
mod wake_pipe_tests {
    use super::*;

    // Run this in the release profile as well: writing through an immutable
    // pipe-output array made the optimized addon retain fd 0 for both ends.
    #[test]
    fn wake_pipe_preserves_both_descriptors_and_drains_before_blocking() {
        let pipe = WakePipe::new().unwrap();
        assert_ne!(pipe.read, pipe.write, "pipe ends must be distinct");
        for (fd, mode) in [(pipe.read, libc::O_RDONLY), (pipe.write, libc::O_WRONLY)] {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            assert!(flags >= 0, "pipe descriptor must be open");
            assert_eq!(flags & libc::O_ACCMODE, mode);
            assert_ne!(flags & libc::O_NONBLOCK, 0);
            let descriptor_flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            assert!(descriptor_flags >= 0);
            assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
        }

        let mut poll = libc::pollfd {
            fd: pipe.read,
            events: libc::POLLIN,
            revents: 0,
        };
        assert_eq!(unsafe { libc::poll(&mut poll, 1, 0) }, 0);
        assert_eq!(
            unsafe { libc::write(pipe.write, b"w".as_ptr().cast(), 1) },
            1
        );
        assert_eq!(unsafe { libc::poll(&mut poll, 1, 0) }, 1);
        assert_eq!(poll.revents, libc::POLLIN);
        pipe.drain();
        assert_eq!(unsafe { libc::poll(&mut poll, 1, 0) }, 0);
    }
}
