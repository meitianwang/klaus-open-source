use super::{config, protocol};
use crate::{deadline, valid_id, NativeError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, Notify};
use zeroize::Zeroizing;

const MAX_RESOURCES: usize = 12;
const MAX_PENDING: usize = 8;
static RESOURCES: AtomicUsize = AtomicUsize::new(0);

pub(super) fn error(code: &'static str) -> NativeError {
    NativeError::new(code, code)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshOptions {
    pub user_home: PathBuf,
    pub local_user: String,
    /// Supplied by the trusted main process. No process environment is mutated or read here.
    pub agent_path: Option<PathBuf>,
}

pub enum Action {
    ListHosts,
    Connect(config::Target),
    Execute(String),
}

pub(super) struct Pending {
    expires: Instant,
    cancelled: AtomicBool,
    changed: Notify,
    pub remote_started: AtomicBool,
}

impl Pending {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(error("CANCELLED"))
        } else if Instant::now() >= self.expires {
            Err(error("DEADLINE_EXCEEDED"))
        } else {
            Ok(())
        }
    }
    async fn race<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        let cancelled = self.changed.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        self.check()?;
        tokio::select! {
            biased;
            _ = cancelled => Err(error("CANCELLED")),
            _ = tokio::time::sleep_until(self.expires.into()) => Err(error("DEADLINE_EXCEEDED")),
            result = future => { self.check()?; result },
        }
    }
    fn outcome_error(&self, cause: NativeError) -> NativeError {
        if self.remote_started.load(Ordering::Acquire)
            && matches!(
                cause.code,
                "CANCELLED" | "DEADLINE_EXCEEDED" | "SSH_TRANSPORT_FAILED"
            )
        {
            NativeError::new(
                "SSH_OPERATION_OUTCOME_UNKNOWN",
                format!(
                    "{}; connection closed; the remote command is not replayed",
                    cause.code
                ),
            )
        } else {
            cause
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub resource_id: String,
    pub operation_id: String,
    pub request_id: String,
    pub sequence: u32,
    pub prompt: String,
    pub echo: bool,
}

struct Prompt {
    event: Challenge,
    delivered: bool,
    answer: oneshot::Sender<Option<Zeroizing<String>>>,
}

#[derive(Default)]
struct State {
    closing: bool,
    complete: bool,
    connected: bool,
    reading: bool,
    sequence: u32,
    pending: HashMap<String, Arc<Pending>>,
    socket: Option<Arc<TcpStream>>,
    prompt: Option<Prompt>,
}

pub(super) struct Shared {
    pub resource_id: String,
    state: Mutex<State>,
    changed: Notify,
    events: Notify,
    stop: Notify,
}

impl Shared {
    pub fn install_socket(&self, socket: TcpStream) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(error("CLOSED"));
        }
        state.socket = Some(Arc::new(socket));
        Ok(())
    }
    pub fn check_open(&self) -> Result<()> {
        if self.state.lock().unwrap_or_else(|p| p.into_inner()).closing {
            Err(error("CLOSED"))
        } else {
            Ok(())
        }
    }
    fn request_close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closing = true;
        state.connected = false;
        state.prompt.take();
        for pending in state.pending.values() {
            pending.cancel();
        }
        if let Some(socket) = &state.socket {
            let _ = socket.shutdown(Shutdown::Both);
        }
        drop(state);
        self.events.notify_waiters();
        self.changed.notify_waiters();
        self.stop.notify_one();
    }
    pub async fn prompt(
        &self,
        operation_id: &str,
        index: usize,
        prompt: String,
        echo: bool,
    ) -> Result<Zeroizing<String>> {
        if index >= 16 || prompt.len() > 4096 || prompt.contains('\0') {
            return Err(error("SSH_AUTH_PROMPT_LIMIT"));
        }
        let (answer, receiver) = oneshot::channel();
        let request_id = format!("{operation_id}:{index}");
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.closing {
                return Err(error("CLOSED"));
            }
            if state.prompt.is_some() {
                return Err(error("SSH_AUTH_PROMPT_BUSY"));
            }
            state.prompt = Some(Prompt {
                event: Challenge {
                    resource_id: self.resource_id.clone(),
                    operation_id: operation_id.into(),
                    request_id,
                    sequence: 0,
                    prompt,
                    echo,
                },
                delivered: false,
                answer,
            });
        }
        self.events.notify_waiters();
        receiver
            .await
            .map_err(|_| error("CANCELLED"))?
            .ok_or_else(|| error("CANCELLED"))
    }
    fn report(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut pending: Vec<_> = state.pending.keys().cloned().collect();
        pending.sort();
        json!({ "resourceId": self.resource_id, "complete": state.complete, "closing": state.closing,
            "connected": state.connected, "lastSequence": state.sequence, "pendingOperations": pending })
    }
}

struct Message {
    operation_id: String,
    action: Action,
    pending: Arc<Pending>,
    response: oneshot::Sender<Result<Value>>,
}

pub struct SshService {
    shared: Arc<Shared>,
    sender: mpsc::Sender<Message>,
}
pub struct Ticket {
    operation_id: String,
    pending: Arc<Pending>,
    shared: Arc<Shared>,
    response: oneshot::Receiver<Result<Value>>,
}

impl Ticket {
    pub async fn wait(mut self) -> Result<Value> {
        let cancelled = self.pending.changed.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        self.pending
            .check()
            .map_err(|cause| self.pending.outcome_error(cause))?;
        let result = tokio::select! {
            biased;
            response = &mut self.response => response.unwrap_or_else(|_| Err(error("SSH_WORKER_STOPPED"))),
            _ = cancelled => Err(self.pending.outcome_error(error("CANCELLED"))),
            _ = tokio::time::sleep_until(self.pending.expires.into()) => {
                self.pending.cancel(); Err(self.pending.outcome_error(error("DEADLINE_EXCEEDED")))
            },
        }?;
        Ok(
            json!({ "resourceId": self.shared.resource_id, "operationId": self.operation_id, "result": result }),
        )
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        self.pending.cancel();
    }
}

impl SshService {
    pub fn new(resource_id: String, options: SshOptions) -> Result<Self> {
        valid_id(&resource_id)?;
        if !options.user_home.is_absolute()
            || options.user_home.as_os_str().len() > 4096
            || options.local_user.len() > 255
            || options
                .agent_path
                .as_ref()
                .is_some_and(|p| p.as_os_str().len() > 4096)
        {
            return Err(error("SSH_INVALID_OPTIONS"));
        }
        RESOURCES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_RESOURCES).then_some(n + 1)
            })
            .map_err(|_| error("SSH_RESOURCE_LIMIT"))?;
        let shared = Arc::new(Shared {
            resource_id,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            events: Notify::new(),
            stop: Notify::new(),
        });
        let (sender, receiver) = mpsc::channel(MAX_PENDING);
        let worker_shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("klaus-ssh".into())
            .spawn(move || {
                struct Guard(Arc<Shared>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        self.0.request_close();
                        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
                        state.complete = true;
                        state.pending.clear();
                        state.socket.take();
                        drop(state);
                        RESOURCES.fetch_sub(1, Ordering::AcqRel);
                        self.0.events.notify_waiters();
                        self.0.changed.notify_waiters();
                    }
                }
                // The runtime and all its protocol tasks drop before completion becomes observable.
                let _guard = Guard(Arc::clone(&worker_shared));
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(worker(&worker_shared, receiver, options));
                    drop(runtime);
                }
            });
        if spawned.is_err() {
            RESOURCES.fetch_sub(1, Ordering::AcqRel);
            return Err(error("SSH_WORKER_START_FAILED"));
        }
        Ok(Self { shared, sender })
    }

    /// Admission runs synchronously before a JavaScript Promise can reorder two calls.
    pub fn prepare(
        &self,
        operation_id: String,
        action: Action,
        deadline_ms: u32,
    ) -> Result<Ticket> {
        valid_id(&operation_id)?;
        let expires = deadline(deadline_ms)?;
        match &action {
            Action::Connect(target) => target.validate()?,
            Action::Execute(command)
                if command.is_empty() || command.len() > 32768 || command.contains('\0') =>
            {
                return Err(error("SSH_INVALID_COMMAND"))
            }
            _ => {}
        }
        let pending = Arc::new(Pending {
            expires,
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            remote_started: AtomicBool::new(false),
        });
        let (response, receiver) = oneshot::channel();
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            return Err(error("CLOSED"));
        }
        if state.pending.len() >= MAX_PENDING {
            return Err(error("BUSY"));
        }
        if state.pending.contains_key(&operation_id) {
            return Err(error("DUPLICATE_OPERATION"));
        }
        state
            .pending
            .insert(operation_id.clone(), Arc::clone(&pending));
        if self
            .sender
            .try_send(Message {
                operation_id: operation_id.clone(),
                action,
                pending: Arc::clone(&pending),
                response,
            })
            .is_err()
        {
            state.pending.remove(&operation_id);
            return Err(error("SSH_WORKER_STOPPED"));
        }
        Ok(Ticket {
            operation_id,
            pending,
            shared: Arc::clone(&self.shared),
            response: receiver,
        })
    }

    pub fn cancel(&self, operation_id: &str) -> bool {
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pending) = state.pending.get(operation_id) else {
            return false;
        };
        pending.cancel();
        if state
            .prompt
            .as_ref()
            .is_some_and(|p| p.event.operation_id == operation_id)
        {
            state.prompt.take();
        }
        drop(state);
        self.shared.events.notify_waiters();
        true
    }

    pub fn answer(
        &self,
        operation_id: &str,
        request_id: &str,
        answer: Option<String>,
    ) -> Result<bool> {
        let answer = answer.map(Zeroizing::new);
        if answer
            .as_ref()
            .is_some_and(|s| s.len() > 16384 || s.contains('\0'))
        {
            return Err(error("SSH_AUTH_ANSWER_LIMIT"));
        }
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing
            || !state.prompt.as_ref().is_some_and(|p| {
                p.delivered
                    && p.event.operation_id == operation_id
                    && p.event.request_id == request_id
            })
        {
            return Ok(false);
        }
        let prompt = state.prompt.take().expect("matching prompt");
        Ok(prompt.answer.send(answer).is_ok())
    }

    pub fn read_event(
        &self,
    ) -> Result<impl Future<Output = Result<Option<Challenge>>> + Send + 'static> {
        {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.reading {
                return Err(error("SSH_EVENT_READER_BUSY"));
            }
            state.reading = true;
        }
        let shared = Arc::clone(&self.shared);
        struct ReaderGuard(Arc<Shared>);
        impl Drop for ReaderGuard {
            fn drop(&mut self) {
                self.0
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .reading = false;
            }
        }
        let guard = ReaderGuard(Arc::clone(&shared));
        Ok(async move {
            let _guard = guard;
            loop {
                let notified = shared.events.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
                    if state.closing {
                        return Ok(None);
                    }
                    if state.prompt.as_ref().is_some_and(|p| !p.delivered) {
                        state.sequence = state
                            .sequence
                            .checked_add(1)
                            .ok_or_else(|| error("SSH_EVENT_SEQUENCE_LIMIT"))?;
                        let sequence = state.sequence;
                        let prompt = state.prompt.as_mut().expect("pending prompt");
                        prompt.delivered = true;
                        prompt.event.sequence = sequence;
                        return Ok(Some(prompt.event.clone()));
                    }
                }
                notified.await;
            }
        })
    }

    pub fn report(&self) -> Value {
        self.shared.report()
    }
    pub fn shutdown(
        &self,
        deadline_ms: u32,
    ) -> Result<impl Future<Output = Value> + Send + 'static> {
        let expires = deadline(deadline_ms)?;
        self.shared.request_close();
        let shared = Arc::clone(&self.shared);
        Ok(async move {
            loop {
                let notified = shared.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if shared.report()["complete"] == true || Instant::now() >= expires {
                    return shared.report();
                }
                if tokio::time::timeout_at(expires.into(), notified)
                    .await
                    .is_err()
                {
                    return shared.report();
                }
            }
        })
    }
}
impl Drop for SshService {
    fn drop(&mut self) {
        self.shared.request_close();
    }
}

async fn worker(shared: &Arc<Shared>, mut receiver: mpsc::Receiver<Message>, options: SshOptions) {
    let mut connection: Option<Arc<AsyncMutex<protocol::Connection>>> = None;
    loop {
        if shared.check_open().is_err() {
            break;
        }
        let message = tokio::select! { biased; _ = shared.stop.notified() => break, message = receiver.recv() => match message { Some(m) => m, None => break } };
        let Message {
            operation_id,
            action,
            pending,
            response,
        } = message;
        // Each exec opens its own session channel on the multiplexed
        // connection, so commands run concurrently instead of queueing behind
        // the slowest one; the pending-operation cap bounds the fan-out.
        if let Action::Execute(command) = action {
            let Some(slot) = connection.clone() else {
                let _ = response.send(Err(error("SSH_NOT_CONNECTED")));
                continue;
            };
            let shared = Arc::clone(shared);
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                let opened = pending
                    .race(async {
                        let guard = slot.lock().await;
                        protocol::open_session(&guard).await
                    })
                    .await;
                let result = match opened {
                    Ok(channel) => pending
                        .race(protocol::execute_opened(channel, &pending, &command))
                        .await
                        .map_err(|cause| pending.outcome_error(cause)),
                    Err(cause) => Err(pending.outcome_error(cause)),
                };
                // An interrupted transport is discarded. In particular, an
                // accepted exec is never replayed.
                let fatal = result.is_err();
                {
                    let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
                    state.pending.remove(&operation_id);
                    if state
                        .prompt
                        .as_ref()
                        .is_some_and(|p| p.event.operation_id == operation_id)
                    {
                        state.prompt.take();
                    }
                }
                let _ = response.send(result);
                if fatal {
                    shared.request_close();
                }
                shared.changed.notify_waiters();
                shared.events.notify_waiters();
            });
            continue;
        }
        let fatal_on_error = !matches!(action, Action::ListHosts);
        let result = pending.race(async {
            shared.check_open()?;
            match action {
                Action::ListHosts => Ok(json!({ "hosts": config::list_hosts(&options.user_home)? })),
                Action::Connect(target) => {
                    if connection.is_some() { return Err(error("SSH_ALREADY_CONNECTED")); }
                    let endpoint = config::resolve(&options.user_home, &options.local_user, options.agent_path.as_deref(), &target)?;
                    let connected = protocol::connect(shared, &pending, &operation_id, &endpoint).await?;
                    connection = Some(Arc::new(AsyncMutex::new(connected)));
                    shared.state.lock().unwrap_or_else(|p| p.into_inner()).connected = true;
                    Ok(json!({ "connected": true, "host": endpoint.host, "port": endpoint.port, "user": endpoint.user }))
                }
                Action::Execute(_) => unreachable!("execute is dispatched above"),
            }
        }).await.map_err(|cause| pending.outcome_error(cause));
        {
            let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
            state.pending.remove(&operation_id);
            if state
                .prompt
                .as_ref()
                .is_some_and(|p| p.event.operation_id == operation_id)
            {
                state.prompt.take();
            }
        }
        let failed = result.is_err();
        let _ = response.send(result);
        if failed && fatal_on_error {
            shared.request_close();
        }
        shared.changed.notify_waiters();
        shared.events.notify_waiters();
    }
    shared.request_close();
    while let Ok(message) = receiver.try_recv() {
        let _ = message.response.send(Err(error("CANCELLED")));
    }
    drop(connection);
}
