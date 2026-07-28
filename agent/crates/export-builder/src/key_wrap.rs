use crate::encryption::{ARCHIVE_KEY_BYTES, ArchiveEncryptionError};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use hkdf::Hkdf;
use rand::{RngExt, rngs::SysRng};
use rand_core::UnwrapErr;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

const WRAP_CONTEXT: &[u8] = b"forgetops.export-key-wrap.v1\0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
    let aad = [WRAP_CONTEXT, context].concat();
    let key = derive_wrap_key(&shared, &aad)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| ArchiveEncryptionError::InvalidKey)?;
    let mut nonce = [0u8; 24];
    rng.fill(&mut nonce);
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
    let aad = [WRAP_CONTEXT, context].concat();
    let key = derive_wrap_key(&shared, &aad)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key[..])
        .map_err(|_| ArchiveEncryptionError::InvalidKey)?;
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

fn derive_wrap_key(
    shared: &x25519_dalek::SharedSecret,
    context: &[u8],
) -> Result<Zeroizing<[u8; ARCHIVE_KEY_BYTES]>, ArchiveEncryptionError> {
    if !shared.was_contributory() {
        return Err(ArchiveEncryptionError::InvalidKey);
    }
    let mut key = Zeroizing::new([0u8; ARCHIVE_KEY_BYTES]);
    Hkdf::<Sha256>::new(None, shared.as_bytes())
        .expand(context, &mut *key)
        .map_err(|_| ArchiveEncryptionError::InvalidKey)?;
    Ok(key)
}
