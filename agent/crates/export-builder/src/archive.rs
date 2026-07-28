use crate::{
    encryption::{ARCHIVE_KEY_BYTES, ArchiveEncryptionError, encrypt_chunk},
    manifest::ExportManifest,
};
use std::{
    io,
    path::{Component, Path, PathBuf},
};

pub const MAX_ARCHIVE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const DEFAULT_CHUNK_BYTES: usize = 1024 * 1024;
const MAGIC: &[u8] = b"FOPSEX01";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedArchive {
    pub bytes: Vec<u8>,
    pub plaintext_bytes: u64,
    pub chunks: u32,
}

pub struct EncryptedArchiveWriter {
    key: [u8; ARCHIVE_KEY_BYTES],
    max_bytes: u64,
    chunk_bytes: usize,
    manifest_aad: Vec<u8>,
    output: Vec<u8>,
    plaintext_bytes: u64,
    chunks: u32,
}

impl EncryptedArchiveWriter {
    pub fn new(
        key: [u8; ARCHIVE_KEY_BYTES],
        max_bytes: u64,
        chunk_bytes: usize,
        manifest: &ExportManifest,
    ) -> Result<Self, &'static str> {
        manifest.validate()?;
        if chunk_bytes == 0 || chunk_bytes > 16 * 1024 * 1024 {
            return Err("INVALID_CHUNK_SIZE");
        }
        let manifest_aad = serde_json::to_vec(manifest).map_err(|_| "INVALID_EXPORT_MANIFEST")?;
        let mut output = Vec::with_capacity(MAGIC.len() + 4);
        output.extend_from_slice(MAGIC);
        output.extend_from_slice(&(manifest_aad.len() as u32).to_be_bytes());
        output.extend_from_slice(&manifest_aad);
        Ok(Self {
            key,
            max_bytes,
            chunk_bytes,
            manifest_aad,
            output,
            plaintext_bytes: 0,
            chunks: 0,
        })
    }

    pub fn write_chunk(&mut self, plaintext: &[u8]) -> Result<(), ArchiveEncryptionError> {
        if plaintext.len() > self.chunk_bytes {
            return Err(ArchiveEncryptionError::ChunkTooLarge);
        }
        let next = self
            .plaintext_bytes
            .checked_add(plaintext.len() as u64)
            .ok_or(ArchiveEncryptionError::ChunkTooLarge)?;
        if next > self.max_bytes {
            return Err(ArchiveEncryptionError::ChunkTooLarge);
        }
        let aad = [&self.manifest_aad[..], &self.chunks.to_be_bytes()[..]].concat();
        let (nonce, ciphertext) = encrypt_chunk(&self.key, plaintext, &aad)?;
        self.output
            .extend_from_slice(&(plaintext.len() as u32).to_be_bytes());
        self.output.extend_from_slice(&nonce);
        self.output
            .extend_from_slice(&(ciphertext.len() as u32).to_be_bytes());
        self.output.extend_from_slice(&ciphertext);
        self.plaintext_bytes = next;
        self.chunks = self.chunks.saturating_add(1);
        Ok(())
    }

    pub fn finish(self) -> EncryptedArchive {
        EncryptedArchive {
            bytes: self.output,
            plaintext_bytes: self.plaintext_bytes,
            chunks: self.chunks,
        }
    }
}

pub fn safe_archive_path(path: &str) -> io::Result<PathBuf> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "UNSAFE_EXPORT_PATH",
        ));
    }
    Ok(candidate.to_path_buf())
}
