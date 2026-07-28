use std::{error::Error, fmt};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::Serialize;

use crate::AgentMessage;

const MESSAGE_SIGNING_CONTEXT: &[u8] = b"forgetops.agent-message.v1";
const PUBLIC_KEY_BYTES: usize = 32;
const SIGNATURE_BYTES: usize = 64;

#[derive(Debug)]
pub enum MessageSigningError {
    CanonicalJson(serde_json::Error),
    InvalidMessage,
    InvalidPublicKey,
    InvalidSignature,
    VerificationFailed,
}

impl fmt::Display for MessageSigningError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CanonicalJson(_) => formatter.write_str("message payload is not canonical JSON"),
            Self::InvalidMessage => {
                formatter.write_str("agent message must serialize as an object")
            }
            Self::InvalidPublicKey => formatter.write_str("invalid Ed25519 public key"),
            Self::InvalidSignature => formatter.write_str("invalid Ed25519 signature"),
            Self::VerificationFailed => {
                formatter.write_str("message signature verification failed")
            }
        }
    }
}

impl Error for MessageSigningError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::CanonicalJson(error) => Some(error),
            _ => None,
        }
    }
}

pub fn canonical_unsigned_bytes(message: &AgentMessage) -> Result<Vec<u8>, MessageSigningError> {
    let mut unsigned = serde_json::to_value(message).map_err(MessageSigningError::CanonicalJson)?;
    let object = unsigned
        .as_object_mut()
        .ok_or(MessageSigningError::InvalidMessage)?;
    object.remove("signature");
    serde_json_canonicalizer::to_vec(&unsigned).map_err(MessageSigningError::CanonicalJson)
}

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let value = serde_json::to_value(value)?;
    serde_json_canonicalizer::to_vec(&value)
}

pub fn sign_domain_separated<T: Serialize>(
    context: &[u8],
    value: &T,
    signing_key: &SigningKey,
) -> Result<Vec<u8>, serde_json::Error> {
    let canonical = canonical_json_bytes(value)?;
    let mut material = Vec::with_capacity(context.len() + 1 + canonical.len());
    material.extend_from_slice(context);
    material.push(0);
    material.extend_from_slice(&canonical);
    Ok(signing_key.sign(&material).to_bytes().to_vec())
}

pub fn message_signing_bytes(message: &AgentMessage) -> Result<Vec<u8>, MessageSigningError> {
    let canonical = canonical_unsigned_bytes(message)?;
    let mut bytes = Vec::with_capacity(MESSAGE_SIGNING_CONTEXT.len() + 1 + canonical.len());
    bytes.extend_from_slice(MESSAGE_SIGNING_CONTEXT);
    bytes.push(0);
    bytes.extend_from_slice(&canonical);
    Ok(bytes)
}

pub fn sign_message(
    message: &mut AgentMessage,
    signing_key: &SigningKey,
) -> Result<(), MessageSigningError> {
    let signature = signing_key.sign(&message_signing_bytes(message)?);
    message.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    Ok(())
}

pub fn verify_message(message: &AgentMessage, public_key: &str) -> Result<(), MessageSigningError> {
    let public_key: [u8; PUBLIC_KEY_BYTES] = decode_canonical(public_key)?
        .try_into()
        .map_err(|_| MessageSigningError::InvalidPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&public_key).map_err(|_| MessageSigningError::InvalidPublicKey)?;
    let signature: [u8; SIGNATURE_BYTES] = decode_canonical(&message.signature)?
        .try_into()
        .map_err(|_| MessageSigningError::InvalidSignature)?;
    let signature = Signature::from_bytes(&signature);
    verifying_key
        .verify(&message_signing_bytes(message)?, &signature)
        .map_err(|_| MessageSigningError::VerificationFailed)
}

fn decode_canonical(value: &str) -> Result<Vec<u8>, MessageSigningError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| MessageSigningError::InvalidSignature)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(MessageSigningError::InvalidSignature);
    }
    Ok(decoded)
}
