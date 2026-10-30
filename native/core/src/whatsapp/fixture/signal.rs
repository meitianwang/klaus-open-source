//! Synthetic peer that performs real Signal decryption and encryption over the fixture wire.
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use wacore::iq::prekeys::PreKeyBundleUserNode;
use wacore::libsignal::protocol::*;
use wacore::protocol::ProtocolNode;
use wacore::types::jid::JidExt;
use wacore_binary::{builder::NodeBuilder, jid::Jid, node::NodeContent, Node};

pub const PEER: &str = "15555550202@s.whatsapp.net";
pub struct Peer {
    sessions: Sessions,
    identity: Identity,
    prekeys: Prekeys,
    signed: Signed,
    bundle: PreKeyBundle,
}
#[derive(Default)]
struct Sessions(HashMap<ProtocolAddress, Vec<u8>>);
struct Identity {
    own: IdentityKeyPair,
    known: HashMap<ProtocolAddress, IdentityKey>,
}
struct Prekeys(HashMap<PreKeyId, PreKeyRecord>);
struct Signed(SignedPreKeyRecord);
type SignalResult<T> = std::result::Result<T, SignalProtocolError>;
#[async_trait::async_trait]
impl SessionStore for Sessions {
    async fn load_session(&self, address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        self.0
            .get(address)
            .map(|bytes| SessionRecord::deserialize(bytes))
            .transpose()
    }
    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: SessionRecord,
    ) -> SignalResult<()> {
        self.0.insert(address.clone(), record.serialize()?);
        Ok(())
    }
}
#[async_trait::async_trait]
impl IdentityKeyStore for Identity {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        Ok(self.own.clone())
    }
    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        Ok(73)
    }
    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let old = self.known.insert(address.clone(), *identity);
        Ok(IdentityChange::from_changed(
            old.is_some_and(|value| value != *identity),
        ))
    }
    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        _: Direction,
    ) -> SignalResult<bool> {
        Ok(self
            .known
            .get(address)
            .is_none_or(|value| value == identity))
    }
    async fn get_identity(&self, address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        Ok(self.known.get(address).copied())
    }
}
#[async_trait::async_trait]
impl PreKeyStore for Prekeys {
    async fn get_pre_key(&self, id: PreKeyId) -> SignalResult<PreKeyRecord> {
        self.0
            .get(&id)
            .cloned()
            .ok_or(SignalProtocolError::InvalidPreKeyId)
    }
    async fn save_pre_key(&mut self, id: PreKeyId, record: &PreKeyRecord) -> SignalResult<()> {
        self.0.insert(id, record.clone());
        Ok(())
    }
    async fn remove_pre_key(&mut self, id: PreKeyId) -> SignalResult<()> {
        self.0.remove(&id);
        Ok(())
    }
}
#[async_trait::async_trait]
impl SignedPreKeyStore for Signed {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> SignalResult<SignedPreKeyRecord> {
        if id == self.0.id()? {
            Ok(self.0.clone())
        } else {
            Err(SignalProtocolError::InvalidSignedPreKeyId)
        }
    }
    async fn save_signed_pre_key(
        &mut self,
        _: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.0 = record.clone();
        Ok(())
    }
}
impl Peer {
    pub fn new() -> Result<Self> {
        let own = IdentityKeyPair::generate(&mut rand::rng());
        let signed = KeyPair::generate(&mut rand::rng());
        let one = KeyPair::generate(&mut rand::rng());
        let signature = own
            .private_key()
            .calculate_signature(&signed.public_key.serialize(), &mut rand::rng())?;
        let bundle = PreKeyBundle::new(
            73,
            0u32.into(),
            Some((11u32.into(), one.public_key)),
            9u32.into(),
            signed.public_key,
            signature.to_vec(),
            *own.identity_key(),
        )?;
        Ok(Self {
            sessions: Sessions::default(),
            identity: Identity {
                own,
                known: HashMap::new(),
            },
            prekeys: Prekeys(HashMap::from([(
                11u32.into(),
                PreKeyRecord::new(11u32.into(), &one),
            )])),
            signed: Signed(SignedPreKeyRecord::new(
                9u32.into(),
                Timestamp::from_epoch_millis(1_700_000_000_000),
                &signed,
                &signature,
            )),
            bundle,
        })
    }
    pub fn bundle_node(&self) -> Result<Node> {
        Ok(NodeBuilder::new("list")
            .children([
                PreKeyBundleUserNode::from_bundle(PEER.parse()?, &self.bundle, None)?.into_node(),
            ])
            .build())
    }
    pub async fn reply(&mut self, node: &Node) -> Result<(String, Node)> {
        let participants = node
            .get_optional_child_by_tag(&["participants"])
            .ok_or_else(|| anyhow!("missing encrypted participants"))?;
        let recipient = participants
            .get_children_by_tag("to")
            .find(|child| {
                child
                    .attrs
                    .get("jid")
                    .is_some_and(|jid| jid.to_string().starts_with("15555550202"))
            })
            .ok_or_else(|| anyhow!("missing fixture recipient"))?;
        let encrypted = recipient
            .get_optional_child_by_tag(&["enc"])
            .ok_or_else(|| anyhow!("missing encrypted content"))?;
        let Some(NodeContent::Bytes(bytes)) = &encrypted.content else {
            return Err(anyhow!("invalid ciphertext body"));
        };
        let kind = encrypted
            .attrs
            .get("type")
            .map(ToString::to_string)
            .unwrap_or_default();
        let message = match kind.as_str() {
            "pkmsg" => CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(
                bytes.as_ref(),
            )?),
            "msg" => CiphertextMessage::SignalMessage(SignalMessage::try_from(bytes.as_ref())?),
            _ => return Err(anyhow!("unexpected ciphertext type")),
        };
        let address = "15555550101:1@s.whatsapp.net"
            .parse::<Jid>()?
            .to_protocol_address();
        let plain = message_decrypt(
            &message,
            &address,
            &mut self.sessions,
            &mut self.identity,
            &mut self.prekeys,
            &self.signed,
            &mut rand::make_rng::<rand::rngs::StdRng>(),
            UsePQRatchet::No,
        )
        .await?;
        let message = wacore::messages::decode_plaintext(&plain, 2)?;
        let text = message
            .conversation
            .ok_or_else(|| anyhow!("fixture expects a conversation"))?;
        if text.len() > 65536 {
            return Err(anyhow!("fixture text limit"));
        }
        let response = waproto::whatsapp::Message {
            conversation: Some("fixture encrypted reply".into()),
            ..Default::default()
        };
        let plain = wacore::messages::MessageUtils::pad_message_v2(prost::Message::encode_to_vec(
            &response,
        ));
        let cipher =
            message_encrypt(&plain, &address, &mut self.sessions, &mut self.identity).await?;
        let (kind, ciphertext) = match cipher {
            CiphertextMessage::PreKeySignalMessage(message) => {
                ("pkmsg", message.serialized().to_vec())
            }
            CiphertextMessage::SignalMessage(message) => ("msg", message.serialized().to_vec()),
            _ => return Err(anyhow!("unexpected reply type")),
        };
        let reply = NodeBuilder::new("message")
            .attrs([
                ("from", PEER),
                ("id", "fixture-signal-reply"),
                ("type", "text"),
                ("t", "1700000000"),
                ("notify", "Synthetic Peer"),
            ])
            .children([NodeBuilder::new("enc")
                .attrs([("type", kind), ("v", "2")])
                .bytes(ciphertext)
                .build()])
            .build();
        Ok((text, reply))
    }
}
