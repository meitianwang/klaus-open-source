use fixture_hmac::{Hmac, Mac};
use prost::Message;
use wacore::libsignal::protocol::{KeyPair, PrivateKey};
use wacore::pair::{DeviceState, PairUtils};
use waproto::whatsapp as wa;

fn key(byte: u8) -> KeyPair {
    let private = PrivateKey::deserialize(&[byte; 32]).unwrap();
    KeyPair::new(private.public_key().unwrap(), private)
}
fn fixture(hosted: bool) -> (DeviceState, wa::AdvSignedDeviceIdentityHmac) {
    let state = DeviceState {
        identity_key: key(0x41),
        noise_key: key(0x43),
        adv_secret_key: [0x47; 32],
    };
    let account = key(0x49);
    let details = wa::AdvDeviceIdentity {
        raw_id: Some(17),
        key_index: Some(7),
        timestamp: Some(1_700_000_000),
        ..Default::default()
    }
    .encode_to_vec();
    let prefix: &[u8] = if hosted { &[6, 5] } else { &[6, 0] };
    let input = [
        prefix,
        &details,
        state.identity_key.public_key.public_key_bytes(),
    ]
    .concat();
    let signed = wa::AdvSignedDeviceIdentity {
        details: Some(details),
        account_signature_key: Some(account.public_key.public_key_bytes().to_vec()),
        account_signature: Some(
            account
                .calculate_signature(&input, &mut rand::make_rng::<rand::rngs::StdRng>())
                .unwrap()
                .to_vec(),
        ),
        device_signature: None,
    }
    .encode_to_vec();
    let mut mac = Hmac::<fixture_sha2::Sha256>::new_from_slice(&state.adv_secret_key).unwrap();
    if hosted {
        mac.update(prefix);
    }
    mac.update(&signed);
    (
        state,
        wa::AdvSignedDeviceIdentityHmac {
            details: Some(signed),
            hmac: Some(mac.finalize().into_bytes().to_vec()),
            account_type: hosted.then_some(wa::AdvEncryptionType::Hosted as i32),
        },
    )
}
#[test]
fn accepts_authenticated_qr_and_hosted_envelopes() {
    for hosted in [false, true] {
        let (state, envelope) = fixture(hosted);
        assert_eq!(
            PairUtils::do_pair_crypto(&state, &envelope.encode_to_vec())
                .unwrap()
                .1,
            7
        );
    }
}
#[test]
fn rejects_missing_short_changed_or_wrong_secret_mac() {
    for variant in 0..5 {
        let (mut state, mut envelope) = fixture(false);
        match variant {
            0 => envelope.hmac = None,
            1 => envelope.hmac = Some(vec![0; 1]),
            2 => envelope.hmac.as_mut().unwrap()[0] ^= 1,
            3 => envelope.details.as_mut().unwrap()[0] ^= 1,
            _ => state.adv_secret_key[0] ^= 1,
        }
        assert!(PairUtils::do_pair_crypto(&state, &envelope.encode_to_vec()).is_err());
    }
}
#[test]
fn hosted_prefix_and_account_signature_remain_authenticated() {
    let (state, mut envelope) = fixture(true);
    envelope.account_type = None;
    assert_eq!(
        PairUtils::do_pair_crypto(&state, &envelope.encode_to_vec())
            .unwrap_err()
            .text,
        "hmac-mismatch"
    );
    let (state, mut envelope) = fixture(false);
    let mut signed =
        wa::AdvSignedDeviceIdentity::decode(envelope.details.as_ref().unwrap().as_slice()).unwrap();
    signed.account_signature.as_mut().unwrap()[0] ^= 1;
    let details = signed.encode_to_vec();
    let mut mac = Hmac::<fixture_sha2::Sha256>::new_from_slice(&state.adv_secret_key).unwrap();
    mac.update(&details);
    envelope.details = Some(details);
    envelope.hmac = Some(mac.finalize().into_bytes().to_vec());
    assert_eq!(
        PairUtils::do_pair_crypto(&state, &envelope.encode_to_vec())
            .unwrap_err()
            .text,
        "signature-mismatch"
    );
}
