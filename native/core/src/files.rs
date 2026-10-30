use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use crate::{NativeError, Operation, Result};

const MAX_ENTRIES: usize = 200_000;
const MAX_PATH_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_SKIP_DIRS: &[&str] = &["node_modules", ".git", "dist", ".hg", ".svn"];

#[derive(Clone, Debug)]
pub struct SearchOptions {
    pub operation_id: String,
    pub root: PathBuf,
    pub query: String,
    pub limit: i32,
    pub deadline_ms: u32,
}

impl SearchOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        if !self.root.is_absolute() || self.root.as_os_str().to_string_lossy().contains('\0') {
            return Err(NativeError::new(
                "INVALID_ROOT",
                "search root must be an absolute path",
            ));
        }
        if self.query.chars().count() > 256 {
            return Err(NativeError::new(
                "INVALID_QUERY",
                "search query exceeds 256 characters",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug)]
pub struct SearchResult {
    pub operation_id: String,
    pub hits: Vec<Hit>,
    pub scanned: u32,
    pub truncated: bool,
}

/// One snapshot of a workspace tree, produced by [`load`].
///
/// A one-shot search builds and drops this per call. A [`crate::search_session`]
/// keeps one alive so that repeated queries re-rank the snapshot instead of
/// walking the filesystem again.
#[derive(Default)]
pub(crate) struct Entries {
    paths: BTreeSet<(String, bool)>,
    pub(crate) bytes: usize,
    pub(crate) scanned: usize,
    pub(crate) truncated: bool,
}

impl Entries {
    fn insert(&mut self, rel: String, is_dir: bool) -> bool {
        if self.paths.contains(&(rel.clone(), is_dir)) {
            return true;
        }
        if self.paths.len() >= MAX_ENTRIES || self.bytes + rel.len() > MAX_PATH_BYTES {
            self.truncated = true;
            return false;
        }
        self.bytes += rel.len();
        self.paths.insert((rel, is_dir));
        true
    }
}

fn default_ignored(rel: &str) -> bool {
    rel.split('/').any(|part| DEFAULT_SKIP_DIRS.contains(&part))
}

fn repo_ignore(root: &Path, inside_repo: bool) -> ignore::gitignore::Gitignore {
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    for name in [".gitignore", ".ignore", ".rgignore"] {
        if name != ".gitignore" || inside_repo {
            builder.add(root.join(name));
        }
    }
    builder
        .build()
        .unwrap_or_else(|_| ignore::gitignore::Gitignore::empty())
}

fn ignored(matcher: &ignore::gitignore::Gitignore, rel: &str, is_dir: bool) -> bool {
    matcher.matched(rel, is_dir).is_ignore()
}

/// stdout is bounded independently from the child, so cancellation can kill git even when its pipe fills.
fn git_files(root: &Path, operation: &Operation) -> Result<Option<Vec<u8>>> {
    operation.check()?;
    let Ok(mut child) = Command::new("git")
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
    else {
        return Ok(None);
    };
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = mpsc::sync_channel(4);
    let reader = std::thread::Builder::new()
        .name("native-git-output".into())
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if sender.send(Ok(buffer[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
    if let Err(error) = reader {
        let _ = child.kill();
        let _ = child.wait();
        return Err(NativeError::new("WORKER_FAILED", error.to_string()));
    }
    let reader = reader.expect("reader was checked");
    let mut bytes = Vec::new();
    let result = loop {
        if let Err(error) = operation.check() {
            break Err(error);
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(chunk)) => {
                if bytes.len() + chunk.len() > MAX_PATH_BYTES {
                    break Err(NativeError::new(
                        "SEARCH_LIMIT_EXCEEDED",
                        "git listing exceeds 32 MiB",
                    ));
                }
                bytes.extend(chunk);
            }
            Ok(Err(_)) => break Ok(None),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The pipe can close before the process exits; retain cancellation during the wait.
                break loop {
                    if let Err(error) = operation.check() {
                        break Err(error);
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => break Ok(status.success().then_some(bytes)),
                        Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                        Err(_) => break Ok(None),
                    }
                };
            }
        }
    };
    // Kill first and drop the bounded receiver before joining a blocked producer.
    let _ = child.kill();
    let _ = child.wait();
    drop(receiver);
    let _ = reader.join();
    result
}

pub(crate) fn load(root: &Path, operation: &Operation) -> Result<Entries> {
    operation.check()?;
    let mut entries = Entries::default();
    if !root.is_dir() {
        return Ok(entries);
    }
    let inside_repo = root.ancestors().any(|dir| dir.join(".git").exists());
    let matcher = repo_ignore(root, inside_repo);
    if inside_repo {
        if let Some(bytes) = git_files(root, operation)? {
            for raw in bytes.split(|byte| *byte == 0).filter(|raw| !raw.is_empty()) {
                operation.check()?;
                entries.scanned += 1;
                let rel = std::str::from_utf8(raw).map_err(|_| {
                    NativeError::new("INVALID_PATH_ENCODING", "git returned a non-UTF-8 path")
                })?;
                if ignored(&matcher, rel, false) {
                    continue;
                }
                if !entries.insert(rel.to_owned(), false) {
                    break;
                }
                // Git decides the file set; built-in skips apply only to its derived directories.
                for (index, _) in rel.match_indices('/') {
                    let ancestor = &rel[..index];
                    if !default_ignored(ancestor) && !entries.insert(ancestor.to_owned(), true) {
                        break;
                    }
                }
                if entries.truncated {
                    break;
                }
            }
            return Ok(entries);
        }
    }
    let real_root = root
        .canonicalize()
        .map_err(|error| NativeError::new("READ_FAILED", error.to_string()))?;
    let mut stack = vec![(root.to_path_buf(), vec![real_root])];
    while let Some((directory, ancestors)) = stack.pop() {
        operation.check()?;
        let Ok(children) = std::fs::read_dir(&directory) else {
            continue;
        };
        for child in children {
            operation.check()?;
            if entries.scanned >= MAX_ENTRIES {
                entries.truncated = true;
                return Ok(entries);
            }
            entries.scanned += 1;
            let Ok(child) = child else {
                continue;
            };
            let path = child.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|error| NativeError::new("INVALID_ROOT", error.to_string()))?;
            let rel = relative
                .components()
                .map(|component| {
                    component.as_os_str().to_str().ok_or_else(|| {
                        NativeError::new(
                            "INVALID_PATH_ENCODING",
                            "directory contains a non-UTF-8 path",
                        )
                    })
                })
                .collect::<Result<Vec<_>>>()?
                .join("/");
            if default_ignored(&rel) {
                continue;
            }
            let Ok(metadata) = child.metadata().or_else(|_| std::fs::metadata(&path)) else {
                continue;
            };
            // Follow directory symlinks, but never descend into an ancestor again.
            let metadata = if metadata.file_type().is_symlink() {
                match std::fs::metadata(&path) {
                    Ok(value) => value,
                    Err(_) => continue,
                }
            } else {
                metadata
            };
            let is_dir = metadata.is_dir();
            if ignored(&matcher, &rel, is_dir) {
                continue;
            }
            if is_dir {
                let Ok(real) = path.canonicalize() else {
                    continue;
                };
                if ancestors.contains(&real) {
                    continue;
                }
                if !entries.insert(rel, true) {
                    return Ok(entries);
                }
                let mut next = ancestors.clone();
                next.push(real);
                stack.push((path, next));
            } else if !entries.insert(rel, false) {
                return Ok(entries);
            }
        }
    }
    Ok(entries)
}

pub(crate) fn search(options: &SearchOptions, operation: &Operation) -> Result<SearchResult> {
    operation.check()?;
    if options.limit == 0 {
        return Ok(SearchResult {
            operation_id: options.operation_id.clone(),
            hits: Vec::new(),
            scanned: 0,
            truncated: false,
        });
    }
    let entries = load(&options.root, operation)?;
    let hits = rank(&entries, &options.query, options.limit, operation)?;
    Ok(SearchResult {
        operation_id: options.operation_id.clone(),
        hits,
        scanned: entries.scanned as u32,
        truncated: entries.truncated,
    })
}

/// Score and order one snapshot, without walking the filesystem.
///
/// Split out of [`search`] so a persistent session can re-rank a snapshot it
/// already holds on every query. Ranking borrows the entries and clones only
/// the paths it actually returns, so a capped query allocates `limit` strings
/// rather than one per match.
///
/// Ordering is load-bearing and must stay byte-identical to the renderer's
/// expectations: descending score, ties broken by ascending relative path
/// (which `BTreeSet` iteration already yields, and `sort_by` preserves).
pub(crate) fn rank(
    entries: &Entries,
    query: &str,
    limit: i32,
    operation: &Operation,
) -> Result<Vec<Hit>> {
    operation.check()?;
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut ranked: Vec<(i64, &(String, bool))> = Vec::new();
    for entry in &entries.paths {
        operation.check()?;
        if let Some(score) = fuzzy_score(query, &entry.0) {
            ranked.push((score, entry));
        }
    }
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1 .0.cmp(&b.1 .0)));
    operation.check()?;
    let take = if limit < 0 {
        ranked.len().saturating_sub(limit.unsigned_abs() as usize)
    } else {
        limit as usize
    };
    Ok(ranked
        .into_iter()
        .take(take)
        .map(|(_, (rel, is_dir))| Hit {
            name: rel.rsplit('/').next().unwrap_or(rel).to_owned(),
            rel: rel.clone(),
            is_dir: *is_dir,
        })
        .collect())
}

const BONUS_CONSECUTIVE: i64 = 6;
const BONUS_SEPARATOR: i64 = 5;
const BONUS_CAMEL: i64 = 5;
const BONUS_START: i64 = 6;
const BONUS_BASENAME: i64 = 10;
const LENGTH_PENALTY_UNIT: i64 = 16;
/// Stand-in for the TS `Number.NEGATIVE_INFINITY` sentinel.
const NEG: i64 = i64::MIN / 4;

fn is_separator(ch: char) -> bool {
    matches!(ch, '/' | '\\' | '_' | '-' | '.' | ' ')
}

/// charBonus mirror: start-of-segment, post-separator, camel hump.
fn char_bonus(target: &[char], idx: usize, from: usize) -> i64 {
    let mut bonus = 1;
    if idx == from {
        bonus += BONUS_START;
    } else {
        let prev = target[idx - 1];
        let cur = target[idx];
        if is_separator(prev) {
            bonus += BONUS_SEPARATOR;
        } else if prev.is_ascii_lowercase() && cur.is_ascii_uppercase() {
            // Deliberately ASCII-only: fuzzy.ts's isLower/isUpper are
            // `ch >= 'a' && ch <= 'z'` / `'A'..'Z'`, so `äB` earns no hump
            // bonus there either. Widening this would change the ranking.
            bonus += BONUS_CAMEL;
        }
    }
    bonus
}

/// lengthPenalty mirror. JS measures `target.length` in UTF-16 code units while
/// this counts chars; the two differ only for astral characters (emoji), which
/// would have to appear 16+ times in one path to shift the penalty by a point.
fn length_penalty(len: usize) -> i64 {
    (len as i64) / LENGTH_PENALTY_UNIT
}

/// `String.prototype.toLowerCase()` for one char.
///
/// `to_ascii_lowercase` is NOT the same function: it leaves `Ä`, `Ç`, `Д`
/// untouched, so a query typed in lower case would not match an accented or
/// Cyrillic filename at all — the DP compares the folded query against the
/// folded target, and one side folding while the other does not turns a real
/// match into `None` (the entry vanishes from the @-mention menu). Only the
/// first char of the mapping is kept so the folded vector stays index-aligned
/// with the original target, which `char_bonus` indexes into.
fn js_lowercase(ch: char) -> char {
    ch.to_lowercase().next().unwrap_or(ch)
}

/// optimalMatch mirror: DP over (query chars consumed, slice chars consumed).
/// Returns the best score, or None when the query is not a subsequence.
fn optimal_match(query: &[char], target: &[char], from: usize) -> Option<i64> {
    let m = query.len();
    let n = target.len() - from;
    if m == 0 {
        return Some(0);
    }
    if m > n {
        return None;
    }
    let lower: Vec<char> = target.iter().copied().map(js_lowercase).collect();
    let q: Vec<char> = query.iter().copied().map(js_lowercase).collect();

    // Rolling rows: only i-1 is needed for row i.
    let mut prev_match = vec![NEG; n + 1];
    let mut prev_best = vec![0i64; n + 1]; // best[0][j] = 0 for all j
    for i in 1..=m {
        let mut cur_match = vec![NEG; n + 1];
        let mut cur_best = vec![NEG; n + 1];
        for j in 1..=n {
            let t_idx = from + j - 1;
            let mut m_score = NEG;
            if j >= i && q[i - 1] == lower[t_idx] {
                let bonus = char_bonus(target, t_idx, from);
                let from_consec = if prev_match[j - 1] > NEG {
                    prev_match[j - 1] + bonus + BONUS_CONSECUTIVE
                } else {
                    NEG
                };
                let from_gap = if prev_best[j - 1] > NEG {
                    prev_best[j - 1] + bonus
                } else {
                    NEG
                };
                m_score = from_consec.max(from_gap);
            }
            cur_match[j] = m_score;
            let carry = cur_best[j - 1];
            cur_best[j] = if m_score >= carry { m_score } else { carry };
        }
        prev_match = cur_match;
        prev_best = cur_best;
    }
    let score = prev_best[n];
    if score == NEG {
        None
    } else {
        Some(score)
    }
}

fn last_separator_index(target: &[char]) -> Option<usize> {
    target.iter().rposition(|c| *c == '/' || *c == '\\')
}

/// fuzzyScore mirror: prefer a match contained in the basename (with the
/// basename bonus), else the full-path match; length penalty either way.
pub fn fuzzy_score(query: &str, target: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    if target.is_empty() {
        return None;
    }
    let q: Vec<char> = query.chars().collect();
    let t: Vec<char> = target.chars().collect();
    let base_start = last_separator_index(&t).map(|i| i + 1).unwrap_or(0);
    if let Some(score) = optimal_match(&q, &t, base_start) {
        return Some(score + BONUS_BASENAME - length_penalty(t.len()));
    }
    optimal_match(&q, &t, 0).map(|score| score - length_penalty(t.len()))
}

// ---- entry loading ----
