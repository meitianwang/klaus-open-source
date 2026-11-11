use super::{error, CredentialStore, McpKey, WorkBuddyRegion};
use crate::{deadline, valid_id, Operation, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;
use tokio::sync::{oneshot, Notify};

const MAX_WORKERS: usize = 4;
const MAX_PENDING: usize = 8;
/// One slot beyond the operation limit, reserved so the stop sentinel can always be
/// enqueued even when every pending slot is taken. A close that cannot be delivered
/// would leave the worker blocked forever and report `complete: false`.
const CHANNEL_CAPACITY: usize = MAX_PENDING + 1;
static WORKERS: AtomicUsize = AtomicUsize::new(0);

pub enum Action {
    ReadClaudeOAuth,
    ReadClaudeAccounts,
    WriteClaudeOAuth(Value),
    WriteClaudeAccounts(Value),
    RemoveClaudeOAuth,
    ReadLocalClaudeCredential,
    ReadCursorCredential,
    ReadQoderIdeCredential,
    ReadAntigravityKeychainSecret,
    ReadQoderWorkCredential,
    ReadQwenWorkCredential,
    ReadWorkBuddyCredential(Option<WorkBuddyRegion>),
    ReadMcpOAuthRecord(McpKey),
    WriteMcpOAuthRecord(McpKey, Value),
    RemoveMcpOAuthRecord(McpKey),
}

impl Action {
    fn execute(self, store: &CredentialStore) -> Value {
        match self {
            Self::ReadClaudeOAuth => store.read_claude_oauth(),
            Self::ReadClaudeAccounts => store.read_claude_accounts(),
            Self::WriteClaudeOAuth(value) => store.write_claude_oauth(value),
            Self::WriteClaudeAccounts(value) => store.write_claude_accounts(value),
            Self::RemoveClaudeOAuth => json!(store.remove_claude_oauth()),
            Self::ReadLocalClaudeCredential => store.read_local_claude_credential(),
            Self::ReadCursorCredential => store.read_cursor_credential(),
            Self::ReadQoderIdeCredential => store.read_qoder_ide_credential(),
            Self::ReadAntigravityKeychainSecret => store.read_antigravity_keychain_secret(),
            Self::ReadQoderWorkCredential => store.read_qoderwork_credential(),
            Self::ReadQwenWorkCredential => store.read_qwenwork_credential(),
            Self::ReadWorkBuddyCredential(region) => store.read_workbuddy_credential(region),
            Self::ReadMcpOAuthRecord(key) => store.read_mcp_oauth_record(&key),
            Self::WriteMcpOAuthRecord(key, value) => store.write_mcp_oauth_record(&key, value),
            Self::RemoveMcpOAuthRecord(key) => json!(store.remove_mcp_oauth_record(&key)),
        }
    }
}

struct Pending {
    operation: Operation,
    started: AtomicBool,
}

#[derive(Default)]
struct State {
    closing: bool,
    complete: bool,
    pending: HashMap<String, Arc<Pending>>,
}

struct Shared {
    resource_id: String,
    state: Mutex<State>,
    changed: Notify,
}

enum Message {
    /// One credential operation. The worker blocks on the channel, so a close must
    /// travel through it rather than through a flag the worker polls.
    Work {
        operation_id: String,
        action: Action,
        pending: Arc<Pending>,
        response: oneshot::Sender<Result<Value>>,
    },
    /// Stop sentinel. `request_close` enqueues it so a blocked worker wakes at once.
    Stop,
}

/// Settle every operation still queued behind a stop sentinel as cancelled, so no
/// caller is left waiting on a worker that will never read its message.
fn drain_cancelled(receiver: &mpsc::Receiver<Message>) {
    while let Ok(message) = receiver.try_recv() {
        if let Message::Work { response, .. } = message {
            let _ = response.send(Err(error("CANCELLED")));
        }
    }
}

pub struct CredentialService {
    shared: Arc<Shared>,
    sender: mpsc::SyncSender<Message>,
}

pub struct Ticket {
    operation_id: String,
    deadline: Instant,
    pending: Arc<Pending>,
    shared: Arc<Shared>,
    response: oneshot::Receiver<Result<Value>>,
}

impl Ticket {
    /// Once an OS write starts, timeout means unknown outcome, never a claimed rollback.
    pub async fn wait(mut self) -> Result<Value> {
        match tokio::time::timeout_at(self.deadline.into(), &mut self.response).await {
            Ok(Ok(result)) => result.map(|result| {
                json!({
                    "resourceId": self.shared.resource_id,
                    "operationId": self.operation_id,
                    "result": result,
                })
            }),
            Ok(Err(_)) => Err(error("credential_worker_stopped")),
            Err(_) => {
                let _state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
                if self.pending.started.load(Ordering::Acquire) {
                    Err(error("credential_operation_outcome_unknown"))
                } else {
                    self.pending.operation.cancel();
                    Err(error("DEADLINE_EXCEEDED"))
                }
            }
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.pending.operation.cancel();
    }
}

impl CredentialService {
    pub fn new(resource_id: String, store: CredentialStore) -> Result<Self> {
        valid_id(&resource_id)?;
        WORKERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_WORKERS).then_some(n + 1)
            })
            .map_err(|_| error("CREDENTIAL_RESOURCE_LIMIT"))?;
        let shared = Arc::new(Shared {
            resource_id,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        });
        let (sender, receiver) = mpsc::sync_channel::<Message>(CHANNEL_CAPACITY);
        let worker_shared = Arc::clone(&shared);
        if std::thread::Builder::new()
            .name("klaus-credentials".into())
            .spawn(move || {
                struct WorkerGuard(Arc<Shared>);
                impl Drop for WorkerGuard {
                    fn drop(&mut self) {
                        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
                        state.closing = true;
                        state.complete = true;
                        state.pending.clear();
                        drop(state);
                        WORKERS.fetch_sub(1, Ordering::AcqRel);
                        self.0.changed.notify_waiters();
                    }
                }
                let _guard = WorkerGuard(Arc::clone(&worker_shared));
                loop {
                    // Blocking wait: the worker performs no wakeups of its own while
                    // idle. `request_close` delivers `Stop` through this same channel,
                    // so closing does not need a polling interval to be noticed.
                    let message = match receiver.recv() {
                        Ok(message) => message,
                        Err(mpsc::RecvError) => break,
                    };
                    let (operation_id, action, pending, response) = match message {
                        Message::Stop => {
                            drain_cancelled(&receiver);
                            break;
                        }
                        Message::Work {
                            operation_id,
                            action,
                            pending,
                            response,
                        } => (operation_id, action, pending, response),
                    };
                    let admission = {
                        let state = worker_shared
                            .state
                            .lock()
                            .unwrap_or_else(|p| p.into_inner());
                        if state.closing {
                            Err(error("CANCELLED"))
                        } else {
                            pending.operation.check().map(|()| {
                                pending.started.store(true, Ordering::Release);
                            })
                        }
                    };
                    let result = admission.map(|()| action.execute(&store));
                    // Settle before allowing the next command: write then logout always stays ordered.
                    let _ = response.send(result);
                    let mut state = worker_shared
                        .state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    state.pending.remove(&operation_id);
                    drop(state);
                    worker_shared.changed.notify_waiters();
                }
            })
            .is_err()
        {
            WORKERS.fetch_sub(1, Ordering::AcqRel);
            return Err(error("credential_worker_start_failed"));
        }
        Ok(Self { shared, sender })
    }

    /// Enqueue synchronously on the calling thread, before Promise scheduling can reorder calls.
    pub fn prepare(
        &self,
        operation_id: String,
        action: Action,
        deadline_ms: u32,
    ) -> Result<Ticket> {
        valid_id(&operation_id)?;
        let expires = deadline(deadline_ms)?;
        let pending = Arc::new(Pending {
            operation: Operation::new(expires),
            started: AtomicBool::new(false),
        });
        let (response, receiver) = oneshot::channel();
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closing {
            return Err(error("CLOSED"));
        }
        if state.pending.contains_key(&operation_id) {
            return Err(error("DUPLICATE_OPERATION"));
        }
        if state.pending.len() >= MAX_PENDING {
            return Err(error("BUSY"));
        }
        state
            .pending
            .insert(operation_id.clone(), Arc::clone(&pending));
        if let Err(e) = self.sender.try_send(Message::Work {
            operation_id: operation_id.clone(),
            action,
            pending: Arc::clone(&pending),
            response,
        }) {
            state.pending.remove(&operation_id);
            return Err(match e {
                mpsc::TrySendError::Full(_) => error("BUSY"),
                mpsc::TrySendError::Disconnected(_) => error("credential_worker_stopped"),
            });
        }
        Ok(Ticket {
            operation_id,
            deadline: expires,
            pending,
            shared: Arc::clone(&self.shared),
            response: receiver,
        })
    }

    /// Cancellation only succeeds before an OS operation begins.
    pub fn cancel(&self, operation_id: &str) -> bool {
        let state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pending) = state.pending.get(operation_id) {
            if !pending.started.load(Ordering::Acquire) {
                pending.operation.cancel();
                return true;
            }
        }
        false
    }

    pub fn request_close(&self) {
        {
            let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closing = true;
            for pending in state.pending.values() {
                pending.operation.cancel();
            }
        }
        // Wake the worker out of its blocking recv. The channel keeps one slot
        // reserved for this sentinel, so the close is never lost; a disconnected
        // channel means the worker already finished and reported completion.
        let _ = self.sender.send(Message::Stop);
        self.shared.changed.notify_waiters();
    }

    pub fn shutdown(
        &self,
        deadline_ms: u32,
    ) -> Result<impl std::future::Future<Output = Value> + Send + 'static> {
        let expires = deadline(deadline_ms)?;
        self.request_close();
        let shared = Arc::clone(&self.shared);
        Ok(async move {
            loop {
                let notified = shared.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
                    if state.complete || Instant::now() >= expires {
                        let mut pending: Vec<_> = state.pending.keys().cloned().collect();
                        pending.sort();
                        return json!({"resourceId": shared.resource_id, "complete": state.complete, "pendingOperations": pending});
                    }
                }
                let _ = tokio::time::timeout_at(expires.into(), notified).await;
            }
        })
    }
}

impl Drop for CredentialService {
    fn drop(&mut self) {
        self.request_close();
    }
}

impl std::fmt::Debug for CredentialService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialService")
            .field("resource_id", &self.shared.resource_id)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ticket")
            .field("operation_id", &self.operation_id)
            .finish_non_exhaustive()
    }
}
