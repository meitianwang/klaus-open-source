use anyhow::{anyhow, Result};
use base64::Engine;
use fixture_hmac::{Hmac, Mac};
use prost::Message;
use wacore::libsignal::protocol::PrivateKey;
use wacore_binary::builder::NodeBuilder;
use wacore_binary::Node;
use waproto::whatsapp as wa;

pub fn key(byte: u8) -> PrivateKey {
    PrivateKey::deserialize(&[byte; 32]).expect("fixed synthetic key")
}
pub fn certificate(static_key: &[u8], forged: bool) -> Vec<u8> {
    let root = key(0x2f);
    let intermediate = key(0x23);
    let cert = |key: &[u8], serial, issuer, signer: &PrivateKey| {
        let details = wa::cert_chain::noise_certificate::Details {
            key: Some(key.to_vec()),
            serial: Some(serial),
            issuer_serial: Some(issuer),
            ..Default::default()
        }
        .encode_to_vec();
        let signature = if forged {
            vec![0; 64]
        } else {
            signer
                .calculate_signature(&details, &mut rand::rng())
                .unwrap()
                .to_vec()
        };
        wa::cert_chain::NoiseCertificate {
            details: Some(details),
            signature: Some(signature),
        }
    };
    wa::CertChain {
        intermediate: Some(cert(
            intermediate.public_key().unwrap().public_key_bytes(),
            7,
            0,
            &root,
        )),
        leaf: Some(cert(static_key, 9, 7, &intermediate)),
    }
    .encode_to_vec()
}
pub fn pair(qr: &str, wrong_hmac: bool) -> Result<Node> {
    let parts: Vec<_> = qr.split(',').collect();
    if parts.len() != 4 {
        return Err(anyhow!("invalid fixture QR"));
    }
    let decode = |value: &str| base64::engine::general_purpose::STANDARD.decode(value);
    let identity = decode(parts[2])?;
    let secret = decode(parts[3])?;
    if identity.len() != 32 || secret.len() != 32 {
        return Err(anyhow!("invalid fixture QR keys"));
    }
    let account = key(0x31);
    let details = wa::AdvDeviceIdentity {
        raw_id: Some(42),
        timestamp: Some(1_700_000_000),
        key_index: Some(1),
        ..Default::default()
    }
    .encode_to_vec();
    let signed = [&[6u8, 0][..], details.as_slice(), identity.as_slice()].concat();
    let signature = account
        .calculate_signature(&signed, &mut rand::rng())?
        .to_vec();
    let signed = wa::AdvSignedDeviceIdentity {
        details: Some(details),
        account_signature_key: Some(account.public_key()?.public_key_bytes().to_vec()),
        account_signature: Some(signature),
        device_signature: None,
    }
    .encode_to_vec();
    let mut mac = Hmac::<fixture_sha2::Sha256>::new_from_slice(&secret)?;
    mac.update(&signed);
    let tag = if wrong_hmac {
        vec![0; 32]
    } else {
        mac.finalize().into_bytes().to_vec()
    };
    let identity = wa::AdvSignedDeviceIdentityHmac {
        details: Some(signed),
        hmac: Some(tag),
        account_type: None,
    }
    .encode_to_vec();
    Ok(NodeBuilder::new("iq")
        .attrs([
            ("from", "s.whatsapp.net"),
            ("type", "set"),
            ("id", "fixture-pair"),
        ])
        .children([NodeBuilder::new("pair-success")
            .children([
                NodeBuilder::new("device-identity").bytes(identity).build(),
                NodeBuilder::new("device")
                    .attrs([
                        ("jid", "15555550101:1@s.whatsapp.net"),
                        ("lid", "900001:1@lid"),
                    ])
                    .build(),
                NodeBuilder::new("biz")
                    .attr("name", "Klaus Protocol Fixture")
                    .build(),
                NodeBuilder::new("platform").attr("name", "fixture").build(),
            ])
            .build()])
        .build())
}
