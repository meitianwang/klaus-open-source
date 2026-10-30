pub mod credentials;
pub mod instance;
pub mod permissions;
pub mod pip;
pub mod pointer;
pub mod pet_panel;
pub mod ssh;
pub mod whatsapp;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use klaus_native_core::{files, pty, NativeError, Runtime};
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

fn failure(error: NativeError) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

#[napi(object)]
pub struct SearchOptions {
    pub operation_id: String,
    pub root: String,
    pub query: String,
    pub limit: i32,
    pub deadline_ms: u32,
}

#[napi(object)]
pub struct FileHit {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
}

#[napi(object)]
pub struct SearchResult {
    pub operation_id: String,
    pub hits: Vec<FileHit>,
    pub scanned: u32,
    pub truncated: bool,
}

pub struct SearchTask(Option<klaus_native_core::SearchJob>);

impl Task for SearchTask {
    type Output = files::SearchResult;
    type JsValue = SearchResult;
    fn compute(&mut self) -> Result<Self::Output> {
        self.0
            .take()
            .expect("task runs once")
            .run()
            .map_err(failure)
    }
    fn resolve(&mut self, _env: Env, result: Self::Output) -> Result<Self::JsValue> {
        Ok(SearchResult {
            operation_id: result.operation_id,
            scanned: result.scanned,
            truncated: result.truncated,
            hits: result
                .hits
                .into_iter()
                .map(|hit| FileHit {
                    rel: hit.rel,
                    name: hit.name,
                    is_dir: hit.is_dir,
                })
                .collect(),
        })
    }
}

#[napi(object)]
pub struct SearchSessionOptions {
    pub session_id: String,
    /// Workspace roots in order; the primary root is first. A hit from a later
    /// root carries that root's index so the host prefixes its path.
    pub roots: Vec<String>,
    pub deadline_ms: u32,
}

#[napi(object)]
pub struct SearchSessionInfo {
    pub session_id: String,
    pub roots: u32,
    pub scanned: u32,
    /// A truncated snapshot is reported so the host can refuse it rather than
    /// serve a partial index, exactly as it rejects a truncated one-shot result.
    pub truncated: bool,
}

#[napi(object)]
pub struct SearchSessionQuery {
    pub session_id: String,
    pub operation_id: String,
    pub query: String,
    pub limit: i32,
    pub deadline_ms: u32,
}

#[napi(object)]
pub struct SearchSessionHit {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
    pub root_index: u32,
}

#[napi(object)]
pub struct SearchSessionResult {
    pub operation_id: String,
    pub hits: Vec<SearchSessionHit>,
    pub scanned: u32,
}

/// Creating a session walks the tree, so it runs off the JavaScript thread.
/// The `Option` is the same run-once guard `SearchTask` uses.
pub struct SearchSessionTask {
    runtime: Runtime,
    options: Option<klaus_native_core::search_session::SessionOptions>,
}

impl Task for SearchSessionTask {
    type Output = Arc<klaus_native_core::search_session::SearchSession>;
    type JsValue = SearchSessionInfo;
    fn compute(&mut self) -> Result<Self::Output> {
        let options = self.options.take().expect("task runs once");
        self.runtime.prepare_search_session(options).map_err(failure)
    }
    fn resolve(&mut self, _env: Env, session: Self::Output) -> Result<Self::JsValue> {
        let info = session.info();
        Ok(SearchSessionInfo {
            session_id: info.session_id,
            roots: info.roots as u32,
            scanned: info.scanned,
            truncated: info.truncated,
        })
    }
}

/// Re-ranking a held snapshot is CPU work proportional to the tree, so it also
/// stays off the JavaScript thread even though it touches no filesystem.
pub struct SearchSessionQueryTask {
    session: Arc<klaus_native_core::search_session::SearchSession>,
    options: Option<klaus_native_core::search_session::QueryOptions>,
}

impl Task for SearchSessionQueryTask {
    type Output = klaus_native_core::search_session::QueryResult;
    type JsValue = SearchSessionResult;
    fn compute(&mut self) -> Result<Self::Output> {
        let options = self.options.take().expect("task runs once");
        self.session.query(options).map_err(failure)
    }
    fn resolve(&mut self, _env: Env, result: Self::Output) -> Result<Self::JsValue> {
        Ok(SearchSessionResult {
            operation_id: result.operation_id,
            scanned: result.scanned,
            hits: result
                .hits
                .into_iter()
                .map(|hit| SearchSessionHit {
                    rel: hit.rel,
                    name: hit.name,
                    is_dir: hit.is_dir,
                    root_index: hit.root_index as u32,
                })
                .collect(),
        })
    }
}

#[napi(object)]
pub struct EnvironmentEntry {
    pub key: String,
    pub value: String,
}

#[napi(object)]
pub struct PtyOptions {
    pub resource_id: String,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvironmentEntry>,
    pub cols: u16,
    pub rows: u16,
    pub deadline_ms: u32,
}

#[napi(object)]
pub struct PtyInfo {
    pub resource_id: String,
    pub pid: u32,
    pub cwd: String,
    pub command: String,
}

pub struct StartTask(Arc<pty::Pty>);

impl Task for StartTask {
    type Output = pty::StartInfo;
    type JsValue = PtyInfo;
    fn compute(&mut self) -> Result<Self::Output> {
        self.0.wait_ready().map_err(failure)
    }
    fn resolve(&mut self, _env: Env, info: Self::Output) -> Result<Self::JsValue> {
        Ok(PtyInfo {
            resource_id: info.resource_id,
            pid: info.pid,
            cwd: info.cwd,
            command: info.command,
        })
    }
}

#[napi(object)]
pub struct PtyEvent {
    pub resource_id: String,
    pub sequence: u32,
    pub kind: String,
    pub data: Buffer,
    pub exit_code: u32,
    pub signal: i32,
    pub output_complete: bool,
    pub error: Option<String>,
}

#[napi(object)]
pub struct CommandResult {
    pub operation_id: String,
    pub resource_id: String,
    pub bytes_written: u32,
}

pub struct CommandTask(Option<pty::CommandTicket>);

impl Task for CommandTask {
    type Output = pty::CommandResult;
    type JsValue = CommandResult;
    fn compute(&mut self) -> Result<Self::Output> {
        self.0
            .take()
            .expect("task runs once")
            .wait()
            .map_err(failure)
    }
    fn resolve(&mut self, _env: Env, result: Self::Output) -> Result<Self::JsValue> {
        Ok(CommandResult {
            operation_id: result.operation_id,
            resource_id: result.resource_id,
            bytes_written: result.bytes_written,
        })
    }
}

#[napi(object)]
pub struct CloseReport {
    pub resource_id: String,
    pub complete: bool,
    pub state: String,
    pub last_sequence: u32,
    pub bytes_read: f64,
    pub bytes_emitted: f64,
    pub discarded_bytes: f64,
    pub peak_queue_chunks: u32,
    pub error: Option<String>,
}

impl From<pty::CloseReport> for CloseReport {
    fn from(report: pty::CloseReport) -> Self {
        Self {
            resource_id: report.resource_id,
            complete: report.complete,
            state: report.state.to_owned(),
            last_sequence: report.last_sequence,
            bytes_read: report.bytes_read as f64,
            bytes_emitted: report.bytes_emitted as f64,
            discarded_bytes: report.discarded_bytes as f64,
            peak_queue_chunks: report.peak_queue_chunks,
            error: report.error,
        }
    }
}

pub struct CloseTask {
    resource: Arc<pty::Pty>,
    until: Instant,
}

impl Task for CloseTask {
    type Output = pty::CloseReport;
    type JsValue = CloseReport;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.resource.wait_close(self.until))
    }
    fn resolve(&mut self, _env: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(report.into())
    }
}

#[napi(object)]
pub struct ShutdownReport {
    pub complete: bool,
    pub pending_operations: Vec<String>,
    pub resources: Vec<CloseReport>,
}

pub struct ShutdownTask(Option<klaus_native_core::ShutdownJob>);

impl Task for ShutdownTask {
    type Output = klaus_native_core::ShutdownReport;
    type JsValue = ShutdownReport;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.0.take().expect("task runs once").run())
    }
    fn resolve(&mut self, _env: Env, report: Self::Output) -> Result<Self::JsValue> {
        Ok(ShutdownReport {
            complete: report.complete,
            pending_operations: report.pending_operations,
            resources: report.resources.into_iter().map(Into::into).collect(),
        })
    }
}

#[napi(object)]
pub struct Counts {
    pub searches: u32,
    pub ptys: u32,
    /// Live persistent search sessions. Reported alongside the one-shot search
    /// count so every existing "no leaked resources" assertion covers sessions
    /// too, and a leaked session fails a gate instead of only inflating memory.
    pub search_sessions: u32,
}

#[napi]
pub struct NativeHost {
    runtime: Runtime,
}

#[napi]
impl NativeHost {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            runtime: Runtime::default(),
        }
    }

    #[napi]
    pub fn search(&self, options: SearchOptions) -> Result<AsyncTask<SearchTask>> {
        let job = self
            .runtime
            .prepare_search(files::SearchOptions {
                operation_id: options.operation_id,
                root: PathBuf::from(options.root),
                query: options.query,
                limit: options.limit,
                deadline_ms: options.deadline_ms,
            })
            .map_err(failure)?;
        Ok(AsyncTask::new(SearchTask(Some(job))))
    }

    #[napi]
    pub fn cancel_search(&self, operation_id: String) -> bool {
        self.runtime.cancel_search(&operation_id)
    }

    /// Open a persistent search session. Walks the roots once, off the
    /// JavaScript thread; the returned info reports whether any root truncated,
    /// which the host treats as a refusal.
    #[napi]
    pub fn create_search_session(
        &self,
        options: SearchSessionOptions,
    ) -> Result<AsyncTask<SearchSessionTask>> {
        let roots = options
            .roots
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        Ok(AsyncTask::new(SearchSessionTask {
            runtime: self.runtime.clone(),
            options: Some(klaus_native_core::search_session::SessionOptions {
                session_id: options.session_id,
                roots,
                deadline_ms: options.deadline_ms,
            }),
        }))
    }

    /// Re-rank the session's held snapshot for a new query. Off the JavaScript
    /// thread because ranking cost scales with the tree even though it reads no
    /// filesystem.
    #[napi]
    pub fn search_session_query(
        &self,
        options: SearchSessionQuery,
    ) -> Result<AsyncTask<SearchSessionQueryTask>> {
        let session = self
            .runtime
            .search_session(&options.session_id)
            .map_err(failure)?;
        Ok(AsyncTask::new(SearchSessionQueryTask {
            session,
            options: Some(klaus_native_core::search_session::QueryOptions {
                operation_id: options.operation_id,
                query: options.query,
                limit: options.limit,
                deadline_ms: options.deadline_ms,
            }),
        }))
    }

    /// Cancel one in-flight session query without closing the session.
    #[napi]
    pub fn cancel_search_session_query(
        &self,
        session_id: String,
        operation_id: String,
    ) -> Result<bool> {
        let session = self
            .runtime
            .search_session(&session_id)
            .map_err(failure)?;
        Ok(session.cancel_query(&operation_id))
    }

    /// Stop and deregister a session. Idempotent: a second call reports false.
    #[napi]
    pub fn stop_search_session(&self, session_id: String) -> bool {
        self.runtime.stop_search_session(&session_id)
    }

    #[napi]
    pub fn start_pty(&self, options: PtyOptions) -> Result<AsyncTask<StartTask>> {
        let resource = self
            .runtime
            .start_pty(pty::StartOptions {
                resource_id: options.resource_id,
                cwd: PathBuf::from(options.cwd),
                command: options.command,
                args: options.args,
                env: options
                    .env
                    .into_iter()
                    .map(|entry| (entry.key, entry.value))
                    .collect(),
                cols: options.cols,
                rows: options.rows,
                deadline_ms: options.deadline_ms,
            })
            .map_err(failure)?;
        Ok(AsyncTask::new(StartTask(resource)))
    }

    #[napi]
    pub async fn read_pty(&self, resource_id: String) -> Result<Option<PtyEvent>> {
        let resource = self.runtime.pty(&resource_id).map_err(failure)?;
        Ok(resource
            .next_event()
            .await
            .map_err(failure)?
            .map(|event| PtyEvent {
                resource_id: event.resource_id,
                sequence: event.sequence,
                kind: event.kind.to_owned(),
                data: event.data.into(),
                exit_code: event.exit_code,
                signal: event.signal,
                output_complete: event.output_complete,
                error: event.error,
            }))
    }

    #[napi]
    pub fn write_pty(
        &self,
        resource_id: String,
        operation_id: String,
        data: Buffer,
        deadline_ms: u32,
    ) -> Result<AsyncTask<CommandTask>> {
        let ticket = self
            .runtime
            .pty(&resource_id)
            .map_err(failure)?
            .write(operation_id, data.to_vec(), deadline_ms)
            .map_err(failure)?;
        Ok(AsyncTask::new(CommandTask(Some(ticket))))
    }

    #[napi]
    pub fn resize_pty(
        &self,
        resource_id: String,
        operation_id: String,
        cols: u16,
        rows: u16,
        deadline_ms: u32,
    ) -> Result<AsyncTask<CommandTask>> {
        let ticket = self
            .runtime
            .pty(&resource_id)
            .map_err(failure)?
            .resize(operation_id, cols, rows, deadline_ms)
            .map_err(failure)?;
        Ok(AsyncTask::new(CommandTask(Some(ticket))))
    }

    #[napi]
    pub fn cancel_pty_operation(&self, resource_id: String, operation_id: String) -> Result<bool> {
        Ok(self
            .runtime
            .pty(&resource_id)
            .map_err(failure)?
            .cancel_operation(&operation_id))
    }

    #[napi]
    pub fn close_pty(&self, resource_id: String, deadline_ms: u32) -> Result<AsyncTask<CloseTask>> {
        if !(1..=120_000).contains(&deadline_ms) {
            return Err(failure(NativeError::new(
                "INVALID_DEADLINE",
                "deadlineMs must be between 1 and 120000",
            )));
        }
        let until = Instant::now() + std::time::Duration::from_millis(u64::from(deadline_ms));
        let resource = self.runtime.pty(&resource_id).map_err(failure)?;
        resource.request_close(until);
        Ok(AsyncTask::new(CloseTask { resource, until }))
    }

    #[napi]
    pub fn release_pty(&self, resource_id: String) -> bool {
        self.runtime.release_pty(&resource_id)
    }

    #[napi]
    pub fn pty_report(&self, resource_id: String) -> Result<CloseReport> {
        Ok(self
            .runtime
            .pty(&resource_id)
            .map_err(failure)?
            .snapshot()
            .into())
    }

    #[napi]
    pub fn shutdown(&self, deadline_ms: u32) -> Result<AsyncTask<ShutdownTask>> {
        Ok(AsyncTask::new(ShutdownTask(Some(
            self.runtime
                .prepare_shutdown(deadline_ms)
                .map_err(failure)?,
        ))))
    }

    #[napi]
    pub fn counts(&self) -> Counts {
        let (searches, ptys) = self.runtime.counts();
        Counts {
            searches: searches as u32,
            ptys: ptys as u32,
            search_sessions: self.runtime.search_session_count() as u32,
        }
    }
}

impl Default for NativeHost {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
pub fn abi_version() -> u32 {
    1
}

#[napi]
pub fn process_id() -> u32 {
    std::process::id()
}
