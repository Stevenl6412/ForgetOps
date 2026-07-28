//! Long-lived agent identity encrypted in the persistent state volume.

use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::Path,
};

use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{RngExt, rngs::SysRng};
use rand_core::{CryptoRng, UnwrapErr};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
pub const IDENTITY_FILE: &str = "identity.bin";

const IDENTITY_MAGIC: &[u8; 8] = b"FOPSID01";
const IDENTITY_VERSION: u8 = 1;
const IDENTITY_NONCE_BYTES: usize = 24;
const IDENTITY_PRIVATE_BYTES: usize = 64;
const IDENTITY_TAG_BYTES: usize = 16;
const IDENTITY_BLOB_BYTES: usize =
    IDENTITY_MAGIC.len() + 1 + IDENTITY_NONCE_BYTES + IDENTITY_PRIVATE_BYTES + IDENTITY_TAG_BYTES;
const IDENTITY_AAD: &[u8] = b"forgetops.agent.identity.v1\0";

#[derive(Debug)]
pub enum IdentityError {
    Io(io::Error),
    InvalidBlob(&'static str),
    AuthenticationFailed,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "identity state I/O failed: {error}"),
            Self::InvalidBlob(reason) => {
                write!(formatter, "invalid encrypted identity blob: {reason}")
            }
            Self::AuthenticationFailed => {
                formatter.write_str("encrypted identity authentication failed")
            }
        }
    }
}

impl std::error::Error for IdentityError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AgentPublicKeys {
    signing_key: [u8; PUBLIC_KEY_BYTES],
    encryption_key: [u8; PUBLIC_KEY_BYTES],
}

impl AgentPublicKeys {
    pub fn signing_key(&self) -> [u8; PUBLIC_KEY_BYTES] {
        self.signing_key
    }

    pub fn encryption_key(&self) -> [u8; PUBLIC_KEY_BYTES] {
        self.encryption_key
    }
}

impl fmt::Debug for AgentPublicKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentPublicKeys")
            .field("signing_key", &"<public>")
            .field("encryption_key", &"<public>")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKeyIds {
    pub signing_key_id: String,
    pub encryption_key_id: String,
}

/// A long-lived customer agent identity. Its private material never leaves the
/// authenticated-encrypted state blob.
pub struct AgentIdentity {
    signing_key: SigningKey,
    encryption_secret: StaticSecret,
}

impl AgentIdentity {
    pub fn generate() -> Self {
        let mut rng = UnwrapErr(SysRng);
        Self::generate_with_rng(&mut rng)
    }

    pub fn generate_with_rng(rng: &mut impl CryptoRng) -> Self {
        Self {
            signing_key: SigningKey::generate(rng),
            encryption_secret: StaticSecret::random_from_rng(rng),
        }
    }

    pub fn public_keys(&self) -> AgentPublicKeys {
        AgentPublicKeys {
            signing_key: self.signing_key.verifying_key().to_bytes(),
            encryption_key: X25519PublicKey::from(&self.encryption_secret).to_bytes(),
        }
    }

    pub fn key_ids(&self) -> AgentKeyIds {
        let keys = self.public_keys();
        AgentKeyIds {
            signing_key_id: format!(
                "ed25519:sha256:{}",
                hex_lower(&Sha256::digest(keys.signing_key))
            ),
            encryption_key_id: format!(
                "x25519:sha256:{}",
                hex_lower(&Sha256::digest(keys.encryption_key))
            ),
        }
    }

    pub fn encryption_public_key(&self) -> [u8; PUBLIC_KEY_BYTES] {
        self.public_keys().encryption_key
    }

    pub fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_BYTES] {
        self.signing_key.sign(message).to_bytes()
    }

    pub fn verify_signature(
        public_key: &[u8; PUBLIC_KEY_BYTES],
        message: &[u8],
        signature: &[u8; SIGNATURE_BYTES],
    ) -> bool {
        let Ok(verifying_key) = VerifyingKey::from_bytes(public_key) else {
            return false;
        };
        let signature = Signature::from_bytes(signature);
        verifying_key.verify(message, &signature).is_ok()
    }

    pub fn shared_secret(
        &self,
        peer_public_key: &[u8; PUBLIC_KEY_BYTES],
    ) -> Zeroizing<[u8; PUBLIC_KEY_BYTES]> {
        Zeroizing::new(
            self.encryption_secret
                .diffie_hellman(&X25519PublicKey::from(*peer_public_key))
                .to_bytes(),
        )
    }

    pub fn write_new_encrypted(
        &self,
        path: impl AsRef<Path>,
        state_master_key: &[u8; 32],
    ) -> Result<(), IdentityError> {
        let path = path.as_ref();
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory).map_err(IdentityError::Io)?;
        }
        let mut blob = self.encrypt(state_master_key)?;
        let result = write_new_secret_file(path, &blob).map_err(IdentityError::Io);
        blob.zeroize();
        result
    }

    pub fn read_encrypted(
        path: impl AsRef<Path>,
        state_master_key: &[u8; 32],
    ) -> Result<Self, IdentityError> {
        let mut blob = fs::read(path).map_err(IdentityError::Io)?;
        let result = Self::decrypt(&blob, state_master_key);
        blob.zeroize();
        result
    }

    fn encrypt(&self, state_master_key: &[u8; 32]) -> Result<Vec<u8>, IdentityError> {
        let cipher = XChaCha20Poly1305::new_from_slice(state_master_key)
            .map_err(|_| IdentityError::InvalidBlob("invalid state master key"))?;
        let mut nonce = Zeroizing::new([0u8; IDENTITY_NONCE_BYTES]);
        let mut rng = UnwrapErr(SysRng);
        rng.fill(&mut *nonce);
        let mut plaintext = Zeroizing::new([0u8; IDENTITY_PRIVATE_BYTES]);
        let signing = Zeroizing::new(self.signing_key.to_bytes());
        let encryption = Zeroizing::new(self.encryption_secret.to_bytes());
        plaintext[..PUBLIC_KEY_BYTES].copy_from_slice(&signing[..]);
        plaintext[PUBLIC_KEY_BYTES..].copy_from_slice(&encryption[..]);
        let nonce_for_cipher =
            XNonce::try_from(&nonce[..]).expect("a fixed-size XChaCha20 nonce is valid");
        let ciphertext = cipher
            .encrypt(
                &nonce_for_cipher,
                Payload {
                    msg: &plaintext[..],
                    aad: IDENTITY_AAD,
                },
            )
            .map_err(|_| IdentityError::AuthenticationFailed)?;
        let mut blob = Vec::with_capacity(IDENTITY_BLOB_BYTES);
        blob.extend_from_slice(IDENTITY_MAGIC);
        blob.push(IDENTITY_VERSION);
        blob.extend_from_slice(&nonce[..]);
        blob.extend_from_slice(&ciphertext);
        Ok(blob)
    }

    fn decrypt(blob: &[u8], state_master_key: &[u8; 32]) -> Result<Self, IdentityError> {
        if blob.len() != IDENTITY_BLOB_BYTES {
            return Err(IdentityError::InvalidBlob("unexpected length"));
        }
        if blob[..IDENTITY_MAGIC.len()] != *IDENTITY_MAGIC {
            return Err(IdentityError::InvalidBlob("bad magic"));
        }
        if blob[IDENTITY_MAGIC.len()] != IDENTITY_VERSION {
            return Err(IdentityError::InvalidBlob("unsupported version"));
        }
        let nonce_start = IDENTITY_MAGIC.len() + 1;
        let ciphertext_start = nonce_start + IDENTITY_NONCE_BYTES;
        let cipher = XChaCha20Poly1305::new_from_slice(state_master_key)
            .map_err(|_| IdentityError::InvalidBlob("invalid state master key"))?;
        let nonce = XNonce::try_from(&blob[nonce_start..ciphertext_start])
            .map_err(|_| IdentityError::InvalidBlob("invalid nonce"))?;
        let plaintext = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &blob[ciphertext_start..],
                    aad: IDENTITY_AAD,
                },
            )
            .map_err(|_| IdentityError::AuthenticationFailed)?;
        let plaintext = Zeroizing::new(plaintext);
        if plaintext.len() != IDENTITY_PRIVATE_BYTES {
            return Err(IdentityError::InvalidBlob("unexpected plaintext length"));
        }
        let mut signing = Zeroizing::new([0u8; PUBLIC_KEY_BYTES]);
        let mut encryption = Zeroizing::new([0u8; PUBLIC_KEY_BYTES]);
        signing.copy_from_slice(&plaintext[..PUBLIC_KEY_BYTES]);
        encryption.copy_from_slice(&plaintext[PUBLIC_KEY_BYTES..]);
        let signing_key = SigningKey::from_bytes(&signing);
        let encryption_secret = StaticSecret::from(*encryption);
        Ok(Self {
            signing_key,
            encryption_secret,
        })
    }
}

impl fmt::Debug for AgentIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentIdentity")
            .field("public_keys", &self.public_keys())
            .field("signing_secret", &"<redacted>")
            .field("encryption_secret", &"<redacted>")
            .finish()
    }
}

fn write_new_secret_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file: File = options.open(path)?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_blob_contains_neither_private_key() {
        let identity = AgentIdentity::generate();
        let signing_private = identity.signing_key.to_bytes();
        let encryption_private = identity.encryption_secret.to_bytes();
        let blob = identity.encrypt(&[9u8; 32]).expect("encrypt identity");

        assert!(
            !blob
                .windows(PUBLIC_KEY_BYTES)
                .any(|window| window == signing_private)
        );
        assert!(
            !blob
                .windows(PUBLIC_KEY_BYTES)
                .any(|window| window == encryption_private)
        );
    }
}
