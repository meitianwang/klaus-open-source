use super::service::{error, Shared};
use crate::Result;
use serde_json::{json, Value};
use std::sync::Weak;
use wacore::types::events::{Event, EventHandler};

pub(super) struct Handler(pub Weak<Shared>);
impl EventHandler for Handler {
    fn handle_event(&self, event: &Event) {
        let Some(shared) = self.0.upgrade() else {
            return;
        };
        match project(event) {
            Ok(Some(value)) => shared.publish(value),
            Ok(None) => {}
            Err(error) => shared.fail(error.code),
        }
    }
}
fn text(value: &str, limit: usize) -> Result<&str> {
    if value.len() > limit || value.contains('\0') {
        return Err(error("WHATSAPP_EVENT_SIZE_LIMIT"));
    }
    Ok(value)
}
fn optional(value: &Option<String>, limit: usize) -> Result<Option<&str>> {
    value.as_deref().map(|v| text(v, limit)).transpose()
}
pub(super) fn project(event: &Event) -> Result<Option<Value>> {
    let value = match event {
        Event::PairingQrCode { code, timeout } => {
            json!({"kind":"qr", "code":text(code,4096)?, "expiresInMs":timeout.as_millis().min(120_000) as u64})
        }
        Event::Connected(_) => json!({"kind":"connected"}),
        Event::Disconnected(_) => json!({"kind":"disconnected"}),
        Event::LoggedOut(value) => json!({"kind":"loggedOut", "reason":value.reason.code()}),
        Event::ConnectFailure(value) => {
            json!({"kind":"connectFailure", "reason":value.reason.code()})
        }
        Event::PairError(_) => json!({"kind":"pairError"}),
        Event::StreamReplaced(_) => json!({"kind":"streamReplaced"}),
        Event::ClientOutdated(_) => json!({"kind":"clientOutdated"}),
        Event::TemporaryBan(_) => json!({"kind":"temporaryBan"}),
        Event::Message(message, info) => {
            let chat = info.source.chat.to_string();
            let sender = info.source.sender.to_string();
            json!({"kind":"message", "info":{
                "id":text(&info.id,1024)?, "chatJid":text(&chat,512)?,
                "senderJid":text(&sender,512)?, "isFromMe":info.source.is_from_me,
                "pushName":text(&info.push_name,1024)?, "timestampMs":info.timestamp.timestamp_millis()
            }, "message":{
                "conversation":optional(&message.conversation,65_536)?,
                "extendedText":message.extended_text_message.as_ref().map(|v|optional(&v.text,65_536)).transpose()?.flatten(),
                "imageCaption":message.image_message.as_ref().map(|v|optional(&v.caption,65_536)).transpose()?.flatten(),
                "videoCaption":message.video_message.as_ref().map(|v|optional(&v.caption,65_536)).transpose()?.flatten(),
                "image":message.image_message.is_some(), "video":message.video_message.is_some(),
                "audio":message.audio_message.is_some(),
                "document":message.document_message.as_ref().map(|v|optional(&v.file_name,4096).map(|name|json!({"fileName":name}))).transpose()?,
                "sticker":message.sticker_message.is_some(), "contact":message.contact_message.is_some(),
                "location":message.location_message.is_some()
            }})
        }
        _ => return Ok(None),
    };
    Ok(Some(value))
}
