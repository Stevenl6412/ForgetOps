use crate::encryption::{ARCHIVE_KEY_BYTES, ArchiveEncryptionError};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rand::{RngExt, rngs::SysRng};
use rand_core::UnwrapErr;
use x25519_dalek::{PublicKey, StaticSecret};

const WRAP_CONTEXT: &[u8] = b"forgetops.export-key-wrap.v1\0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedArchiveKey {
    pub version: u16,
    pub ephemeral_public_key: [u8; 32],
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}

pub fn wrap_archive_key(
    archive_key: &[u8; ARCHIVE_KEY_BYTES],
    recipient_public_key: &[u8; 32],
    context: &[u8],
) -> Result<WrappedArchiveKey, ArchiveEncryptionError> {
    let mut rng = UnwrapErr(SysRng);
    let ephemeral_secret = StaticSecret::random_from_rng(&mut rng);
    let ephemeral_public_key = PublicKey::from(&ephemeral_secret).to_bytes();
    let shared = ephemeral_secret.diffie_hellman(&PublicKey::from(*recipient_public_key));
    let cipher = XChaCha20Poly1305::new_from_slice(shared.as_bytes())
        .map_err(|_| ArchiveEncryptionError::InvalidKey)?;
    let mut nonce = [0u8; 24];
    rng.fill(&mut nonce);
    let aad = [WRAP_CONTEXT, context].concat();
    let ciphertext = cipher
        .encrypt(
            &XNonce::try_from(&nonce[..]).map_err(|_| ArchiveEncryptionError::InvalidNonce)?,
            Payload {
                msg: archive_key,
                aad: &aad,
            },
        )
        .map_err(|_| ArchiveEncryptionError::AuthenticationFailed)?;
    Ok(WrappedArchiveKey {
        version: 1,
        ephemeral_public_key,
        nonce,
        ciphertext,
    })
}

pub fn unwrap_archive_key(
    wrapped: &WrappedArchiveKey,
    recipient_secret_key: &[u8; 32],
    context: &[u8],
) -> Result<[u8; ARCHIVE_KEY_BYTES], ArchiveEncryptionError> {
    if wrapped.version != 1 {
        return Err(ArchiveEncryptionError::InvalidNonce);
    }
    let secret = StaticSecret::from(*recipient_secret_key);
    let shared = secret.diffie_hellman(&PublicKey::from(wrapped.ephemeral_public_key));
    let cipher = XChaCha20Poly1305::new_from_slice(shared.as_bytes())
        .map_err(|_| ArchiveEncryptionError::InvalidKey)?;
    let aad = [WRAP_CONTEXT, context].concat();
    let plaintext = cipher
        .decrypt(
            &XNonce::try_from(&wrapped.nonce[..])
                .map_err(|_| ArchiveEncryptionError::InvalidNonce)?,
            Payload {
                msg: &wrapped.ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| ArchiveEncryptionError::AuthenticationFailed)?;
    plaintext
        .try_into()
        .map_err(|_| ArchiveEncryptionError::AuthenticationFailed)
}
