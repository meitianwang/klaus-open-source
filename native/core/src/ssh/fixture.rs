//! Deterministic protocol fixtures used by Rust and real Electron loading tests.
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Auth, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use serde_json::json;
use std::path::{Path, PathBuf};

fn real_shell() -> bool {
    std::env::var("KLAUS_SSH_FIXTURE_REAL_SHELL").map(|value| value == "1").unwrap_or(false)
}
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
pub struct Stats {
    pub accepted: AtomicUsize,
    pub authenticated: AtomicUsize,
    pub active: AtomicUsize,
    pub commands: Mutex<Vec<String>>,
}

pub struct Fixture {
    pub port: u16,
    pub public_key: PublicKey,
    pub client_key: PrivateKey,
    pub stats: Arc<Stats>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Fixture {
    pub async fn start(audit: Option<PathBuf>) -> Self {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let client_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let public_key = key.public_key().clone();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            channel_buffer_size: 8,
            event_buffer_size: 8,
            ..Default::default()
        });
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = socket.local_addr().unwrap().port();
        let stats = Arc::new(Stats::default());
        let handler = Handler {
            stats: Arc::clone(&stats),
            key: client_key.public_key().clone(),
            audit,
        };
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = sessions.join_next(), if !sessions.is_empty() => {},
                    accepted = socket.accept() => {
                        let Ok((tcp, _)) = accepted else { break };
                        if sessions.len() >= 32 { drop(tcp); continue; }
                        let handler = handler.clone();
                        handler.stats.accepted.fetch_add(1, Ordering::AcqRel);
                        let config = Arc::clone(&config);
                        sessions.spawn(async move {
                            struct Guard(Arc<Stats>);
                            impl Drop for Guard { fn drop(&mut self) { self.0.active.fetch_sub(1, Ordering::AcqRel); } }
                            handler.stats.active.fetch_add(1, Ordering::AcqRel);
                            let _guard = Guard(Arc::clone(&handler.stats));
                            if let Ok(session) = server::run_stream(config, tcp, handler).await { let _ = session.await; }
                        });
                    }
                }
            }
            sessions.abort_all();
            while sessions.join_next().await.is_some() {}
        });
        Self {
            port,
            public_key,
            client_key,
            stats,
            stop: Some(stop),
            task: Some(task),
        }
    }
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
    }
    pub fn write_info(&self, root: &Path) {
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(
            root.join("fixture-client-key"),
            self.client_key
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        std::fs::write(
            root.join("fixture.json"),
            json!({ "port": self.port, "publicKey": self.public_key.to_openssh().unwrap() })
                .to_string(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[derive(Clone)]
struct Handler {
    stats: Arc<Stats>,
    key: PublicKey,
    audit: Option<PathBuf>,
}
fn reject(user: &str) -> Auth {
    let methods = if user == "interactive" {
        vec![MethodKind::KeyboardInteractive]
    } else {
        vec![MethodKind::PublicKey, MethodKind::Password]
    };
    Auth::Reject {
        proceed_with_methods: Some(MethodSet::from(methods.as_slice())),
        partial_success: false,
    }
}
impl server::Handler for Handler {
    type Error = russh::Error;
    async fn auth_none(&mut self, user: &str) -> Result<Auth, Self::Error> {
        Ok(reject(user))
    }
    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "fixture-password" {
            Auth::Accept
        } else {
            reject(user)
        })
    }
    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(if key.key_data() == self.key.key_data() {
            Auth::Accept
        } else {
            reject(user)
        })
    }
    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        Ok(if key.key_data() == self.key.key_data() {
            Auth::Accept
        } else {
            reject(user)
        })
    }
    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        user: &str,
        _: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        if user != "interactive" {
            return Ok(reject(user));
        }
        if let Some(response) = response {
            let answers: Vec<_> = response.map(|answer| answer.to_vec()).collect();
            return Ok(
                if answers == [b"fixture-user".to_vec(), b"fixture-otp".to_vec()] {
                    Auth::Accept
                } else {
                    reject(user)
                },
            );
        }
        Ok(Auth::Partial {
            name: "Fixture verification".into(),
            instructions: "Synthetic challenge".into(),
            prompts: vec![("User:".into(), true), ("OTP:".into(), false)].into(),
        })
    }
    async fn auth_succeeded(&mut self, _: &mut Session) -> Result<(), Self::Error> {
        self.stats.authenticated.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(command).into_owned();
        {
            let mut commands = self.stats.commands.lock().unwrap();
            if commands.len() >= 128 {
                return Err(russh::Error::Disconnect);
            }
            commands.push(command.clone());
            if let Some(path) = &self.audit {
                std::fs::write(path, json!({ "commands": *commands }).to_string()).unwrap();
            }
        }
        if command == "fixture:reject" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        if command == "fixture:hang" {
            return Ok(());
        }
        // The command runs on its own task and replies through a cloned
        // session handle: awaiting it here would serialize every channel of
        // the multiplexed connection behind the slowest command.
        let handle = session.handle();
        tokio::spawn(async move {
            let (stdout, stderr, code) = run_command(&command).await;
            let _ = handle.data(channel, stdout).await;
            if !stderr.is_empty() {
                let _ = handle.extended_data(channel, 1, stderr).await;
            }
            if command != "fixture:no-status" {
                let _ = handle.exit_status_request(channel, code.max(0) as u32).await;
            }
            let _ = handle.eof(channel).await;
            let _ = handle.close(channel).await;
        });
        Ok(())
    }
}

async fn run_command(command: &str) -> (Vec<u8>, Vec<u8>, i32) {
    match command {
            "fixture:binary" => (vec![0, 255, 1, 195, 169], b"fixture stderr".to_vec(), 7),
            "fixture:overflow" => (vec![b'x'; 2 * 1024 * 1024 + 32768], Vec::new(), 0),
            "printf %s \"$HOME\"" => (b"/fixture home".to_vec(), Vec::new(), 0),
            command if command.starts_with("cd ") && !real_shell() => (
                b"/fixture home\0plain\0with\nnewline\0quote'\0.hidden\0".to_vec(),
                Vec::new(),
                0,
            ),
            // Opt-in real shell: the fixture becomes an actual remote machine so
            // host command protocols can be exercised end to end over SSH.
            _ if real_shell() => {
                let output = tokio::process::Command::new("sh")
                    .arg("-c")
                    .arg(command)
                    .output()
                    .await;
                match output {
                    Ok(output) => (
                        output.stdout,
                        output.stderr,
                        output.status.code().unwrap_or(0),
                    ),
                    Err(error) => (Vec::new(), error.to_string().into_bytes(), 127),
                }
            }
            _ => (command.as_bytes().to_vec(), Vec::new(), 0),
        }
}
