//! Encrypted, crash-consistent local state for the customer-hosted agent.

pub mod crypto;
pub mod migrations;

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use agent_core::{
    authorization::{AuthorizationError, AuthorizationNonceStore},
    dag::ExecutionStep,
    runner::{ExecutionStore, RunnerError},
};
use async_trait::async_trait;
use rand::{RngExt, rngs::SysRng};
use rand_core::UnwrapErr;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

const NONCE_BYTES: usize = 12;

pub struct EncryptedStore {
    path: PathBuf,
    connection: Mutex<Connection>,
    key: Zeroizing<[u8; 32]>,
}

impl EncryptedStore {
    pub fn open(path: impl AsRef<Path>, key: [u8; 32]) -> Result<Self, rusqlite::Error> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| rusqlite::Error::InvalidPath(parent.to_path_buf()))?;
        }
        let connection = Connection::open(&path)?;
        connection.execute_batch(migrations::INITIAL_SCHEMA)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
            key: Zeroizing::new(key),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn save_subject(&self, request_id: &str, subject: &str) -> Result<(), StoreError> {
        if request_id.is_empty() {
            return Err(StoreError::InvalidInput);
        }
        let encrypted = self.encrypt(request_id.as_bytes(), subject.as_bytes())?;
        self.connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?
            .execute(
                "insert into encrypted_subjects (request_id, ciphertext)
                 values (?1, ?2)
                 on conflict(request_id) do update
                 set ciphertext = excluded.ciphertext,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                params![request_id, encrypted],
            )?;
        Ok(())
    }

    pub async fn load_subject(&self, request_id: &str) -> Result<Option<String>, StoreError> {
        let encrypted: Option<Vec<u8>> = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?
            .query_row(
                "select ciphertext from encrypted_subjects where request_id = ?1",
                params![request_id],
                |row| row.get(0),
            )
            .optional()?;
        encrypted
            .map(|bytes| {
                let mut plaintext = self.decrypt(request_id.as_bytes(), &bytes)?;
                let value = String::from_utf8(plaintext.to_vec())
                    .map_err(|_| StoreError::InvalidCiphertext);
                plaintext.zeroize();
                value
            })
            .transpose()
    }

    pub async fn save_execution_step(&self, step: &ExecutionStep) -> Result<(), StoreError> {
        let mut json = Zeroizing::new(serde_json::to_vec(step)?);
        let encrypted = self.encrypt(step.id.as_bytes(), &json)?;
        json.zeroize();
        self.connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?
            .execute(
                "insert into execution_steps (step_id, ciphertext)
                 values (?1, ?2)
                 on conflict(step_id) do update
                 set ciphertext = excluded.ciphertext,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
                params![step.id, encrypted],
            )?;
        Ok(())
    }

    pub async fn load_execution_step(
        &self,
        step_id: &str,
    ) -> Result<Option<ExecutionStep>, StoreError> {
        let encrypted: Option<Vec<u8>> = self
            .connection
            .lock()
            .map_err(|_| StoreError::LockPoisoned)?
            .query_row(
                "select ciphertext from execution_steps where step_id = ?1",
                params![step_id],
                |row| row.get(0),
            )
            .optional()?;
        encrypted
            .map(|bytes| {
                let mut plaintext = self.decrypt(step_id.as_bytes(), &bytes)?;
                let step = serde_json::from_slice(&plaintext).map_err(StoreError::Json);
                plaintext.zeroize();
                step
            })
            .transpose()
    }

    fn encrypt(&self, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, StoreError> {
        let cipher =
            Aes256Gcm::new_from_slice(&self.key[..]).map_err(|_| StoreError::InvalidCiphertext)?;
        let mut nonce = [0u8; NONCE_BYTES];
        UnwrapErr(SysRng).fill(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                &Nonce::try_from(&nonce[..]).map_err(|_| StoreError::InvalidCiphertext)?,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| StoreError::InvalidCiphertext)?;
        let mut output = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn decrypt(&self, aad: &[u8], ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>, StoreError> {
        if ciphertext.len() <= NONCE_BYTES {
            return Err(StoreError::InvalidCiphertext);
        }
        let cipher =
            Aes256Gcm::new_from_slice(&self.key[..]).map_err(|_| StoreError::InvalidCiphertext)?;
        cipher
            .decrypt(
                &Nonce::try_from(&ciphertext[..NONCE_BYTES])
                    .map_err(|_| StoreError::InvalidCiphertext)?,
                Payload {
                    msg: &ciphertext[NONCE_BYTES..],
                    aad,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| StoreError::InvalidCiphertext)
    }
}

impl AuthorizationNonceStore for EncryptedStore {
    fn consume_nonce(&mut self, nonce: &str, request_id: &str) -> Result<(), AuthorizationError> {
        let nonce_hash = Sha256::digest(nonce.as_bytes());
        let changed = self
            .connection
            .get_mut()
            .map_err(|_| AuthorizationError::InvalidClaims)?
            .execute(
                "insert or ignore into consumed_authorization_nonces (nonce_hash, request_id)
                 values (?1, ?2)",
                params![nonce_hash.as_slice(), request_id],
            )
            .map_err(|_| AuthorizationError::InvalidClaims)?;
        if changed == 0 {
            return Err(AuthorizationError::AuthorizationAlreadyConsumed);
        }
        Ok(())
    }
}

#[async_trait]
impl ExecutionStore for EncryptedStore {
    async fn step(&self, id: &str) -> Result<Option<ExecutionStep>, RunnerError> {
        self.load_execution_step(id)
            .await
            .map_err(|error| RunnerError::Store(error.to_string()))
    }

    async fn save_step(&self, step: &ExecutionStep) -> Result<(), RunnerError> {
        self.save_execution_step(step)
            .await
            .map_err(|error| RunnerError::Store(error.to_string()))
    }
}

#[derive(Debug)]
pub enum StoreError {
    Database(rusqlite::Error),
    Json(serde_json::Error),
    InvalidCiphertext,
    InvalidInput,
    LockPoisoned,
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Database(_) => "agent state database error",
            Self::Json(_) => "agent state serialization error",
            Self::InvalidCiphertext => "agent state authentication failed",
            Self::InvalidInput => "agent state input invalid",
            Self::LockPoisoned => "agent state lock poisoned",
        })
    }
}

impl std::error::Error for StoreError {}
