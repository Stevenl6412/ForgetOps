//! Read-only, environment-scoped secrets supplied by Docker secret mounts.

use std::{fmt, fs, io, path::Path};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

const SECRET_BYTES: usize = 32;
const CANONICALIZATION_VERSION: u32 = 1;

pub struct EnvironmentSecrets {
    subject_hmac_key: Zeroizing<[u8; SECRET_BYTES]>,
    subject_hmac_key_version: u32,
    state_master_key: Zeroizing<[u8; SECRET_BYTES]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubjectHash {
    pub value: String,
    pub key_version: u32,
    pub canonicalization_version: u32,
}

#[derive(Debug)]
pub enum EnvironmentSecretError {
    Io {
        secret: &'static str,
        source: io::Error,
    },
    InvalidLength {
        secret: &'static str,
        length: usize,
    },
    InvalidVersion,
}

impl fmt::Display for EnvironmentSecretError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { secret, source } => write!(formatter, "cannot read {secret}: {source}"),
            Self::InvalidLength { secret, length } => write!(
                formatter,
                "{secret} must contain exactly {SECRET_BYTES} raw bytes, found {length}"
            ),
            Self::InvalidVersion => write!(
                formatter,
                "subject-HMAC key version must be greater than zero"
            ),
        }
    }
}

impl std::error::Error for EnvironmentSecretError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::InvalidLength { .. } => None,
            Self::InvalidVersion => None,
        }
    }
}

impl EnvironmentSecrets {
    pub fn from_secret_files(
        subject_hmac_key_path: impl AsRef<Path>,
        subject_hmac_key_version: u32,
        state_master_key_path: impl AsRef<Path>,
    ) -> Result<Self, EnvironmentSecretError> {
        if subject_hmac_key_version == 0 {
            return Err(EnvironmentSecretError::InvalidVersion);
        }
        Ok(Self {
            subject_hmac_key: read_32_byte_secret(
                subject_hmac_key_path.as_ref(),
                "environment subject-HMAC key",
            )?,
            subject_hmac_key_version,
            state_master_key: read_32_byte_secret(
                state_master_key_path.as_ref(),
                "agent state master key",
            )?,
        })
    }

    pub fn state_master_key(&self) -> &[u8; SECRET_BYTES] {
        &self.state_master_key
    }

    pub fn subject_hash(&self, canonical_subject: &str) -> SubjectHash {
        subject_hash(
            &self.subject_hmac_key[..],
            self.subject_hmac_key_version,
            canonical_subject,
        )
        .expect("environment secret versions are validated when loaded")
    }
}

pub fn subject_hash(
    key: &[u8],
    key_version: u32,
    canonical_subject: &str,
) -> Result<SubjectHash, EnvironmentSecretError> {
    if key_version == 0 {
        return Err(EnvironmentSecretError::InvalidVersion);
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(canonical_subject.as_bytes());
    let mut digest = mac.finalize().into_bytes();
    let value = format!("hmac-sha256:{}", hex_lower(&digest));
    digest.zeroize();
    Ok(SubjectHash {
        value,
        key_version,
        canonicalization_version: CANONICALIZATION_VERSION,
    })
}

fn read_32_byte_secret(
    path: &Path,
    secret: &'static str,
) -> Result<Zeroizing<[u8; SECRET_BYTES]>, EnvironmentSecretError> {
    let mut bytes =
        fs::read(path).map_err(|source| EnvironmentSecretError::Io { secret, source })?;
    if bytes.len() != SECRET_BYTES {
        let length = bytes.len();
        bytes.zeroize();
        return Err(EnvironmentSecretError::InvalidLength { secret, length });
    }
    let mut key = [0u8; SECRET_BYTES];
    key.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(Zeroizing::new(key))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}
