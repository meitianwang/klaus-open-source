#![cfg(windows)]

use klaus_native_core::{
    pty::{Event, Pty, StartOptions},
    Runtime,
};
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows_sys::Win32::{
    Foundation::*,
    System::{Console::*, Threading::*},
};

fn options(root: &Path, id: &str, mode: &str) -> StartOptions {
    StartOptions {
        resource_id: id.into(),
        cwd: root.into(),
        command: std::env::current_exe().unwrap().to_string_lossy().into(),
        args: vec![
            "--ignored".into(),
            "--exact".into(),
            "conpty_fixture_entry".into(),
            "--nocapture".into(),
        ],
        env: vec![("KLAUS_CONPTY_FIXTURE_MODE".into(), mode.into())],
        cols: 80,
        rows: 24,
        deadline_ms: 10000,
    }
}

async fn next(resource: &Pty) -> Option<Event> {
    tokio::time::timeout(Duration::from_secs(15), resource.next_event())
        .await
        .unwrap_or_else(|error| panic!("{error}: {:?}", resource.snapshot()))
        .unwrap()
}
async fn drain(resource: &Pty, mut sequence: u32) -> (Vec<u8>, Event) {
    let mut bytes = Vec::new();
    let mut exit = None;
    while let Some(event) = next(resource).await {
        sequence += 1;
        assert_eq!(event.sequence, sequence);
        assert_eq!(event.resource_id, resource.id());
        bytes.extend_from_slice(&event.data);
        if event.kind == "exit" {
            exit = Some(event);
        }
    }
    (bytes, exit.expect("one terminal event"))
}
async fn marker(resource: &Pty, marker: &str) -> (String, u32) {
    let mut bytes = Vec::new();
    let mut sequence = 0;
    loop {
        let event = next(resource).await.expect("fixture must remain open");
        sequence += 1;
        assert_eq!(event.sequence, sequence);
        assert_eq!(event.kind, "data", "{event:?}");
        bytes.extend(event.data);
        let text = String::from_utf8_lossy(&bytes);
        if text.contains(marker) {
            return (text.into(), sequence);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conpty_utf8_input_resize_exit_and_idempotent_close() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(options(temp.path(), "interactive", "interactive"))
        .unwrap();
    let info = resource.wait_ready().unwrap();
    assert_ne!(info.pid, std::process::id());
    let (_, sequence) = marker(&resource, "READY").await;
    let resize = resource
        .resize("resize".into(), 97, 31, 3000)
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(resize.operation_id, "resize");
    assert_eq!(resize.resource_id, "interactive");
    let write = resource
        .write("write".into(), "你好\r".as_bytes().to_vec(), 3000)
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(write.bytes_written, 7);
    assert_eq!(write.operation_id, "write");
    let (bytes, exit) = drain(&resource, sequence).await;
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("INPUT:你好"), "{text:?}");
    assert!(text.contains("SIZE:97x31"), "{text:?}");
    assert_eq!(exit.exit_code, 7);
    assert!(exit.output_complete, "{exit:?}");
    let report = resource.close(2000).unwrap();
    assert!(report.complete, "{report:?}");
    assert_eq!(report.bytes_read, report.bytes_emitted);
    assert_eq!(
        report.last_sequence,
        resource.close(2000).unwrap().last_sequence
    );
    assert!(resource.next_event().await.unwrap().is_none());
    assert!(runtime.release_pty("interactive"));
    assert_eq!(runtime.counts(), (0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conpty_slow_consumer_bounds_output_and_preserves_the_full_printable_stream() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let mut input = options(temp.path(), "flood", "flood");
    // Keep lines narrower than the console. ConPTY may repaint a wrap-boundary glyph in VT.
    input.cols = 140;
    let resource = runtime.start_pty(input).unwrap();
    resource.wait_ready().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while resource.snapshot().peak_queue_chunks < 64 && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let held = resource.snapshot();
    assert_eq!(held.peak_queue_chunks, 64, "{held:?}");
    assert!(held.bytes_read <= 65 * 16384, "{held:?}");
    let (bytes, exit) = drain(&resource, 0).await;
    // ConPTY adds VT control sequences and normalizes line endings, but must keep these glyphs.
    assert_eq!(
        bytes.iter().filter(|byte| **byte == b'Q').count(),
        3 * 1024 * 1024
    );
    assert_eq!(exit.exit_code, 0);
    let report = resource.close(2000).unwrap();
    assert!(report.complete, "{report:?}");
    assert_eq!(report.discarded_bytes, 0);
    assert!(report.peak_queue_chunks <= 65);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conpty_deadline_close_reports_incomplete_output_and_releases_the_worker() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(options(temp.path(), "stalled", "flood"))
        .unwrap();
    resource.wait_ready().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while resource.snapshot().peak_queue_chunks < 64 && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let start = Instant::now();
    let report = resource.close(100).unwrap();
    assert!(start.elapsed() < Duration::from_millis(500));
    assert!(!report.complete, "{report:?}");
    let (_, exit) = drain(&resource, 0).await;
    assert!(!exit.output_complete, "{exit:?}");
    assert!(resource.is_done());
    assert!(runtime.release_pty("stalled"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conpty_resize_under_output_pressure_does_not_block_deadline_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(options(temp.path(), "resize-pressure", "flood"))
        .unwrap();
    resource.wait_ready().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while resource.snapshot().peak_queue_chunks < 64 && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(resource.snapshot().peak_queue_chunks, 64);
    for id in 0..200 {
        let result = resource
            .resize(format!("resize-{id}"), 80 + (id % 2), 24, 25)
            .unwrap()
            .wait();
        if let Err(error) = result {
            assert_eq!(error.code, "DEADLINE_EXCEEDED");
            break;
        }
    }
    let start = Instant::now();
    assert!(!resource.close(100).unwrap().complete);
    assert!(start.elapsed() < Duration::from_millis(500));
    let (_, exit) = drain(&resource, 0).await;
    assert!(!exit.output_complete);
    assert!(resource.is_done());
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn process_handle(pid: u32) -> OwnedHandle {
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    assert!(!handle.is_null());
    unsafe { OwnedHandle::from_raw_handle(handle) }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conpty_close_reaps_descendants_and_cancels_writes_without_touching_unrelated_children() {
    let sentinel = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "conpty_fixture_entry",
            "--nocapture",
        ])
        .env("KLAUS_CONPTY_FIXTURE_MODE", "sleeper")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut sentinel = ChildGuard(sentinel);
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(options(temp.path(), "tree", "tree"))
        .unwrap();
    let info = resource.wait_ready().unwrap();
    let root_handle = process_handle(info.pid);
    let (text, _) = marker(&resource, ":DESC_END").await;
    let descendant: u32 = text
        .split("DESC:")
        .nth(1)
        .unwrap()
        .split(":DESC_END")
        .next()
        .unwrap()
        .parse()
        .unwrap();
    let descendant_handle = process_handle(descendant);
    let ticket = resource
        .write("cancel-input".into(), vec![b'x'; 65536], 3000)
        .unwrap();
    assert!(resource.cancel_operation("cancel-input"));
    let error = ticket.wait().unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert!(error.message.contains("bytesWritten="));
    let consumer = Arc::clone(&resource);
    let draining = tokio::spawn(async move { while next(&consumer).await.is_some() {} });
    let report = resource.close(5000).unwrap();
    assert!(report.complete, "{report:?}");
    draining.await.unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(root_handle.as_raw_handle(), 0) },
        WAIT_OBJECT_0
    );
    assert_eq!(
        unsafe { WaitForSingleObject(descendant_handle.as_raw_handle(), 0) },
        WAIT_OBJECT_0
    );
    assert!(sentinel.0.try_wait().unwrap().is_none());
    assert!(!resource.cancel_operation("cancel-input"));
}

#[test]
fn conpty_failed_spawn_is_releasable() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let mut input = options(temp.path(), "bad-executable", "");
    input.command = temp
        .path()
        .join("does-not-exist.exe")
        .to_string_lossy()
        .into();
    let resource = runtime.start_pty(input).unwrap();
    assert_eq!(resource.wait_ready().unwrap_err().code, "PTY_SPAWN_FAILED");
    assert!(resource.is_done());
    assert!(runtime.release_pty("bad-executable"));
}

// The integration tests invoke this entry in their explicitly owned ConPTY/sentinel processes.
#[test]
#[ignore = "child-only fixture entry; invoked by the ConPTY integration tests"]
fn conpty_fixture_entry() {
    let mode = std::env::var("KLAUS_CONPTY_FIXTURE_MODE").expect("fixture mode required");
    if mode == "sleeper" {
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    unsafe {
        assert_ne!(SetConsoleCP(65001), 0);
        assert_ne!(SetConsoleOutputCP(65001), 0);
        assert_ne!(
            SetConsoleMode(
                GetStdHandle(STD_INPUT_HANDLE),
                ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT
            ),
            0
        );
        assert_ne!(
            SetConsoleMode(
                GetStdHandle(STD_OUTPUT_HANDLE),
                ENABLE_PROCESSED_OUTPUT
                    | ENABLE_WRAP_AT_EOL_OUTPUT
                    | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            ),
            0
        );
    }
    match mode.as_str() {
        "interactive" => {
            print!("READY\r\n");
            std::io::stdout().flush().unwrap();
            let mut bytes = Vec::new();
            let mut input = std::io::stdin().lock();
            loop {
                let mut byte = [0];
                input.read_exact(&mut byte).unwrap();
                if byte[0] == b'\n' {
                    break;
                }
                if byte[0] != b'\r' {
                    bytes.push(byte[0]);
                }
            }
            let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
            assert_ne!(
                unsafe { GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) },
                0
            );
            println!("INPUT:{}", String::from_utf8(bytes).unwrap());
            println!(
                "SIZE:{}x{}",
                info.srWindow.Right - info.srWindow.Left + 1,
                info.srWindow.Bottom - info.srWindow.Top + 1
            );
            std::io::stdout().flush().unwrap();
            std::process::exit(7);
        }
        "flood" => {
            let mut output = std::io::stdout().lock();
            let line = [b'Q'; 128];
            for _ in 0..(3 * 1024 * 1024 / 128) {
                output.write_all(&line).unwrap();
                output.write_all(b"\r\n").unwrap();
            }
            output.flush().unwrap();
            std::process::exit(0);
        }
        "tree" => {
            let child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "conpty_fixture_entry",
                    "--nocapture",
                ])
                .env("KLAUS_CONPTY_FIXTURE_MODE", "sleeper")
                .spawn()
                .unwrap();
            println!("DESC:{}:DESC_END", child.id());
            std::io::stdout().flush().unwrap();
            let mut child = child;
            let _ = child.wait();
        }
        _ => panic!("unknown fixture mode"),
    }
}
