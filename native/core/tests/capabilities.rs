use std::path::Path;
#[cfg(unix)]
use std::sync::Arc;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use klaus_native_core::{
    files::{fuzzy_score, SearchOptions},
    search_session::{QueryOptions, QueryResult, SessionOptions},
    Runtime,
};
#[cfg(unix)]
use klaus_native_core::pty::{Event, Pty, StartOptions};

fn search(root: &Path, id: &str, query: &str, limit: i32) -> SearchOptions {
    SearchOptions {
        operation_id: id.into(),
        root: root.into(),
        query: query.into(),
        limit,
        deadline_ms: 5000,
    }
}

#[test]
fn scoring_vectors_pin_basename_alignment_unicode_and_ties() {
    let cases = [
        ("", "src/a.ts", Some(0)),
        ("zzz", "src/a.ts", None),
        ("a", "src/a.ts", Some(17)),
        ("main", "src/main.rs", Some(38)),
        ("index", "src/index.ts", Some(45)),
        ("index", "src/i-n-d-e-x.ts", Some(40)),
        ("src", "src/a.ts", Some(21)),
        ("ab", "aXbY/zz.ts", Some(8)),
        ("Bar", "fooBar.ts", Some(30)),
        ("été", "ÉTÉ.md", Some(31)),
        ("дан", "Данные.ts", Some(31)),
        ("äb", "ÄB.ts", Some(24)),
    ];
    for (query, target, expected) in cases {
        assert_eq!(fuzzy_score(query, target), expected, "{query}: {target}");
    }
}

#[test]
fn walk_contract_ignores_symlink_cycles_and_sorts_merged_entries() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir_all(root.join("src/deep")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
    std::fs::write(root.join("src/deep/main.rs"), "").unwrap();
    std::fs::write(root.join("src/ignore.log"), "").unwrap();
    std::fs::write(root.join("node_modules/dep/main.rs"), "").unwrap();
    std::fs::write(root.join(".ignore"), "*.log\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root, root.join("src/loop")).unwrap();
    let runtime = Runtime::default();
    let result = runtime
        .prepare_search(search(root, "walk", "", 100))
        .unwrap()
        .run()
        .unwrap();
    let paths: Vec<_> = result
        .hits
        .iter()
        .map(|hit| (hit.rel.as_str(), hit.is_dir))
        .collect();
    assert_eq!(
        paths,
        [
            (".ignore", false),
            ("src", true),
            ("src/deep", true),
            ("src/deep/main.rs", false)
        ]
    );
    assert!(!result.truncated);
    assert_eq!(runtime.counts(), (0, 0));
}

#[test]
fn git_contract_keeps_listed_files_but_skips_derived_dependency_directories() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
    std::fs::create_dir_all(root.join("build")).unwrap();
    std::fs::write(root.join("node_modules/dep/file.ts"), "").unwrap();
    std::fs::write(root.join("build/out.ts"), "").unwrap();
    std::fs::write(root.join("hidden.ts"), "").unwrap();
    std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
    std::fs::write(root.join(".rgignore"), "hidden.ts\n").unwrap();
    let output = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git init: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let runtime = Runtime::default();
    let result = runtime
        .prepare_search(search(root, "git", "", 100))
        .unwrap()
        .run()
        .unwrap();
    let paths: Vec<_> = result.hits.iter().map(|hit| hit.rel.as_str()).collect();
    assert!(paths.contains(&"node_modules/dep/file.ts"), "{paths:?}");
    assert!(!paths.contains(&"node_modules"), "{paths:?}");
    assert!(!paths.contains(&"build/out.ts"), "{paths:?}");
    assert!(!paths.contains(&"hidden.ts"), "{paths:?}");
}

/// The one-shot channel rebuilds the tree on every call, so it must observe
/// changes made since the previous call. The persistent session is the other
/// half of this contract and deliberately does the opposite; see
/// `session_snapshot_is_frozen_while_a_one_shot_search_sees_changes`.
#[test]
fn one_shot_search_rebuilds_and_observes_changes_with_slice_limits() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    for file in ["a", "b", "c"] {
        std::fs::write(temp.path().join(file), "").unwrap();
    }
    assert!(runtime
        .prepare_search(search(temp.path(), "zero", "", 0))
        .unwrap()
        .run()
        .unwrap()
        .hits
        .is_empty());
    let negative = runtime
        .prepare_search(search(temp.path(), "negative", "", -1))
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        negative
            .hits
            .iter()
            .map(|hit| hit.rel.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    std::fs::remove_file(temp.path().join("a")).unwrap();
    std::fs::write(temp.path().join("d"), "").unwrap();
    let fresh = runtime
        .prepare_search(search(temp.path(), "fresh", "", 100))
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        fresh
            .hits
            .iter()
            .map(|hit| hit.rel.as_str())
            .collect::<Vec<_>>(),
        ["b", "c", "d"]
    );
    assert_eq!(runtime.counts(), (0, 0));
}

fn session(id: &str, roots: &[&Path], deadline_ms: u32) -> SessionOptions {
    SessionOptions {
        session_id: id.into(),
        roots: roots.iter().map(|root| (*root).to_path_buf()).collect(),
        deadline_ms,
    }
}

fn query(id: &str, text: &str, limit: i32) -> QueryOptions {
    QueryOptions {
        operation_id: id.into(),
        query: text.into(),
        limit,
        deadline_ms: 5000,
    }
}

fn rels(result: &QueryResult) -> Vec<&str> {
    result.hits.iter().map(|hit| hit.rel.as_str()).collect()
}

/// The session half of the freshness contract: a snapshot is frozen for the
/// session's lifetime, while a one-shot search of the same tree still sees the
/// change. A picker is short-lived, so a file created mid-session is simply not
/// offered until the menu reopens.
#[test]
fn session_snapshot_is_frozen_while_a_one_shot_search_sees_changes() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    for file in ["a", "b", "c"] {
        std::fs::write(temp.path().join(file), "").unwrap();
    }
    let open = runtime
        .prepare_search_session(session("frozen", &[temp.path()], 5000))
        .unwrap();
    assert_eq!(rels(&open.query(query("q1", "", 100)).unwrap()), ["a", "b", "c"]);

    std::fs::remove_file(temp.path().join("a")).unwrap();
    std::fs::write(temp.path().join("d"), "").unwrap();

    // The held snapshot is unchanged in both directions.
    assert_eq!(rels(&open.query(query("q2", "", 100)).unwrap()), ["a", "b", "c"]);
    // A one-shot search over the same root rebuilds and reports the truth.
    let fresh = runtime
        .prepare_search(search(temp.path(), "fresh", "", 100))
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        fresh.hits.iter().map(|hit| hit.rel.as_str()).collect::<Vec<_>>(),
        ["b", "c", "d"]
    );
    assert_eq!(runtime.search_session_count(), 1);
    assert!(runtime.stop_search_session("frozen"));
    assert_eq!(runtime.search_session_count(), 0);
    assert_eq!(runtime.counts(), (0, 0));
}

/// The payload property the session exists for: repeated queries re-rank one
/// snapshot instead of walking the tree again, and produce exactly what the
/// one-shot path produces for the same tree.
#[test]
fn session_reranks_one_snapshot_and_matches_one_shot_ranking() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::create_dir_all(temp.path().join("src/deep")).unwrap();
    for name in ["src/main.rs", "src/deep/index.ts", "README.md", "ÉTÉ.md"] {
        std::fs::write(temp.path().join(name), "").unwrap();
    }
    let open = runtime
        .prepare_search_session(session("ranked", &[temp.path()], 5000))
        .unwrap();

    for (text, limit) in [("", 100), ("main", 10), ("index", 40), ("été", 40), ("zzz", 40)] {
        let via_session = open.query(query("q", text, limit)).unwrap();
        let one_shot = runtime
            .prepare_search(search(temp.path(), "one-shot", text, limit))
            .unwrap()
            .run()
            .unwrap();
        assert_eq!(
            rels(&via_session),
            one_shot.hits.iter().map(|hit| hit.rel.as_str()).collect::<Vec<_>>(),
            "session and one-shot ranking diverged for {text:?} limit {limit}"
        );
        assert_eq!(via_session.scanned, one_shot.scanned, "scanned count diverged for {text:?}");
    }

    // A zero limit short-circuits without scoring, and a negative limit keeps
    // its "all but the last N" meaning — both judged against the one-shot path
    // rather than a hand-counted total, so adding a fixture file cannot break it.
    assert!(open.query(query("zero", "", 0)).unwrap().hits.is_empty());
    let negative = open.query(query("negative", "", -1)).unwrap();
    let negative_one_shot = runtime
        .prepare_search(search(temp.path(), "negative-one-shot", "", -1))
        .unwrap()
        .run()
        .unwrap();
    assert_eq!(
        rels(&negative),
        negative_one_shot.hits.iter().map(|hit| hit.rel.as_str()).collect::<Vec<_>>()
    );
    assert!(rels(&negative).len() > 1, "a negative limit still returns rows");
    assert!(runtime.stop_search_session("ranked"));
}

/// Ranking borrows the snapshot and clones only what it returns, so the same
/// session serves an unbounded number of queries without mutating its state.
#[test]
fn session_serves_repeated_queries_without_mutating_state() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::write(temp.path().join("alpha.txt"), "").unwrap();
    let open = runtime
        .prepare_search_session(session("repeat", &[temp.path()], 5000))
        .unwrap();
    for round in 0..20 {
        let result = open.query(query(&format!("op-{round}"), "alpha", 10)).unwrap();
        assert_eq!(rels(&result), ["alpha.txt"]);
        assert_eq!(result.operation_id, format!("op-{round}"));
    }
    assert!(open.drained(), "a completed query leaves no registered operation");
    assert!(open.pending_operations().is_empty());
}

/// A session merges multiple workspace roots and tags each hit with the root it
/// came from, so the host can keep prefixing a secondary root's path exactly as
/// the one-shot handler does.
#[test]
fn session_merges_roots_and_tags_the_origin_of_each_hit() {
    let primary = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::write(primary.path().join("notes.md"), "").unwrap();
    std::fs::write(extra.path().join("notes.md"), "").unwrap();
    // A second primary-root match, so the negative-limit case below still has a
    // row to return after dropping its last entry.
    std::fs::write(primary.path().join("notes-second.md"), "").unwrap();
    let open = runtime
        .prepare_search_session(session("multi", &[primary.path(), extra.path()], 5000))
        .unwrap();
    assert_eq!(open.info().roots, 2);

    let merged = open.query(query("all", "notes", 100)).unwrap();
    assert_eq!(
        merged
            .hits
            .iter()
            .map(|hit| (hit.rel.as_str(), hit.root_index))
            .collect::<Vec<_>>(),
        [("notes-second.md", 0), ("notes.md", 0), ("notes.md", 1)],
        "roots stay in workspace order and each hit names its origin"
    );

    // The budget split matches the one-shot handler: roots are consumed in
    // order and a satisfied budget stops before the next root is ranked.
    let capped = open.query(query("capped", "notes", 1)).unwrap();
    assert_eq!(
        capped.hits.iter().map(|hit| hit.root_index).collect::<Vec<_>>(),
        [0]
    );
    // A negative limit is primary-root only, matching the one-shot handler:
    // "all but the last N" cannot be applied per root and then concatenated
    // without double-counting the dropped tail.
    let negative = open.query(query("negative", "notes", -1)).unwrap();
    assert_eq!(
        negative
            .hits
            .iter()
            .map(|hit| (hit.rel.as_str(), hit.root_index))
            .collect::<Vec<_>>(),
        [("notes-second.md", 0)],
        "a negative slice stays inside the primary root and drops only its tail"
    );
    assert!(runtime.stop_search_session("multi"));
}

#[test]
fn session_admission_is_bounded_and_rejects_duplicates() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::write(temp.path().join("a.txt"), "").unwrap();
    for index in 0..4 {
        runtime
            .prepare_search_session(session(&format!("open-{index}"), &[temp.path()], 5000))
            .unwrap();
    }
    assert_eq!(runtime.search_session_count(), 4);
    let over = runtime.prepare_search_session(session("over", &[temp.path()], 5000));
    assert_eq!(over.unwrap_err().code, "BUSY");
    let duplicate = runtime.prepare_search_session(session("open-0", &[temp.path()], 5000));
    assert_eq!(duplicate.unwrap_err().code, "DUPLICATE_RESOURCE");
    // An unusable root list is rejected before any walk happens.
    assert_eq!(
        runtime
            .prepare_search_session(session("empty", &[], 5000))
            .unwrap_err()
            .code,
        "INVALID_ROOT"
    );
    assert_eq!(runtime.search_session_count(), 4, "a refused session is not registered");
    assert_eq!(
        runtime.search_session("missing").unwrap_err().code,
        "RESOURCE_NOT_FOUND"
    );

    assert!(runtime.stop_search_session("open-0"));
    // Stopping twice is a no-op, and the freed slot admits a new session.
    assert!(!runtime.stop_search_session("open-0"));
    runtime
        .prepare_search_session(session("reopened", &[temp.path()], 5000))
        .unwrap();
    assert_eq!(runtime.search_session_count(), 4);
}

#[test]
fn a_stopped_session_refuses_later_queries_and_cancels_in_flight_ones() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::write(temp.path().join("a.txt"), "").unwrap();
    let open = runtime
        .prepare_search_session(session("stopping", &[temp.path()], 5000))
        .unwrap();
    assert!(open.query(query("before", "a", 10)).is_ok());

    // Cancelling an unknown query is false, and a stopped session cannot be
    // queried again even though the caller still holds the handle.
    assert!(!open.cancel_query("never-registered"));
    assert!(runtime.stop_search_session("stopping"));
    assert!(open.stopped());
    let refused = open.query(query("after", "a", 10));
    assert_eq!(refused.unwrap_err().code, "CLOSED");
    // Stop is idempotent and leaves the runtime drained.
    assert!(!runtime.stop_search_session("stopping"));
    assert_eq!(runtime.search_session_count(), 0);
    assert_eq!(runtime.counts(), (0, 0));
}

/// The query deadline belongs to each query, not to creation: a session may sit
/// idle and still answer a later query within its own bound.
///
/// DEADLINE_EXCEEDED is deliberately not asserted here. A one-shot search arms
/// its deadline in `prepare_search` and consumes it later in `run()`, so a sleep
/// between the two expires it. A session query arms and ranks in one call, and
/// re-ranking a held snapshot is orders of magnitude faster than the 1ms
/// deadline floor — there is no gap to force open, and manufacturing one by
/// ranking a huge tree would be flaky.
#[test]
fn session_query_deadline_is_per_query_and_a_truncated_snapshot_is_reported() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::write(temp.path().join("a.txt"), "").unwrap();
    let open = runtime
        .prepare_search_session(session("deadlines", &[temp.path()], 5000))
        .unwrap();
    assert!(open.query(query("ok", "a", 10)).is_ok());
    // An out-of-range query deadline is rejected before ranking.
    assert_eq!(
        open.query(QueryOptions {
            operation_id: "bad-deadline".into(),
            query: "a".into(),
            limit: 10,
            deadline_ms: 0,
        })
        .unwrap_err()
        .code,
        "INVALID_DEADLINE"
    );
    // The creation deadline is validated independently of any query.
    assert_eq!(
        runtime
            .prepare_search_session(session("bad-create", &[temp.path()], 0))
            .unwrap_err()
            .code,
        "INVALID_DEADLINE"
    );
    // A session that sat idle still answers: the deadline is armed per query,
    // not at creation.
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(rels(&open.query(query("after-idle", "a", 10)).unwrap()), ["a.txt"]);
    let info = open.info();
    assert!(!info.truncated, "a small tree is not truncated");
    assert!(info.scanned > 0);
    assert!(runtime.stop_search_session("deadlines"));
}

/// Shutdown stops every session and names a query that outlived the deadline,
/// so a leak is visible instead of only reporting `complete: false`.
#[test]
fn shutdown_stops_sessions_and_seals_their_admission() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    std::fs::write(temp.path().join("a.txt"), "").unwrap();
    let held = runtime
        .prepare_search_session(session("held", &[temp.path()], 5000))
        .unwrap();
    assert!(held.query(query("before-shutdown", "a", 10)).is_ok());
    assert_eq!(runtime.search_session_count(), 1);

    let report = runtime.prepare_shutdown(1000).unwrap().run();
    assert!(report.complete, "a drained session does not hold shutdown open");
    assert_eq!(runtime.search_session_count(), 0, "shutdown deregisters sessions");
    assert!(held.stopped());
    assert_eq!(held.query(query("after-shutdown", "a", 10)).unwrap_err().code, "CLOSED");
    // Admission is permanently sealed, exactly as it is for one-shot searches.
    assert_eq!(
        runtime
            .prepare_search_session(session("late", &[temp.path()], 5000))
            .unwrap_err()
            .code,
        "CLOSED"
    );
    assert!(runtime.prepare_shutdown(1000).unwrap().run().complete);
}

#[test]
fn cancellation_is_registered_before_worker_start_and_does_not_leave_tombstones() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    for _ in 0..100 {
        let job = runtime
            .prepare_search(search(temp.path(), "same-id", "", 40))
            .unwrap();
        assert!(runtime.cancel_search("same-id"));
        assert_eq!(job.run().unwrap_err().code, "CANCELLED");
        assert!(!runtime.cancel_search("same-id"));
        assert_eq!(runtime.counts(), (0, 0));
    }
}

#[test]
fn search_admission_and_deadline_are_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let jobs: Vec<_> = (0..8)
        .map(|id| {
            runtime
                .prepare_search(search(temp.path(), &format!("op-{id}"), "", 40))
                .unwrap()
        })
        .collect();
    assert!(runtime
        .prepare_search(search(temp.path(), "extra", "", 40))
        .is_err());
    assert!(runtime
        .prepare_search(search(temp.path(), "op-0", "", 40))
        .is_err());
    drop(jobs);
    assert_eq!(runtime.counts(), (0, 0));
    let mut options = search(temp.path(), "timeout", "", 40);
    options.deadline_ms = 1;
    let job = runtime.prepare_search(options).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(job.run().unwrap_err().code, "DEADLINE_EXCEEDED");
}

#[test]
fn shutdown_reports_unfinished_workers_and_permanently_seals_admission() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let job = runtime
        .prepare_search(search(temp.path(), "pending", "", 40))
        .unwrap();
    let report = runtime.prepare_shutdown(5).unwrap().run();
    assert!(!report.complete);
    assert_eq!(report.pending_operations, ["pending"]);
    assert_eq!(job.run().unwrap_err().code, "CANCELLED");
    assert!(runtime.prepare_shutdown(5).unwrap().run().complete);
    assert!(runtime
        .prepare_search(search(temp.path(), "after", "", 40))
        .is_err());
}

#[cfg(unix)]
fn pty_options(root: &Path, id: &str, script: &str) -> StartOptions {
    StartOptions {
        resource_id: id.into(),
        cwd: root.into(),
        command: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env: vec![],
        cols: 80,
        rows: 24,
        deadline_ms: 5000,
    }
}

#[cfg(unix)]
async fn drain(resource: &Pty) -> Vec<Event> {
    let mut events = Vec::new();
    while let Some(event) = tokio::time::timeout(Duration::from_secs(10), resource.next_event())
        .await
        .unwrap_or_else(|error| {
            panic!(
                "PTY event deadline: {error}; report={:?}",
                resource.snapshot()
            )
        })
        .unwrap()
    {
        assert_eq!(event.sequence, events.len() as u32 + 1);
        assert_eq!(event.resource_id, resource.id());
        events.push(event);
    }
    events
}

#[cfg(unix)]
#[tokio::test]
async fn pty_preserves_utf8_bytes_and_orders_exit_after_output() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(pty_options(
            temp.path(),
            "utf8",
            r"printf '\344'; sleep 0.02; printf '\275\240\345\245\275'; exit 7",
        ))
        .unwrap();
    let info = resource.wait_ready().unwrap();
    assert!(info.pid > 1);
    assert_ne!(info.pid, std::process::id());
    let events = drain(&resource).await;
    let bytes: Vec<_> = events.iter().flat_map(|event| event.data.clone()).collect();
    assert_eq!(bytes, "你好".as_bytes());
    assert_eq!(events.last().unwrap().kind, "exit");
    assert_eq!(events.last().unwrap().exit_code, 7);
    let report = resource.close(100).unwrap();
    assert!(report.complete, "{report:?}");
    assert_eq!(report.bytes_read, report.bytes_emitted);
    assert_eq!(report.discarded_bytes, 0);
    assert_eq!(
        resource.close(100).unwrap().last_sequence,
        report.last_sequence
    );
    assert!(resource.next_event().await.unwrap().is_none());
    assert!(runtime.release_pty("utf8"));
    assert!(!runtime.release_pty("utf8"));
    assert_eq!(runtime.counts(), (0, 0));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_bidirectional_input_resize_and_eof_are_real() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime.start_pty(pty_options(temp.path(), "input", "stty -echo; printf READY; read value; printf '<%s>' \"$value\"; stty size; cat >/dev/null; exit 3")).unwrap();
    resource.wait_ready().unwrap();
    let mut prefix = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(5), resource.next_event())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        prefix.extend(event.data);
        if prefix.windows(5).any(|window| window == b"READY") {
            break;
        }
    }
    resource
        .resize("size".into(), 97, 31, 2000)
        .unwrap()
        .wait()
        .unwrap();
    let result = resource
        .write("input-line".into(), b"hello\n".to_vec(), 2000)
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(result.bytes_written, 6);
    resource
        .write("eof".into(), vec![4], 2000)
        .unwrap()
        .wait()
        .unwrap();
    let mut output = Vec::new();
    let mut exit = None;
    while let Some(event) = tokio::time::timeout(Duration::from_secs(5), resource.next_event())
        .await
        .unwrap()
        .unwrap()
    {
        output.extend_from_slice(&event.data);
        if event.kind == "exit" {
            exit = Some(event);
        }
    }
    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("<hello>31 97"), "{output:?}");
    assert_eq!(exit.unwrap().exit_code, 3);
    assert!(resource.close(100).unwrap().complete);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_consumer_backpressures_without_losing_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(pty_options(
            temp.path(),
            "flood",
            "head -c 3145728 /dev/zero",
        ))
        .unwrap();
    resource.wait_ready().unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let held = resource.snapshot();
    assert_eq!(held.peak_queue_chunks, 64, "{held:?}");
    assert!(
        held.bytes_read <= 65 * 16384,
        "producer exceeded bound: {held:?}"
    );
    let events = drain(&resource).await;
    assert_eq!(
        events.iter().map(|event| event.data.len()).sum::<usize>(),
        3145728
    );
    assert_eq!(events.last().unwrap().exit_code, 0);
    let report = resource.close(100).unwrap();
    assert!(report.complete, "{report:?}");
    assert_eq!(report.discarded_bytes, 0);
    assert!(report.peak_queue_chunks <= 65);
}

#[cfg(unix)]
#[tokio::test]
async fn deadline_close_reports_undelivered_output_and_reaps_hup_resistant_child() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(pty_options(
            temp.path(),
            "stalled",
            "trap '' HUP; while :; do head -c 1048576 /dev/zero; done",
        ))
        .unwrap();
    resource.wait_ready().unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = Instant::now();
    let report = resource.close(100).unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "close exceeded deadline allowance"
    );
    assert!(
        !report.complete,
        "full queue must not be called fully delivered: {report:?}"
    );
    let events = drain(&resource).await;
    let exit = events.last().unwrap();
    assert!(!exit.output_complete);
    assert!(exit
        .error
        .as_deref()
        .unwrap_or("")
        .contains("DEADLINE_EXCEEDED"));
    assert!(resource.is_done());
    assert!(resource.write("after".into(), vec![1], 100).is_err());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_cancels_backpressured_input_and_signals_only_owned_processes() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let resource = runtime
        .start_pty(pty_options(
            temp.path(),
            "blocked-input",
            "stty raw -echo; printf READY; sleep 30",
        ))
        .unwrap();
    resource.wait_ready().unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), resource.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(event.data.windows(5).any(|window| window == b"READY"));
    let ticket = resource
        .write("large-input".into(), vec![b'x'; 65536], 5000)
        .unwrap();
    assert!(resource.cancel_operation("large-input"));
    assert_eq!(ticket.wait().unwrap_err().code, "CANCELLED");
    let consumer = Arc::clone(&resource);
    let draining =
        tokio::spawn(async move { while consumer.next_event().await.unwrap().is_some() {} });
    let report = resource.close(2000).unwrap();
    assert!(report.complete, "{report:?}");
    draining.await.unwrap();
    assert!(!resource.cancel_operation("large-input"));
}

#[cfg(unix)]
#[test]
fn failed_spawn_is_observable_and_releasable() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let mut options = pty_options(temp.path(), "bad-command", "");
    options.command = "/definitely/not/a/program".into();
    let resource = runtime.start_pty(options).unwrap();
    assert_eq!(resource.wait_ready().unwrap_err().code, "PTY_SPAWN_FAILED");
    assert!(resource.is_done());
    assert!(runtime.release_pty("bad-command"));
    assert_eq!(runtime.counts(), (0, 0));
}
