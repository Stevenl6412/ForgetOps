use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorExportSummary {
    pub connector: String,
    pub resource_count: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub format_version: String,
    pub request_id: String,
    pub generated_at: String,
    pub connectors: Vec<ConnectorExportSummary>,
    pub files: Vec<ExportFileEntry>,
    pub archive_format: String,
    pub chunk_bytes: u32,
    pub plaintext_bytes: u64,
    pub ciphertext_sha256: String,
}

impl ExportManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.format_version != "forgetops.export-manifest.v1"
            || self.archive_format != "forgetops.chunked-aead.v1"
            || self.request_id.is_empty()
            || self.chunk_bytes == 0
            || self.files.iter().any(|file| file.path.is_empty())
        {
            return Err("INVALID_EXPORT_MANIFEST");
        }
        Ok(())
    }
}
