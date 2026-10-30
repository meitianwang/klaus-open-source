use super::service::Shared;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::Notify;
use wacore::runtime::{AbortHandle, Runtime};

#[derive(Default)]
struct State {
    closed: bool,
    next: u64,
    tasks: HashMap<u64, Option<tokio::task::AbortHandle>>,
}
struct Inner {
    state: Mutex<State>,
    changed: Notify,
    owner: Weak<Shared>,
}
#[derive(Clone)]
pub(super) struct ScopedRuntime(Arc<Inner>);
struct Guard(u64, Arc<Inner>);
impl Drop for Guard {
    fn drop(&mut self) {
        self.1
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .tasks
            .remove(&self.0);
        self.1.changed.notify_waiters();
    }
}
impl ScopedRuntime {
    pub fn new(owner: &Arc<Shared>) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(State::default()),
            changed: Notify::new(),
            owner: Arc::downgrade(owner),
        }))
    }
    fn admit(&self) -> Option<Guard> {
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            return None;
        }
        if state.tasks.len() >= 2048 || state.next == u64::MAX {
            drop(state);
            if let Some(owner) = self.0.owner.upgrade() {
                owner.fail("WHATSAPP_TASK_CAPACITY");
            }
            return None;
        }
        state.next += 1;
        let id = state.next;
        state.tasks.insert(id, None);
        Some(Guard(id, Arc::clone(&self.0)))
    }
    pub async fn close(&self) {
        {
            let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
            state.closed = true;
            for handle in state.tasks.values().flatten() {
                handle.abort();
            }
        }
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .0
                .state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .tasks
                .is_empty()
            {
                return;
            }
            changed.await;
        }
    }
}
#[async_trait::async_trait]
impl Runtime for ScopedRuntime {
    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) -> AbortHandle {
        let Some(guard) = self.admit() else {
            return AbortHandle::noop();
        };
        let id = guard.0;
        let task = tokio::spawn(async move {
            let _guard = guard;
            future.await;
        });
        let abort = task.abort_handle();
        let mut state = self.0.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            abort.abort();
        }
        if let Some(slot) = state.tasks.get_mut(&id) {
            *slot = Some(abort.clone());
        }
        AbortHandle::new(move || abort.abort())
    }
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(duration))
    }
    fn spawn_blocking(
        &self,
        operation: Box<dyn FnOnce() + Send + 'static>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let guard = self.admit();
        Box::pin(async move {
            if let Some(guard) = guard {
                let _ = tokio::task::spawn_blocking(move || {
                    let _guard = guard;
                    operation();
                })
                .await;
            }
        })
    }
    fn yield_now(&self) -> Option<Pin<Box<dyn Future<Output = ()> + Send>>> {
        Some(Box::pin(tokio::task::yield_now()))
    }
    fn yield_frequency(&self) -> u32 {
        1
    }
}
