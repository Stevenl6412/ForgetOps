//! Subject-envelope decryption at the customer-agent boundary.

use std::fmt;

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use agent_core::{
    identity::{AgentIdentity, PUBLIC_KEY_BYTES},
    subject::SubjectIdentity,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub const SUBJECT_ENVELOPE_VERSION: u32 = 1;
pub const SUBJECT_ENVELOPE_ALGORITHM: &str = "X25519-HKDF-SHA256-AES-256-GCM";

const HKDF_INFO: &[u8] = b"forgetops.subject-envelope.v1";
const SALT_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectEnvelopeCiphertext {
    pub version: u32,
    pub algorithm: String,
    pub request_id: String,
    pub environment_id: String,
    pub encryption_key_id: String,
    pub ephemeral_public_key: String,
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubjectEnvelopeError;

impl fmt::Display for SubjectEnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SUBJECT_ENVELOPE_INVALID")
    }
}

impl std::error::Error for SubjectEnvelopeError {}

pub fn decrypt_subject_envelope(
    identity: &AgentIdentity,
    expected_environment_id: &str,
    expected_request_id: &str,
    envelope: &SubjectEnvelopeCiphertext,
) -> Result<SubjectIdentity, SubjectEnvelopeError> {
    validate_scope(
        identity,
        expected_environment_id,
        expected_request_id,
        envelope,
    )?;
    let ephemeral_public_key = decode_exact::<PUBLIC_KEY_BYTES>(&envelope.ephemeral_public_key)?;
    let salt = decode_exact::<SALT_BYTES>(&envelope.salt)?;
    let nonce = decode_exact::<NONCE_BYTES>(&envelope.iv)?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| SubjectEnvelopeError)?;
    if ciphertext.len() < TAG_BYTES {
        return Err(SubjectEnvelopeError);
    }

    let shared_secret = identity.shared_secret(&ephemeral_public_key);
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), &shared_secret[..])
        .expand(HKDF_INFO, &mut *key)
        .map_err(|_| SubjectEnvelopeError)?;
    let aad = canonical_aad(envelope)?;
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| SubjectEnvelopeError)?;
    let nonce = Nonce::try_from(&nonce[..]).map_err(|_| SubjectEnvelopeError)?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| SubjectEnvelopeError)?;
    let mut plaintext = Zeroizing::new(plaintext);
    let subject = serde_json::from_slice(&plaintext).map_err(|_| SubjectEnvelopeError);
    plaintext.zeroize();
    subject
}

fn validate_scope(
    identity: &AgentIdentity,
    expected_environment_id: &str,
    expected_request_id: &str,
    envelope: &SubjectEnvelopeCiphertext,
) -> Result<(), SubjectEnvelopeError> {
    if envelope.version != SUBJECT_ENVELOPE_VERSION
        || envelope.algorithm != SUBJECT_ENVELOPE_ALGORITHM
        || envelope.environment_id != expected_environment_id
        || envelope.request_id != expected_request_id
        || envelope.encryption_key_id != identity.key_ids().encryption_key_id
    {
        return Err(SubjectEnvelopeError);
    }
    Ok(())
}

fn canonical_aad(envelope: &SubjectEnvelopeCiphertext) -> Result<Vec<u8>, SubjectEnvelopeError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Aad<'a> {
        encryption_key_id: &'a str,
        environment_id: &'a str,
        request_id: &'a str,
    }

    serde_json_canonicalizer::to_vec(&Aad {
        encryption_key_id: &envelope.encryption_key_id,
        environment_id: &envelope.environment_id,
        request_id: &envelope.request_id,
    })
    .map_err(|_| SubjectEnvelopeError)
}

fn decode_exact<const N: usize>(value: &str) -> Result<[u8; N], SubjectEnvelopeError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| SubjectEnvelopeError)?;
    bytes.try_into().map_err(|_| SubjectEnvelopeError)
}
