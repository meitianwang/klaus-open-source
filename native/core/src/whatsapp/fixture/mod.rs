//! Isolated, synthetic protocol server. Never linked into the production addon.
mod crypto;
mod signal;
mod wire;
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use wacore_binary::{builder::NodeBuilder, Node};

#[derive(Default)]
struct Shared {
    network_active: u32,
    network_closed: u32,
    next: u32,
    active: HashMap<u32, mpsc::Sender<Node>>,
    connections: u32,
    hellos: u32,
    reopened: u32,
    pair_replies: u32,
    sw_requests: u32,
    mode: String,
    tags: Vec<String>,
    closed: u32,
    errors: Vec<String>,
    received: Vec<String>,
    peers: HashMap<[u8; 32], Arc<tokio::sync::Mutex<signal::Peer>>>,
}
fn output(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}
fn attr(node: &Node, key: &str) -> String {
    node.attrs
        .get(key)
        .map(ToString::to_string)
        .unwrap_or_default()
}
fn offline() -> Node {
    NodeBuilder::new("ib")
        .children([NodeBuilder::new("offline").attr("count", "0").build()])
        .build()
}
fn success() -> Node {
    NodeBuilder::new("success")
        .attrs([("t", "1700000000"), ("lid", "900001:1@lid")])
        .build()
}
pub async fn run() -> Result<()> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let base = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let shared = Arc::new(Mutex::new(Shared::default()));
    let (commands, mut receiver) = mpsc::channel::<Value>(16);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.len() > 8192 {
                break;
            }
            let Ok(value) = serde_json::from_str(&line) else {
                break;
            };
            if commands.blocking_send(value).is_err() {
                break;
            }
        }
    });
    output(json!({"ready":true,"base":base}));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted=listener.accept()=>{
                let (socket,_)=accepted?;let state=Arc::clone(&shared);
                tasks.spawn(async move {if let Err(error)=connection(socket,Arc::clone(&state)).await {let mut state=state.lock().unwrap();if state.errors.len()<16 {state.errors.push(error.to_string().chars().take(256).collect());}}});
            },
            command=receiver.recv()=>{
                let Some(command)=command else{break};let id=command["id"].clone();
                let action=command["action"].as_str().unwrap_or("");
                if action=="stop"{output(json!({"id":id,"ok":true}));break;}
                let result=match action {
                    "mode"=>{shared.lock().unwrap().mode=command["mode"].as_str().unwrap_or("").to_owned();Ok(json!(true))},
                    "stats"=>{let state=shared.lock().unwrap();Ok(json!({"networkActive":state.network_active,"networkClosed":state.network_closed,"connections":state.connections,"active":state.active.len(),"hellos":state.hellos,"reopened":state.reopened,"pairReplies":state.pair_replies,"swRequests":state.sw_requests,"closed":state.closed,"tags":state.tags,"errors":state.errors,"received":state.received}))},
                    "pair"=>{
                        let node=crypto::pair(command["qr"].as_str().unwrap_or(""),command["wrongHmac"]==true);
                        broadcast(&shared,node).await
                    },
                    "logout"=>broadcast(&shared,Ok(NodeBuilder::new("failure").attrs([("reason","401")]).build())).await,
                    "disconnect"=>broadcast(&shared,Ok(NodeBuilder::new("stream:error").attr("code","515").build())).await,
                    _=>Err(anyhow!("unknown fixture command")),
                };
                match result {Ok(result)=>output(json!({"id":id,"ok":true,"result":result})),Err(_)=>output(json!({"id":id,"ok":false}))}
            },
            _=tasks.join_next(),if !tasks.is_empty()=>{},
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
async fn broadcast(shared: &Arc<Mutex<Shared>>, node: Result<Node>) -> Result<Value> {
    let node = node?;
    let senders: Vec<_> = shared.lock().unwrap().active.values().cloned().collect();
    if senders.is_empty() {
        return Err(anyhow!("no active fixture socket"));
    }
    for sender in senders {
        sender.try_send(node.clone())?;
    }
    Ok(json!(true))
}
async fn connection(mut socket: tokio::net::TcpStream, shared: Arc<Mutex<Shared>>) -> Result<()> {
    shared.lock().unwrap().network_active += 1;
    struct NetworkGuard(Arc<Mutex<Shared>>);
    impl Drop for NetworkGuard {
        fn drop(&mut self) {
            let mut state = self.0.lock().unwrap();
            state.network_active -= 1;
            state.network_closed += 1;
        }
    }
    let _network = NetworkGuard(Arc::clone(&shared));
    let mut peek = [0; 1024];
    let count = socket.peek(&mut peek).await?;
    if !peek[..count].starts_with(b"GET /ws/chat ") {
        let mut request = Vec::new();
        let mut byte = [0; 1];
        while request.len() < 16384 && !request.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await?;
            request.push(byte[0]);
        }
        let mode = {
            let mut state = shared.lock().unwrap();
            state.sw_requests += 1;
            state.mode.clone()
        };
        if mode == "httpHold" {
            while socket.read(&mut byte).await? != 0 {}
            return Ok(());
        }
        let (status, body) = if mode == "httpFail" {
            ("503 Service Unavailable", "unavailable")
        } else {
            (
                "200 OK",
                r#"self.__swData=JSON.parse(/*BTDS*/"{\"dynamic_data\":{\"SiteData\":{\"server_revision\":1026131876,\"client_revision\":1026131876}}}");"#,
            )
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await?;
        return Ok(());
    }
    let mode = {
        let mut state = shared.lock().unwrap();
        state.connections += 1;
        state.mode.clone()
    };
    let (_, mut socket) = tokio_websockets::ServerBuilder::new()
        .limits(tokio_websockets::Limits::default().max_payload_len(Some(16 * 1024 * 1024)))
        .accept(socket)
        .await?;
    if mode == "hold" {
        while socket.next().await.is_some() {
            shared.lock().unwrap().hellos += 1;
        }
        return Ok(());
    }
    let (mut wire, payload) = wire::Wire::handshake(socket, mode == "forged").await?;
    let peer = {
        let mut state = shared.lock().unwrap();
        if let Some(peer) = state.peers.get(&wire.profile_key) {
            Arc::clone(peer)
        } else {
            let peer = Arc::new(tokio::sync::Mutex::new(signal::Peer::new()?));
            state.peers.insert(wire.profile_key, Arc::clone(&peer));
            peer
        }
    };
    let (sender, mut incoming) = mpsc::channel(16);
    let id = {
        let mut state = shared.lock().unwrap();
        state.next += 1;
        state.hellos += 1;
        let id = state.next;
        state.active.insert(id, sender);
        if payload.username.is_some() {
            state.reopened += 1;
        }
        id
    };
    struct Guard(u32, Arc<Mutex<Shared>>);
    impl Drop for Guard {
        fn drop(&mut self) {
            let mut state = self.1.lock().unwrap();
            state.active.remove(&self.0);
            state.closed += 1;
        }
    }
    let _guard = Guard(id, Arc::clone(&shared));
    if payload.username.is_some() {
        wire.send(success()).await?;
    } else {
        wire.send(
            NodeBuilder::new("iq")
                .attrs([
                    ("from", "s.whatsapp.net"),
                    ("type", "set"),
                    ("id", "fixture-qr"),
                ])
                .children([NodeBuilder::new("pair-device")
                    .children([NodeBuilder::new("ref")
                        .bytes(b"klaus-loopback-qr-ref")
                        .build()])
                    .build()])
                .build(),
        )
        .await?;
    }
    loop {
        tokio::select! {
            node=incoming.recv()=>{let Some(node)=node else{break};wire.send(node).await?;},
            message=wire.socket.next()=>{
                let Some(Ok(message))=message else{break};
                if message.is_close(){break;}let Some(node)=wire.decode(message)?else{continue};
                {let mut state=shared.lock().unwrap();if state.tags.len()<256{state.tags.push(format!("{}:{}:{}",node.tag,attr(&node,"xmlns"),attr(&node,"type")));}}
                let tag=node.tag.as_ref();let kind=attr(&node,"type");
                if node.get_optional_child_by_tag(&["pair-device-sign"]).is_some(){
                    shared.lock().unwrap().pair_replies+=1;
                    wire.send(NodeBuilder::new("stream:error").attr("code","515").build()).await?;
                }else if tag=="message" {
                    let (text,reply)=peer.lock().await.reply(&node).await?;
                    {let mut state=shared.lock().unwrap();if state.received.len()<16{state.received.push(text);}}
                    wire.send(NodeBuilder::new("ack").attr("id",attr(&node,"id")).attrs([("from",signal::PEER),("class","message")]).build()).await?;
                    wire.send(reply).await?;
                }else if tag=="iq" && (kind=="get"||kind=="set"){
                    let ns=attr(&node,"xmlns");
                    let mut children=Vec::new();
                    if ns=="usync" {
                        let mut users=Vec::new();
                        if let Some(list)=node.get_optional_child_by_tag(&["usync","list"]){
                            for user in list.get_children_by_tag("user") {
                                let jid=attr(user,"jid");
                                let devices=if jid.starts_with("15555550202"){vec![NodeBuilder::new("device").attr("id","0").build()]}else{Vec::new()};
                                users.push(NodeBuilder::new("user").attr("jid",jid).children([NodeBuilder::new("devices").children([NodeBuilder::new("device-list").children(devices).build()]).build()]).build());
                            }
                        }
                        children.push(NodeBuilder::new("usync").children([NodeBuilder::new("list").children(users).build()]).build());
                    }
                    let peer_keys=ns=="encrypt" && node.get_optional_child_by_tag(&["key"]).is_some_and(|key|key.get_children_by_tag("user").any(|user|attr(user,"jid").starts_with("15555550202")));
                    if peer_keys && shared.lock().unwrap().mode=="keyHold" {continue;}
                    if peer_keys {children.push(peer.lock().await.bundle_node()?);}

                    if ns=="encrypt" && node.get_optional_child_by_tag(&["count"]).is_some(){children.push(NodeBuilder::new("count").attr("value","100").build());}
                    if ns=="w:sync:app:state" {children.push(NodeBuilder::new("sync").build());}
                    if ns=="encrypt" && node.get_optional_child_by_tag(&["key"]).is_some() && !peer_keys {
                        // A deterministic remote failure lets startup continue without inventing Signal sessions.
                        wire.send(NodeBuilder::new("iq").attr("id",attr(&node,"id")).attrs([("from","s.whatsapp.net"),("type","error")]).children([NodeBuilder::new("error").attr("code","404").build()]).build()).await?;
                    } else {
                        wire.send(NodeBuilder::new("iq").attr("id",attr(&node,"id")).attrs([("from","s.whatsapp.net"),("type","result")]).children(children).build()).await?;
                    }
                    if ns=="passive" {wire.send(offline()).await?;}
                }
            }
        }
    }
    Ok(())
}
