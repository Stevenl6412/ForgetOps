//! Long-lived agent identity and local secret storage.
//!
//! An identity contains three independent secrets: an Ed25519 signing seed, an
//! X25519 encryption secret, and a 32-byte subject-HMAC key.  Only the two
//! public keys are exposed by the API.  Private material is written with
//! `create_new`, so a second pairing can never silently replace an identity.
//!
//! On Unix, newly-created secret files are mode `0600`.  On Windows,
//! `create_new` prevents replacement, while the effective ACL is still subject
//! to the directory's inherited Windows permissions; this module deliberately
//! does not broaden or rewrite those ACLs.

use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{RngExt, rngs::SysRng};
use rand_core::UnwrapErr;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};
use zeroize::Zeroize;

pub const PUBLIC_KEY_BYTES: usize = 32;
pub const SIGNATURE_BYTES: usize = 64;
pub const SUBJECT_HMAC_KEY_BYTES: usize = 32;

pub const SIGNING_KEY_FILE: &str = "signing-key.bin";
pub const ENCRYPTION_KEY_FILE: &str = "encryption-key.bin";
pub const SUBJECT_HMAC_KEY_FILE: &str = "subject-hmac-key.bin";

/// The non-secret part of an initialized agent identity.
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

/// A long-lived customer agent identity.
pub struct AgentIdentity {
    signing_key: SigningKey,
    encryption_secret: StaticSecret,
    subject_hmac_key: [u8; SUBJECT_HMAC_KEY_BYTES],
}

impl AgentIdentity {
    /// Generate all identity secrets from the operating-system CSPRNG.
    pub fn generate() -> Self {
        let mut rng = UnwrapErr(SysRng);
        let signing_key = SigningKey::generate(&mut rng);
        let encryption_secret = StaticSecret::random_from_rng(&mut rng);
        let mut subject_hmac_key = [0u8; SUBJECT_HMAC_KEY_BYTES];
        rng.fill(&mut subject_hmac_key);

        Self {
            signing_key,
            encryption_secret,
            subject_hmac_key,
        }
    }

    pub fn public_keys(&self) -> AgentPublicKeys {
        AgentPublicKeys {
            signing_key: self.signing_key.verifying_key().to_bytes(),
            encryption_key: X25519PublicKey::from(&self.encryption_secret).to_bytes(),
        }
    }

    pub fn signing_public_key(&self) -> [u8; PUBLIC_KEY_BYTES] {
        self.public_keys().signing_key
    }

    pub fn encryption_public_key(&self) -> [u8; PUBLIC_KEY_BYTES] {
        self.public_keys().encryption_key
    }

    /// Sign a message with the identity's Ed25519 key.
    pub fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_BYTES] {
        let signature: Signature = self.signing_key.sign(message);
        signature.to_bytes()
    }

    /// Verify an Ed25519 signature against a raw 32-byte public key.
    pub fn verify_signature(
        public_key: &[u8; PUBLIC_KEY_BYTES],
        message: &[u8],
        signature: &[u8; SIGNATURE_BYTES],
    ) -> bool {
        let Ok(verifying_key) = VerifyingKey::from_bytes(public_key) else {
            return false;
        };
        let Ok(signature) = Signature::try_from(&signature[..]) else {
            return false;
        };
        verifying_key.verify(message, &signature).is_ok()
    }

    /// Derive an X25519 shared secret with a peer's raw public key.
    pub fn shared_secret(
        &self,
        peer_public_key: &[u8; PUBLIC_KEY_BYTES],
    ) -> [u8; PUBLIC_KEY_BYTES] {
        let peer = X25519PublicKey::from(*peer_public_key);
        self.encryption_secret.diffie_hellman(&peer).to_bytes()
    }

    /// Write all private values exactly once into `directory`.
    pub fn write_private_material(&self, directory: impl AsRef<Path>) -> io::Result<IdentityPaths> {
        let paths = IdentityPaths::in_directory(directory);
        fs::create_dir_all(&paths.directory)?;

        let files = [
            (&paths.signing_key, self.signing_key.to_bytes().to_vec()),
            (
                &paths.encryption_key,
                self.encryption_secret.to_bytes().to_vec(),
            ),
            (&paths.subject_hmac_key, self.subject_hmac_key.to_vec()),
        ];
        let mut created = Vec::with_capacity(files.len());
        for (path, bytes) in files {
            match write_secret_file(path, &bytes) {
                Ok(()) => created.push(path),
                Err(error) => {
                    for created_path in created {
                        let _ = fs::remove_file(created_path);
                    }
                    return Err(error);
                }
            }
        }
        Ok(paths)
    }
}

impl fmt::Debug for AgentIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentIdentity")
            .field("public_keys", &self.public_keys())
            .field("signing_secret", &"<redacted>")
            .field("encryption_secret", &"<redacted>")
            .field("subject_hmac_key", &"<redacted>")
            .finish()
    }
}

impl Drop for AgentIdentity {
    fn drop(&mut self) {
        self.subject_hmac_key.zeroize();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityPaths {
    pub directory: PathBuf,
    pub signing_key: PathBuf,
    pub encryption_key: PathBuf,
    pub subject_hmac_key: PathBuf,
}

impl IdentityPaths {
    pub fn in_directory(directory: impl AsRef<Path>) -> Self {
        let directory = directory.as_ref().to_path_buf();
        Self {
            signing_key: directory.join(SIGNING_KEY_FILE),
            encryption_key: directory.join(ENCRYPTION_KEY_FILE),
            subject_hmac_key: directory.join(SUBJECT_HMAC_KEY_FILE),
            directory,
        }
    }
}

fn write_secret_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file: File = options.open(path)?;
    if let Err(error) = write_and_sync(&mut file, bytes) {
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}
