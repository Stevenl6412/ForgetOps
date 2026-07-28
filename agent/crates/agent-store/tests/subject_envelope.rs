use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use agent_core::identity::AgentIdentity;
use agent_store::crypto::{
    SUBJECT_ENVELOPE_ALGORITHM, SUBJECT_ENVELOPE_VERSION, SubjectEnvelopeCiphertext,
    decrypt_subject_envelope,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use serde_json::json;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

const ENVIRONMENT_ID: &str = "env_subject";
const REQUEST_ID: &str = "req_subject";
const HKDF_INFO: &[u8] = b"forgetops.subject-envelope.v1";

#[test]
fn decrypts_a_subject_envelope_bound_to_request_environment_and_key() {
    let identity = AgentIdentity::generate();
    let envelope = encrypted_envelope(&identity);

    let subject = decrypt_subject_envelope(&identity, ENVIRONMENT_ID, REQUEST_ID, &envelope)
        .expect("decrypt subject");

    assert_eq!(subject.application_user_id.as_deref(), Some("customer-42"));
    assert_eq!(subject.email.as_deref(), Some("Canary@Example.com"));
}

#[test]
fn rejects_tampering_and_cross_request_replay() {
    let identity = AgentIdentity::generate();
    let mut envelope = encrypted_envelope(&identity);
    let mut ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext).unwrap();
    ciphertext[0] ^= 1;
    envelope.ciphertext = URL_SAFE_NO_PAD.encode(ciphertext);

    assert!(decrypt_subject_envelope(&identity, ENVIRONMENT_ID, REQUEST_ID, &envelope).is_err());

    let envelope = encrypted_envelope(&identity);
    assert!(decrypt_subject_envelope(&identity, ENVIRONMENT_ID, "req_other", &envelope).is_err());
}

fn encrypted_envelope(identity: &AgentIdentity) -> SubjectEnvelopeCiphertext {
    let sender_secret = StaticSecret::from([7u8; 32]);
    let sender_public = PublicKey::from(&sender_secret);
    let recipient_public = PublicKey::from(identity.encryption_public_key());
    let shared_secret = sender_secret.diffie_hellman(&recipient_public);
    let salt = [8u8; 32];
    let nonce = [9u8; 12];
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
        .expand(HKDF_INFO, &mut key)
        .unwrap();
    let encryption_key_id = identity.key_ids().encryption_key_id;
    let aad = serde_json_canonicalizer::to_vec(&json!({
        "encryptionKeyId": encryption_key_id,
        "environmentId": ENVIRONMENT_ID,
        "requestId": REQUEST_ID,
    }))
    .unwrap();
    let plaintext = br#"{"applicationUserId":"customer-42","email":"Canary@Example.com"}"#;
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .encrypt(
            &Nonce::try_from(&nonce[..]).unwrap(),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .unwrap();

    SubjectEnvelopeCiphertext {
        version: SUBJECT_ENVELOPE_VERSION,
        algorithm: SUBJECT_ENVELOPE_ALGORITHM.into(),
        request_id: REQUEST_ID.into(),
        environment_id: ENVIRONMENT_ID.into(),
        encryption_key_id: identity.key_ids().encryption_key_id,
        ephemeral_public_key: URL_SAFE_NO_PAD.encode(sender_public.as_bytes()),
        salt: URL_SAFE_NO_PAD.encode(salt),
        iv: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    }
}
