use super::*;
use wa::cert_chain::NoiseCertificate;

fn key(byte: u8) -> PrivateKey {
    PrivateKey::deserialize(&[byte; 32]).unwrap()
}
fn certificate(key: &[u8], serial: u32, issuer: u32, signer: &PrivateKey) -> NoiseCertificate {
    let details = noise_certificate::Details {
        serial: Some(serial),
        issuer_serial: Some(issuer),
        key: Some(key.to_vec()),
        ..Default::default()
    }
    .encode_to_vec();
    let signature = signer
        .calculate_signature(&details, &mut rand::rng())
        .unwrap()
        .to_vec();
    NoiseCertificate {
        details: Some(details),
        signature: Some(signature),
    }
}
fn chain() -> (CertChain, [u8; 32], [u8; 32]) {
    let root = key(0x21);
    let intermediate = key(0x23);
    let leaf = key(0x25);
    let root_public = root
        .public_key()
        .unwrap()
        .public_key_bytes()
        .try_into()
        .unwrap();
    let static_key: [u8; 32] = leaf
        .public_key()
        .unwrap()
        .public_key_bytes()
        .try_into()
        .unwrap();
    let chain = CertChain {
        intermediate: Some(certificate(
            intermediate.public_key().unwrap().public_key_bytes(),
            7,
            0,
            &root,
        )),
        leaf: Some(certificate(&static_key, 9, 7, &intermediate)),
    };
    (chain, root_public, static_key)
}
#[test]
fn accepts_authenticated_certificate_chain() {
    let (chain, root, static_key) = chain();
    HandshakeUtils::verify_server_cert_with_root(&chain.encode_to_vec(), &static_key, &root)
        .unwrap();
}
#[test]
fn rejects_missing_forged_and_modified_signed_payloads() {
    let (chain, root, static_key) = chain();
    for index in 0..6 {
        let mut changed = chain.clone();
        let cert = if index < 3 {
            changed.intermediate.as_mut().unwrap()
        } else {
            changed.leaf.as_mut().unwrap()
        };
        match index % 3 {
            0 => cert.signature = None,
            1 => cert.signature = Some(vec![0; 64]),
            _ => {
                let mut details =
                    noise_certificate::Details::decode(cert.details.as_ref().unwrap().as_slice())
                        .unwrap();
                details.not_after = Some(42);
                cert.details = Some(details.encode_to_vec());
            }
        }
        assert!(
            HandshakeUtils::verify_server_cert_with_root(
                &changed.encode_to_vec(),
                &static_key,
                &root
            )
            .is_err(),
            "case {index}"
        );
    }
}
#[test]
fn rejects_wrong_root_issuer_and_leaf_key() {
    let (chain, root, static_key) = chain();
    assert!(
        HandshakeUtils::verify_server_cert_with_root(&chain.encode_to_vec(), &static_key, &[0; 32])
            .is_err()
    );
    assert!(
        HandshakeUtils::verify_server_cert_with_root(&chain.encode_to_vec(), &[0; 32], &root)
            .is_err()
    );
    let mut changed = chain.clone();
    let leaf = changed.leaf.as_mut().unwrap();
    let mut details =
        noise_certificate::Details::decode(leaf.details.as_ref().unwrap().as_slice()).unwrap();
    details.issuer_serial = Some(6);
    leaf.details = Some(details.encode_to_vec());
    assert!(
        HandshakeUtils::verify_server_cert_with_root(&changed.encode_to_vec(), &static_key, &root)
            .is_err()
    );
}
#[cfg(not(feature = "klaus-fixture-root"))]
#[test]
fn production_rejects_fixture_root() {
    let root = key(0x2f);
    let intermediate = key(0x23);
    let static_key = [5; 32];
    let chain = CertChain {
        intermediate: Some(certificate(
            intermediate.public_key().unwrap().public_key_bytes(),
            7,
            0,
            &root,
        )),
        leaf: Some(certificate(&static_key, 9, 7, &intermediate)),
    };
    assert!(HandshakeUtils::verify_server_cert(&chain.encode_to_vec(), &static_key).is_err());
}

#[test]
fn accepts_committed_whatsapp_signed_chain() {
    // Public certificate from the upstream 0.5.0 committed handshake vector. No private credentials.
    let raw = "0a770a3308c90210031a205854d333d8e13975abd6597bbaddd49d6935ced25c93a44bd3ade508f2bec33020d08f87bf0628d0c99fc406124019cbee71b63bb8048af269f3aa7c13c62a1fd89ac4ef2509d1d78d68267f40393b49a9cc38db05e35a6c5bf3ba6172a4c5325f25f363338cf8f3535a4cd9520512760a32080310001a201c51a9ac303994c6c8d0b92ea1878a533476599cc599fbea35997d9aa90cce62208091aebe0628ffdeb7dc061240270f294648539fed4870e25054dd4e95983aba29189c2ba6c8eeda7055555f753740f5ec192ab64c26c26d6ade6d20b9f774aee37120a6b20395f53c66058507";
    let bytes: Vec<u8> = (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap())
        .collect();
    let parsed = CertChain::decode(bytes.as_slice()).unwrap();
    let details =
        noise_certificate::Details::decode(parsed.leaf.unwrap().details.unwrap().as_slice())
            .unwrap();
    let static_key: [u8; 32] = details.key().try_into().unwrap();
    HandshakeUtils::verify_server_cert_with_root(&bytes, &static_key, &WA_CERT_PUB_KEY).unwrap();
}
