use super::{events, network, profile::Profile, runtime::ScopedRuntime};
use crate::{deadline, valid_id, NativeError, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Notify};
use wacore::runtime::Runtime as _;
use wacore::store::DeviceCommand;
use waproto::whatsapp as wa;
use whatsapp_rust::client::Client;
use whatsapp_rust::store::persistence_manager::PersistenceManager;
use whatsapp_rust_sqlite_storage::SqliteStore;

const MAX_PENDING: usize = 8;
static RESOURCES: AtomicUsize = AtomicUsize::new(0);
pub(super) fn error(code: &'static str) -> NativeError {
    NativeError::new(code, code)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub auth_dir: PathBuf,
}
pub enum Action {
    Open,
    SendText { jid: String, text: String },
}

struct Pending {
    expires: Instant,
    cancelled: AtomicBool,
    changed: Notify,
    started: AtomicBool,
}
impl Pending {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(error("CANCELLED"))
        } else if Instant::now() >= self.expires {
            Err(error("DEADLINE_EXCEEDED"))
        } else {
            Ok(())
        }
    }
    async fn race<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        let changed = self.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        self.check()?;
        tokio::select! { biased;
            _ = changed => Err(error("CANCELLED")),
            _ = tokio::time::sleep_until(self.expires.into()) => Err(error("DEADLINE_EXCEEDED")),
            result = future => result,
        }
    }
    fn outcome(&self, cause: NativeError) -> NativeError {
        if self.started.load(Ordering::Acquire) {
            error("WHATSAPP_SEND_OUTCOME_UNKNOWN")
        } else {
            cause
        }
    }
}
#[derive(Default)]
struct State {
    closing: bool,
    complete: bool,
    connected: bool,
    opened: bool,
    reading: bool,
    sequence: u32,
    bytes: usize,
    queue: VecDeque<(Value, usize)>,
    pending: HashMap<String, Arc<Pending>>,
    error: Option<&'static str>,
    terminal: Option<&'static str>,
}
pub(super) struct Shared {
    resource_id: String,
    state: Mutex<State>,
    changed: Notify,
    events: Notify,
    stop: Notify,
}
impl Shared {
    pub fn is_closing(&self) -> bool {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).closing
    }
    pub async fn cancelled(&self) {
        loop {
            let stop = self.stop.notified();
            tokio::pin!(stop);
            stop.as_mut().enable();
            if self.is_closing() {
                return;
            }
            stop.await;
        }
    }
    fn request_close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closing = true;
        state.connected = false;
        state.queue.clear();
        state.bytes = 0;
        for pending in state.pending.values() {
            pending.cancel();
        }
        drop(state);
        self.stop.notify_waiters();
        self.events.notify_waiters();
        self.changed.notify_waiters();
    }
    pub fn fail(&self, code: &'static str) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).error = Some(code);
        self.request_close();
    }
    pub fn publish(&self, mut value: Value) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            return;
        }
        if state.sequence == u32::MAX {
            drop(state);
            self.fail("WHATSAPP_EVENT_QUEUE_FULL");
            return;
        }
        value["resourceId"] = json!(self.resource_id);
        value["sequence"] = json!(state.sequence + 1);
        let bytes = value.to_string().len();
        if state.queue.len() >= 128 || state.bytes + bytes > 8 * 1024 * 1024 {
            drop(state);
            self.fail("WHATSAPP_EVENT_QUEUE_FULL");
            return;
        }
        let kind = value["kind"].as_str().unwrap_or("");
        state.terminal = match kind {
            "loggedOut" => Some("loggedOut"),
            "streamReplaced" => Some("streamReplaced"),
            "clientOutdated" => Some("clientOutdated"),
            "temporaryBan" => Some("temporaryBan"),
            _ => state.terminal,
        };
        match kind {
            "connected" => state.connected = true,
            "disconnected" | "loggedOut" | "connectFailure" | "streamReplaced"
            | "clientOutdated" | "temporaryBan" => state.connected = false,
            _ => {}
        }
        state.sequence += 1;
        state.bytes += bytes;
        state.queue.push_back((value, bytes));
        drop(state);
        self.events.notify_waiters();
    }
    fn report(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut pending: Vec<_> = state.pending.keys().cloned().collect();
        pending.sort();
        json!({"resourceId":self.resource_id,"complete":state.complete,"closing":state.closing,
            "connected":state.connected,"opened":state.opened,"lastSequence":state.sequence,
            "queuedEvents":state.queue.len(),"queuedBytes":state.bytes,"pendingOperations":pending,"error":state.error,"terminal":state.terminal})
    }
}
struct Message {
    operation_id: String,
    action: Action,
    pending: Arc<Pending>,
    response: oneshot::Sender<Result<Value>>,
}
pub struct WhatsAppService {
    shared: Arc<Shared>,
    sender: mpsc::Sender<Message>,
}
pub struct Ticket {
    operation_id: String,
    shared: Arc<Shared>,
    pending: Arc<Pending>,
    response: oneshot::Receiver<Result<Value>>,
}
impl Ticket {
    pub async fn wait(mut self) -> Result<Value> {
        // The worker owns the terminal result. Cancellation cannot detach storage or a send.
        let result = (&mut self.response)
            .await
            .map_err(|_| error("WHATSAPP_WORKER_STOPPED"))??;
        Ok(
            json!({"resourceId":self.shared.resource_id,"operationId":self.operation_id,"result":result}),
        )
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        self.pending.cancel();
    }
}
impl WhatsAppService {
    pub fn new(resource_id: String, options: Options) -> Result<Self> {
        Self::with_endpoints(resource_id, options, network::Endpoints::production())
    }
    #[cfg(feature = "whatsapp-fixtures")]
    pub fn fixture(resource_id: String, options: Options, base: &str) -> Result<Self> {
        Self::with_endpoints(resource_id, options, network::Endpoints::fixture(base)?)
    }
    fn with_endpoints(
        resource_id: String,
        options: Options,
        endpoints: network::Endpoints,
    ) -> Result<Self> {
        valid_id(&resource_id)?;
        let path = options
            .auth_dir
            .to_str()
            .ok_or_else(|| error("WHATSAPP_INVALID_AUTH_DIR"))?;
        if !options.auth_dir.is_absolute()
            || path.len() > 4096
            || path.chars().any(|c| matches!(c, '\0' | '?' | '#'))
        {
            return Err(error("WHATSAPP_INVALID_AUTH_DIR"));
        }
        RESOURCES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 4).then_some(n + 1)
            })
            .map_err(|_| error("WHATSAPP_RESOURCE_LIMIT"))?;
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
            .name("klaus-whatsapp".into())
            .spawn(move || {
                struct Guard(Arc<Shared>);
                impl Drop for Guard {
                    fn drop(&mut self) {
                        if std::thread::panicking() {
                            self.0.fail("WHATSAPP_WORKER_PANICKED");
                        }
                        self.0.request_close();
                        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
                        state.complete = true;
                        state.pending.clear();
                        drop(state);
                        RESOURCES.fetch_sub(1, Ordering::AcqRel);
                        self.0.changed.notify_waiters();
                        self.0.events.notify_waiters();
                    }
                }
                let _guard = Guard(Arc::clone(&worker_shared));
                // Drop order is intentional: protocol tasks and blocking SQLite jobs, then the profile lock.
                let mut profile = None;
                let mut client_probe = std::sync::Weak::<Client>::new();
                match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => {
                        runtime.block_on(worker(
                            &worker_shared,
                            receiver,
                            options,
                            endpoints,
                            &mut profile,
                            &mut client_probe,
                        ));
                        drop(runtime);
                    }
                    Err(_) => worker_shared.fail("WHATSAPP_WORKER_START_FAILED"),
                }
                // A hidden library Arc cycle must not release another owner's Signal profile lock.
                while client_probe.strong_count() != 0 {
                    worker_shared.fail("WHATSAPP_CLIENT_DID_NOT_RELEASE");
                    std::thread::park_timeout(Duration::from_millis(100));
                }
                drop(profile);
            });
        if spawned.is_err() {
            RESOURCES.fetch_sub(1, Ordering::AcqRel);
            return Err(error("WHATSAPP_WORKER_START_FAILED"));
        }
        Ok(Self { shared, sender })
    }
    pub fn prepare(
        &self,
        operation_id: String,
        action: Action,
        deadline_ms: u32,
    ) -> Result<Ticket> {
        valid_id(&operation_id)?;
        let expires = deadline(deadline_ms)?;
        if let Action::SendText { jid, text } = &action {
            if jid.is_empty()
                || jid.len() > 512
                || !jid.contains('@')
                || jid.chars().any(|c| c.is_whitespace() || c == '\0')
                || jid.parse::<wacore_binary::jid::Jid>().is_err()
                || text.trim().is_empty()
                || text.len() > 65_536
                || text.contains('\0')
            {
                return Err(error("WHATSAPP_INVALID_MESSAGE"));
            }
        }
        let pending = Arc::new(Pending {
            expires,
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            started: AtomicBool::new(false),
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
            return Err(error("WHATSAPP_WORKER_STOPPED"));
        }
        Ok(Ticket {
            operation_id,
            shared: Arc::clone(&self.shared),
            pending,
            response: receiver,
        })
    }
    pub fn cancel(&self, operation_id: &str) -> bool {
        let state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pending) = state.pending.get(operation_id) {
            pending.cancel();
            true
        } else {
            false
        }
    }
    pub fn report(&self) -> Value {
        self.shared.report()
    }
    pub fn read_event(
        &self,
    ) -> Result<impl Future<Output = Result<Option<Value>>> + Send + 'static> {
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.reading {
            return Err(error("WHATSAPP_EVENT_READER_BUSY"));
        }
        state.reading = true;
        drop(state);
        struct Reader(Arc<Shared>);
        impl Drop for Reader {
            fn drop(&mut self) {
                self.0
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .reading = false;
            }
        }
        let shared = Arc::clone(&self.shared);
        let guard = Reader(Arc::clone(&shared));
        Ok(async move {
            let _guard = guard;
            loop {
                let next = shared.events.notified();
                tokio::pin!(next);
                next.as_mut().enable();
                {
                    let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
                    if state.closing {
                        return Ok(None);
                    }
                    if let Some((event, bytes)) = state.queue.pop_front() {
                        state.bytes -= bytes;
                        return Ok(Some(event));
                    }
                }
                next.await;
            }
        })
    }
    pub fn shutdown(
        &self,
        deadline_ms: u32,
    ) -> Result<impl Future<Output = Value> + Send + 'static> {
        let until = deadline(deadline_ms)?;
        self.shared.request_close();
        let shared = Arc::clone(&self.shared);
        Ok(async move {
            loop {
                let changed = shared.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if shared.report()["complete"] == true || Instant::now() >= until {
                    return shared.report();
                }
                tokio::select! { _=changed=>{},_=tokio::time::sleep_until(until.into())=>return shared.report() }
            }
        })
    }
}
impl Drop for WhatsAppService {
    fn drop(&mut self) {
        self.shared.request_close();
    }
}

async fn open(
    shared: &Arc<Shared>,
    options: &Options,
    endpoints: network::Endpoints,
    profile: &mut Option<Profile>,
    scope: &ScopedRuntime,
) -> Result<Arc<Client>> {
    *profile = Some(Profile::acquire(&options.auth_dir)?);
    let backend = SqliteStore::new(&profile.as_ref().expect("profile acquired").database)
        .await
        .map_err(|_| error("WHATSAPP_STORE_OPEN_FAILED"))?;
    let persistence = Arc::new(
        PersistenceManager::new(Arc::new(backend))
            .await
            .map_err(|_| error("WHATSAPP_STORE_OPEN_FAILED"))?,
    );
    let runtime: Arc<dyn wacore::runtime::Runtime> = Arc::new(scope.clone());
    persistence
        .clone()
        .run_background_saver(Arc::clone(&runtime), Duration::from_secs(30));
    persistence
        .process_command(DeviceCommand::SetDeviceProps(
            Some("Klaus".into()),
            None,
            Some(wa::device_props::PlatformType::Desktop),
        ))
        .await;
    let http = Arc::new(
        network::Http::new(Arc::clone(shared), endpoints.clone())
            .map_err(|_| error("WHATSAPP_TLS_SETUP_FAILED"))?,
    );
    let transport = Arc::new(network::Factory::new(Arc::clone(shared), endpoints));
    let (client, sync) = Client::new(runtime, persistence, transport, http, None).await;
    client.register_handler(Arc::new(events::Handler(Arc::downgrade(shared))));
    let weak = Arc::downgrade(&client);
    scope
        .spawn(Box::pin(async move {
            while let Ok(task) = sync.recv().await {
                let Some(client) = weak.upgrade() else { break };
                client.process_sync_task(task).await;
            }
        }))
        .detach();
    shared
        .state
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .opened = true;
    Ok(client)
}
async fn worker(
    shared: &Arc<Shared>,
    mut receiver: mpsc::Receiver<Message>,
    options: Options,
    endpoints: network::Endpoints,
    profile: &mut Option<Profile>,
    client_probe: &mut std::sync::Weak<Client>,
) {
    let scope = ScopedRuntime::new(shared);
    let mut client: Option<Arc<Client>> = None;
    let mut running: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        let message = tokio::select! {biased;
            _=shared.cancelled()=>break,
            _=async{if let Some(task)=&mut running{let _=task.await;}else{std::future::pending::<()>().await}}=>{
                running=None; shared.publish(json!({"kind":"stopped"}));break;
            },
            value=receiver.recv()=>match value{Some(value)=>value,None=>break},
        };
        let result = match message.action {
            Action::Open => {
                if client.is_some() {
                    Err(error("WHATSAPP_ALREADY_OPEN"))
                } else {
                    match message
                        .pending
                        .race(open(shared, &options, endpoints.clone(), profile, &scope))
                        .await
                    {
                        Ok(value) => {
                            *client_probe = Arc::downgrade(&value);
                            let run = Arc::clone(&value);
                            running = Some(tokio::spawn(async move { run.run().await }));
                            client = Some(value);
                            Ok(json!({"started":true}))
                        }
                        Err(cause) => {
                            shared.fail(cause.code);
                            Err(cause)
                        }
                    }
                }
            }
            Action::SendText { jid, text } => {
                if !shared
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .connected
                {
                    Err(error("WHATSAPP_NOT_CONNECTED"))
                } else if let Some(client) = &client {
                    let pending = &message.pending;
                    let sent = pending
                        .race(async {
                            pending.check()?;
                            let jid = jid.parse().map_err(|_| error("WHATSAPP_INVALID_MESSAGE"))?;
                            pending.started.store(true, Ordering::Release);
                            let id = client
                                .send_message(
                                    jid,
                                    wa::Message {
                                        conversation: Some(text),
                                        ..Default::default()
                                    },
                                )
                                .await
                                .map_err(|_| error("WHATSAPP_SEND_FAILED"))?;
                            if id.is_empty() || id.len() > 1024 {
                                return Err(error("WHATSAPP_SEND_RECEIPT_INVALID"));
                            }
                            Ok(json!({"messageId":id}))
                        })
                        .await;
                    if let Err(cause) = sent {
                        let cause = pending.outcome(cause);
                        if pending.started.load(Ordering::Acquire) {
                            shared.fail(cause.code);
                        }
                        Err(cause)
                    } else {
                        sent
                    }
                } else {
                    Err(error("WHATSAPP_NOT_OPEN"))
                }
            }
        };
        shared
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending
            .remove(&message.operation_id);
        let _ = message.response.send(result);
        shared.changed.notify_waiters();
    }
    shared.request_close();
    if let Some(task) = running {
        task.abort();
        let _ = task.await;
    }
    // Stop every detached protocol task before the final Signal/database commit.
    // Blocking operations remain registered until their actual closures return.
    scope.close().await;
    if let Some(client) = client {
        if client.flush_signal_cache().await.is_err()
            || client.persistence_manager().flush().await.is_err()
        {
            shared.state.lock().unwrap_or_else(|p| p.into_inner()).error =
                Some("WHATSAPP_STORE_FLUSH_FAILED");
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), client.disconnect()).await;
    }
    receiver.close();
    while let Some(message) = receiver.recv().await {
        shared
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending
            .remove(&message.operation_id);
        let _ = message.response.send(Err(error("CLOSED")));
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
