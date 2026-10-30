use super::config::{read_limited, Endpoint};
use super::known_hosts;
use super::service::{error, Pending, Shared};
use crate::{NativeError, Result};
use base64::Engine as _;
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse as Interactive};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, MethodKind, MethodSet};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

const MAX_KEY_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

impl From<russh::Error> for NativeError {
    fn from(_: russh::Error) -> Self {
        error("SSH_TRANSPORT_FAILED")
    }
}

pub(super) struct Client {
    shared: Arc<Shared>,
    endpoint: Endpoint,
}
impl client::Handler for Client {
    type Error = NativeError;
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool> {
        self.shared.check_open()?;
        known_hosts::check(&self.endpoint, key)?;
        self.shared.check_open()?;
        Ok(true)
    }
}
pub(super) type Connection = client::Handle<Client>;

fn accepted(result: AuthResult, methods: &mut MethodSet) -> bool {
    match result {
        AuthResult::Success => true,
        AuthResult::Failure {
            remaining_methods, ..
        } => {
            *methods = remaining_methods;
            false
        }
    }
}

fn configured_public_keys(endpoint: &Endpoint) -> Result<Vec<PublicKey>> {
    let mut keys = Vec::new();
    for path in &endpoint.identity_files {
        let mut public_path = path.as_os_str().to_owned();
        public_path.push(".pub");
        if let Some(bytes) = read_limited(std::path::Path::new(&public_path), MAX_KEY_BYTES)? {
            if let Ok(key) = PublicKey::from_openssh(
                std::str::from_utf8(&bytes).map_err(|_| error("SSH_KEY_INVALID"))?,
            ) {
                keys.push(key);
            }
        } else if let Some(bytes) = read_limited(path, MAX_KEY_BYTES)? {
            let bytes = Zeroizing::new(bytes);
            // OpenSSH's outer key record carries its public key even when its private body is encrypted.
            if let Ok(key) = PrivateKey::from_openssh(&*bytes) {
                keys.push(key.public_key().clone());
            }
        }
    }
    Ok(keys)
}

async fn agent_identities<S: AgentStream + Unpin + Send + 'static>(
    connection: &mut Connection,
    endpoint: &Endpoint,
    mut agent: AgentClient<S>,
    methods: &mut MethodSet,
) -> Result<bool> {
    // russh limits each agent frame to 256 KiB; cap the number of authentication attempts as well.
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| error("SSH_AGENT_FAILED"))?;
    if identities.len() > 32 {
        return Err(error("SSH_AGENT_IDENTITY_LIMIT"));
    }
    let allowed = if endpoint.identities_only {
        configured_public_keys(endpoint)?
    } else {
        Vec::new()
    };
    let hash = connection
        .best_supported_rsa_hash()
        .await
        .map_err(NativeError::from)?
        .flatten();
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        if endpoint.identities_only && !allowed.iter().any(|k| k.key_data() == key.key_data()) {
            continue;
        }
        let result = connection
            .authenticate_publickey_with(&endpoint.user, key, hash, &mut agent)
            .await
            .map_err(|_| error("SSH_AGENT_FAILED"))?;
        if accepted(result, methods) {
            return Ok(true);
        }
        if !methods.contains(&MethodKind::PublicKey) {
            break;
        }
    }
    Ok(false)
}

async fn authenticate_agent(
    connection: &mut Connection,
    endpoint: &Endpoint,
    methods: &mut MethodSet,
) -> Result<bool> {
    let Some(path) = &endpoint.agent else {
        return Ok(false);
    };
    #[cfg(unix)]
    let agent = AgentClient::connect_uds(path);
    #[cfg(windows)]
    let agent = AgentClient::connect_named_pipe(path);
    let agent = match tokio::time::timeout(Duration::from_secs(2), agent).await {
        Ok(Ok(agent)) => agent,
        Ok(Err(_)) => return Ok(false),
        Err(_) => return Err(error("SSH_AGENT_TIMEOUT")),
    };
    tokio::time::timeout(
        Duration::from_secs(10),
        agent_identities(connection, endpoint, agent, methods),
    )
    .await
    .map_err(|_| error("SSH_AGENT_TIMEOUT"))?
}

async fn authenticate_keys(
    connection: &mut Connection,
    endpoint: &Endpoint,
    shared: &Shared,
    operation_id: &str,
    prompts: &mut usize,
    methods: &mut MethodSet,
) -> Result<bool> {
    let hash = connection
        .best_supported_rsa_hash()
        .await
        .map_err(NativeError::from)?
        .flatten();
    for path in &endpoint.identity_files {
        let Some(bytes) = read_limited(path, MAX_KEY_BYTES)? else {
            continue;
        };
        let bytes = Zeroizing::new(bytes);
        let source = std::str::from_utf8(&bytes).map_err(|_| error("SSH_KEY_INVALID"))?;
        let key = match russh::keys::decode_secret_key(source, None) {
            Ok(key) => key,
            Err(russh::keys::Error::KeyIsEncrypted) if !endpoint.batch_mode => {
                let answer = shared
                    .prompt(
                        operation_id,
                        *prompts,
                        format!("Passphrase for SSH key '{}':", path.display()),
                        false,
                    )
                    .await?;
                *prompts += 1;
                match russh::keys::decode_secret_key(source, Some(&answer)) {
                    Ok(key) => key,
                    Err(_) => continue,
                }
            }
            Err(_) => continue,
        };
        let result = connection
            .authenticate_publickey(
                &endpoint.user,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(NativeError::from)?;
        if accepted(result, methods) {
            return Ok(true);
        }
        if !methods.contains(&MethodKind::PublicKey) {
            break;
        }
    }
    Ok(false)
}

async fn authenticate(
    connection: &mut Connection,
    endpoint: &Endpoint,
    shared: &Shared,
    operation_id: &str,
) -> Result<()> {
    let mut methods = MethodSet::client_supported();
    if accepted(
        connection
            .authenticate_none(&endpoint.user)
            .await
            .map_err(NativeError::from)?,
        &mut methods,
    ) {
        return Ok(());
    }
    let mut prompts = 0;
    if methods.contains(&MethodKind::PublicKey)
        && authenticate_agent(connection, endpoint, &mut methods).await?
    {
        return Ok(());
    }
    if methods.contains(&MethodKind::PublicKey)
        && authenticate_keys(
            connection,
            endpoint,
            shared,
            operation_id,
            &mut prompts,
            &mut methods,
        )
        .await?
    {
        return Ok(());
    }
    if endpoint.batch_mode {
        return Err(error("SSH_AUTHENTICATION_REQUIRED"));
    }
    if methods.contains(&MethodKind::KeyboardInteractive) {
        let mut response = connection
            .authenticate_keyboard_interactive_start(&endpoint.user, None)
            .await
            .map_err(NativeError::from)?;
        let mut rounds = 0;
        loop {
            match response {
                Interactive::Success => return Ok(()),
                Interactive::Failure {
                    remaining_methods, ..
                } => {
                    methods = remaining_methods;
                    break;
                }
                Interactive::InfoRequest {
                    name,
                    instructions,
                    prompts: questions,
                } => {
                    rounds += 1;
                    if rounds > 16
                        || questions.len() > 16
                        || name.len() > 4096
                        || instructions.len() > 4096
                    {
                        return Err(error("SSH_AUTH_PROMPT_LIMIT"));
                    }
                    let mut answers = Vec::with_capacity(questions.len());
                    for question in questions {
                        let prompt = if instructions.is_empty() {
                            question.prompt
                        } else {
                            format!("{instructions}\n{}", question.prompt)
                        };
                        let answer = shared
                            .prompt(operation_id, prompts, prompt, question.echo)
                            .await?;
                        prompts += 1;
                        answers.push(answer.to_string());
                    }
                    response = connection
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(NativeError::from)?;
                }
            }
        }
    }
    if methods.contains(&MethodKind::Password) {
        let answer = shared
            .prompt(
                operation_id,
                prompts,
                format!("Password for {}@{}:", endpoint.user, endpoint.host),
                false,
            )
            .await?;
        if accepted(
            connection
                .authenticate_password(&endpoint.user, answer.as_str())
                .await
                .map_err(NativeError::from)?,
            &mut methods,
        ) {
            return Ok(());
        }
    }
    Err(error("SSH_AUTHENTICATION_FAILED"))
}

pub(super) async fn connect(
    shared: &Arc<Shared>,
    pending: &Pending,
    operation_id: &str,
    endpoint: &Endpoint,
) -> Result<Connection> {
    let config = client::Config {
        preferred: known_hosts::preferred(endpoint)?,
        window_size: 256 * 1024,
        maximum_packet_size: 32768,
        channel_buffer_size: 8,
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    };
    let tcp = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    .map_err(|_| error("SSH_CONNECT_TIMEOUT"))?
    .map_err(|_| error("SSH_CONNECT_FAILED"))?;
    pending.check()?;
    let tcp = tcp.into_std().map_err(|_| error("SSH_CONNECT_FAILED"))?;
    shared.install_socket(tcp.try_clone().map_err(|_| error("SSH_CONNECT_FAILED"))?)?;
    let tcp = tokio::net::TcpStream::from_std(tcp).map_err(|_| error("SSH_CONNECT_FAILED"))?;
    let mut connection = client::connect_stream(
        Arc::new(config),
        tcp,
        Client {
            shared: Arc::clone(shared),
            endpoint: endpoint.clone(),
        },
    )
    .await?;
    authenticate(&mut connection, endpoint, shared, operation_id).await?;
    pending.check()?;
    Ok(connection)
}

/// Open one session channel. The caller holds the connection lock only for
/// this; the command itself then runs without it, so several commands share
/// the multiplexed connection concurrently.
pub(super) async fn open_session(connection: &Connection) -> Result<russh::Channel<russh::client::Msg>> {
    connection.channel_open_session().await.map_err(NativeError::from)
}

pub(super) async fn execute_opened(
    mut channel: russh::Channel<russh::client::Msg>,
    pending: &Pending,
    command: &str,
) -> Result<Value> {
    pending.check()?;
    // After enqueueing this request, cancellation cannot prove the remote command did not start.
    pending.remote_started.store(true, Ordering::Release);
    channel
        .exec(true, command)
        .await
        .map_err(NativeError::from)?;
    channel.eof().await.map_err(NativeError::from)?;
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let (mut exit_code, mut signal) = (None, None);
    let mut closed = false;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                if stdout.len() + stderr.len() + data.len() > MAX_OUTPUT_BYTES {
                    return Err(NativeError::new("SSH_OUTPUT_LIMIT", "remote output exceeds 2 MiB; connection closed; command outcome may be unknown"));
                }
                stdout.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, .. } => {
                if stdout.len() + stderr.len() + data.len() > MAX_OUTPUT_BYTES {
                    return Err(NativeError::new("SSH_OUTPUT_LIMIT", "remote output exceeds 2 MiB; connection closed; command outcome may be unknown"));
                }
                stderr.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            ChannelMsg::ExitSignal { signal_name, .. } => signal = Some(format!("{signal_name:?}")),
            ChannelMsg::Failure => return Err(error("SSH_EXEC_REJECTED")),
            ChannelMsg::Close => {
                closed = true;
                break;
            }
            _ => {}
        }
    }
    if !closed || exit_code.is_none() && signal.is_none() {
        return Err(NativeError::new(
            "SSH_OPERATION_OUTCOME_UNKNOWN",
            "SSH channel closed without a complete exit status",
        ));
    }
    let base64 = base64::engine::general_purpose::STANDARD;
    Ok(
        json!({ "stdoutBase64": base64.encode(&stdout), "stderrBase64": base64.encode(&stderr),
        "exitCode": exit_code, "signal": signal, "outputComplete": true }),
    )
}
