use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rand::{RngExt, rngs::SysRng};
use rand_core::UnwrapErr;
use std::{error::Error, fmt};
use zeroize::Zeroizing;

pub const ARCHIVE_KEY_BYTES: usize = 32;
pub const ARCHIVE_NONCE_BYTES: usize = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveEncryptionError {
    InvalidKey,
    InvalidNonce,
    AuthenticationFailed,
    ChunkTooLarge,
}

impl fmt::Display for ArchiveEncryptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidKey => "invalid archive key",
            Self::InvalidNonce => "invalid archive nonce",
            Self::AuthenticationFailed => "archive chunk authentication failed",
            Self::ChunkTooLarge => "archive chunk exceeds configured limit",
        })
    }
}

impl Error for ArchiveEncryptionError {}

pub fn encrypt_chunk(
    key: &[u8; ARCHIVE_KEY_BYTES],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<([u8; ARCHIVE_NONCE_BYTES], Vec<u8>), ArchiveEncryptionError> {
    if plaintext.len() > 16 * 1024 * 1024 {
        return Err(ArchiveEncryptionError::ChunkTooLarge);
    }
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| ArchiveEncryptionError::InvalidKey)?;
    let mut nonce = [0u8; ARCHIVE_NONCE_BYTES];
    let mut rng = UnwrapErr(SysRng);
    rng.fill(&mut nonce);
    let nonce_ref =
        XNonce::try_from(&nonce[..]).map_err(|_| ArchiveEncryptionError::InvalidNonce)?;
    let ciphertext = cipher
        .encrypt(
            &nonce_ref,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ArchiveEncryptionError::AuthenticationFailed)?;
    Ok((nonce, ciphertext))
}

pub fn decrypt_chunk(
    key: &[u8; ARCHIVE_KEY_BYTES],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ArchiveEncryptionError> {
    let nonce: &[u8; ARCHIVE_NONCE_BYTES] = nonce
        .try_into()
        .map_err(|_| ArchiveEncryptionError::InvalidNonce)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key).map_err(|_| ArchiveEncryptionError::InvalidKey)?;
    cipher
        .decrypt(
            &XNonce::try_from(&nonce[..]).map_err(|_| ArchiveEncryptionError::InvalidNonce)?,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| ArchiveEncryptionError::AuthenticationFailed)
}
