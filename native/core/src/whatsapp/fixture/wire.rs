use super::crypto;
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio_websockets::{Message, WebSocketStream};
use wacore::handshake::{NoiseCipher, NoiseHandshake};
use wacore_binary::{
    consts::{NOISE_START_PATTERN, WA_CONN_HEADER},
    Node,
};
use waproto::whatsapp as wa;

pub type Socket = WebSocketStream<tokio::net::TcpStream>;
pub struct Wire {
    pub socket: Socket,
    pub profile_key: [u8; 32],
    read: NoiseCipher,
    write: NoiseCipher,
    read_counter: u32,
    write_counter: u32,
}
fn unframe(data: &[u8], header: bool) -> Result<&[u8]> {
    let start = if header {
        if !data.starts_with(&WA_CONN_HEADER) {
            return Err(anyhow!("invalid WA header"));
        }
        4
    } else {
        0
    };
    if data.len() < start + 3 {
        return Err(anyhow!("short frame"));
    }
    let size = ((data[start] as usize) << 16)
        | ((data[start + 1] as usize) << 8)
        | data[start + 2] as usize;
    if size != data.len() - start - 3 {
        return Err(anyhow!("invalid frame length"));
    }
    Ok(&data[start + 3..])
}
async fn binary(socket: &mut Socket) -> Result<Vec<u8>> {
    loop {
        match socket.next().await {
            Some(Ok(message)) if message.is_binary() => return Ok(message.into_payload().to_vec()),
            Some(Ok(message)) if !message.is_close() => {}
            _ => return Err(anyhow!("socket closed")),
        }
    }
}
impl Wire {
    pub async fn handshake(mut socket: Socket, forged: bool) -> Result<(Self, wa::ClientPayload)> {
        let initial = binary(&mut socket).await?;
        let hello = wa::HandshakeMessage::decode(unframe(&initial, true)?)?
            .client_hello
            .ok_or_else(|| anyhow!("missing hello"))?;
        let client: [u8; 32] = hello
            .ephemeral
            .ok_or_else(|| anyhow!("missing ephemeral"))?
            .try_into()
            .map_err(|_| anyhow!("invalid ephemeral"))?;
        let ephemeral = crypto::key(0x35);
        let static_key = crypto::key(0x37);
        let mut noise = NoiseHandshake::new(NOISE_START_PATTERN, &WA_CONN_HEADER)?;
        noise.authenticate(&client);
        noise.authenticate(ephemeral.public_key()?.public_key_bytes());
        noise.mix_shared_secret(ephemeral.serialize(), &client)?;
        let encrypted_static = noise.encrypt(static_key.public_key()?.public_key_bytes())?;
        noise.mix_shared_secret(static_key.serialize(), &client)?;
        let payload = noise.encrypt(&crypto::certificate(
            static_key.public_key()?.public_key_bytes(),
            forged,
        ))?;
        let response = wa::HandshakeMessage {
            server_hello: Some(wa::handshake_message::ServerHello {
                ephemeral: Some(ephemeral.public_key()?.public_key_bytes().to_vec()),
                r#static: Some(encrypted_static),
                payload: Some(payload),
                ..Default::default()
            }),
            ..Default::default()
        }
        .encode_to_vec();
        socket
            .send(Message::binary(wacore::framing::encode_frame(
                &response, None,
            )?))
            .await?;
        let finish = binary(&mut socket).await?;
        let finish = wa::HandshakeMessage::decode(unframe(&finish, false)?)?
            .client_finish
            .ok_or_else(|| anyhow!("missing finish"))?;
        let client_static: [u8; 32] = noise
            .decrypt(&finish.r#static.ok_or_else(|| anyhow!("missing static"))?)?
            .try_into()
            .map_err(|_| anyhow!("invalid static"))?;
        noise.mix_shared_secret(ephemeral.serialize(), &client_static)?;
        let payload = wa::ClientPayload::decode(
            noise
                .decrypt(&finish.payload.ok_or_else(|| anyhow!("missing payload"))?)?
                .as_slice(),
        )?;
        let (read, write) = noise.finish()?;
        Ok((
            Self {
                socket,
                profile_key: client_static,
                read,
                write,
                read_counter: 0,
                write_counter: 0,
            },
            payload,
        ))
    }
    pub fn decode(&mut self, message: Message) -> Result<Option<Node>> {
        if !message.is_binary() {
            return Ok(None);
        }
        let data = message.into_payload();
        let framed = unframe(&data, false)?;
        let plain = self.read.decrypt_with_counter(self.read_counter, framed)?;
        self.read_counter += 1;
        let unpacked = wacore_binary::util::unpack(&plain)?;
        Ok(Some(
            wacore_binary::marshal::unmarshal_ref(unpacked.as_ref())?.to_owned(),
        ))
    }
    pub async fn send(&mut self, node: Node) -> Result<()> {
        let encoded = wacore_binary::marshal(&node)?;
        let ciphertext = self
            .write
            .encrypt_with_counter(self.write_counter, &encoded)?;
        self.write_counter += 1;
        self.socket
            .send(Message::binary(wacore::framing::encode_frame(
                &ciphertext,
                None,
            )?))
            .await?;
        Ok(())
    }
}
