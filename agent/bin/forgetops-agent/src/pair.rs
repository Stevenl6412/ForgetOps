use std::{fmt::Write as _, path::PathBuf};

use agent_core::{
    environment_secrets::EnvironmentSecrets,
    identity::{AgentIdentity, IDENTITY_FILE, IdentityError},
};
use agent_protocol::canonical_json::canonical_json_bytes;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};

const PAIRING_TOKEN_ENV: &str = "FORGETOPS_PAIRING_TOKEN";

pub fn usage() -> &'static str {
    "usage: forgetops-agent pair --data-dir <path> --state-master-key-file <path> --subject-hmac-key-file <path> --subject-hmac-key-version <u32> [--environment-id <id>] [--version <version>] [--protocol-version <version>]; provide FORGETOPS_PAIRING_TOKEN with --environment-id to emit a signed pairing request"
}

pub fn run(arguments: Vec<String>) -> Result<String, String> {
    let options = Options::parse(arguments)?;
    let pairing_token = std::env::var(PAIRING_TOKEN_ENV)
        .ok()
        .filter(|value| !value.is_empty());
    run_with(options, pairing_token)
}

fn run_with(options: Options, pairing_token: Option<String>) -> Result<String, String> {
    if pairing_token.is_some() != options.environment_id.is_some() {
        return Err(format!(
            "{PAIRING_TOKEN_ENV} and --environment-id must be provided together"
        ));
    }

    let secrets = EnvironmentSecrets::from_secret_files(
        &options.subject_hmac_key_file,
        options.subject_hmac_key_version,
        &options.state_master_key_file,
    )
    .map_err(|error| format!("cannot load environment secrets: {error}"))?;
    let identity_path = options.data_dir.join(IDENTITY_FILE);
    let identity = match AgentIdentity::read_encrypted(&identity_path, secrets.state_master_key()) {
        Ok(identity) => identity,
        Err(IdentityError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            let identity = AgentIdentity::generate();
            identity
                .write_new_encrypted(&identity_path, secrets.state_master_key())
                .map_err(|error| format!("cannot create encrypted identity: {error}"))?;
            identity
        }
        Err(error) => return Err(format!("cannot load encrypted identity: {error}")),
    };

    let public = PublicRegistration::from_identity(
        &identity,
        options.subject_hmac_key_version,
        options.version,
        options.protocol_version,
    );
    match (pairing_token, options.environment_id) {
        (Some(pairing_token), Some(environment_id)) => {
            let request = PairingRequest::new(&identity, pairing_token, environment_id, public)?;
            serde_json::to_string(&request)
                .map_err(|error| format!("cannot serialize pairing request: {error}"))
        }
        (None, None) => serde_json::to_string(&public)
            .map_err(|error| format!("cannot serialize public identity: {error}")),
        _ => unreachable!("pairing token and environment are validated together"),
    }
}

#[derive(Debug)]
struct Options {
    data_dir: PathBuf,
    state_master_key_file: PathBuf,
    subject_hmac_key_file: PathBuf,
    subject_hmac_key_version: u32,
    environment_id: Option<String>,
    version: String,
    protocol_version: String,
}

impl Options {
    fn parse(arguments: Vec<String>) -> Result<Self, String> {
        let mut data_dir = None;
        let mut state_master_key_file = None;
        let mut subject_hmac_key_file = None;
        let mut subject_hmac_key_version = None;
        let mut environment_id = None;
        let mut version = env!("CARGO_PKG_VERSION").to_owned();
        let mut protocol_version = "1.0".to_owned();
        let mut arguments = arguments.into_iter();

        while let Some(flag) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| format!("missing value for {flag}"))?;
            if value.is_empty() {
                return Err(format!("empty value for {flag}"));
            }
            match flag.as_str() {
                "--data-dir" => data_dir = Some(PathBuf::from(value)),
                "--state-master-key-file" => state_master_key_file = Some(PathBuf::from(value)),
                "--subject-hmac-key-file" => subject_hmac_key_file = Some(PathBuf::from(value)),
                "--subject-hmac-key-version" => {
                    let version = value.parse::<u32>().map_err(|_| {
                        "--subject-hmac-key-version must be a positive unsigned 32-bit integer"
                            .to_owned()
                    })?;
                    if version == 0 {
                        return Err(
                            "--subject-hmac-key-version must be a positive unsigned 32-bit integer"
                                .to_owned(),
                        );
                    }
                    subject_hmac_key_version = Some(version);
                }
                "--environment-id" => environment_id = Some(value),
                "--version" => version = value,
                "--protocol-version" => protocol_version = value,
                _ => return Err(format!("unknown option {flag}")),
            }
        }

        Ok(Self {
            data_dir: data_dir.ok_or_else(|| "--data-dir is required".to_owned())?,
            state_master_key_file: state_master_key_file
                .ok_or_else(|| "--state-master-key-file is required".to_owned())?,
            subject_hmac_key_file: subject_hmac_key_file
                .ok_or_else(|| "--subject-hmac-key-file is required".to_owned())?,
            subject_hmac_key_version: subject_hmac_key_version
                .ok_or_else(|| "--subject-hmac-key-version is required".to_owned())?,
            environment_id,
            version,
            protocol_version,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRegistration {
    public_signing_key: String,
    public_encryption_key: String,
    signing_key_id: String,
    encryption_key_id: String,
    subject_hmac_key_version: u32,
    version: String,
    protocol_version: String,
    instance_fingerprint: String,
}

impl PublicRegistration {
    fn from_identity(
        identity: &AgentIdentity,
        subject_hmac_key_version: u32,
        version: String,
        protocol_version: String,
    ) -> Self {
        let public_keys = identity.public_keys();
        let key_ids = identity.key_ids();
        let signing_key = public_keys.signing_key();
        let encryption_key = public_keys.encryption_key();
        let mut fingerprint_input = Vec::with_capacity(signing_key.len() + encryption_key.len());
        fingerprint_input.extend_from_slice(&signing_key);
        fingerprint_input.extend_from_slice(&encryption_key);

        Self {
            public_signing_key: URL_SAFE_NO_PAD.encode(signing_key),
            public_encryption_key: URL_SAFE_NO_PAD.encode(encryption_key),
            signing_key_id: key_ids.signing_key_id,
            encryption_key_id: key_ids.encryption_key_id,
            subject_hmac_key_version,
            version,
            protocol_version,
            instance_fingerprint: format!("sha256:{}", hex(&Sha256::digest(fingerprint_input))),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest {
    pairing_token: String,
    environment_id: String,
    public_signing_key: String,
    public_encryption_key: String,
    signing_key_id: String,
    encryption_key_id: String,
    subject_hmac_key_version: u32,
    version: String,
    protocol_version: String,
    instance_fingerprint: String,
    proof: String,
}

impl PairingRequest {
    fn new(
        identity: &AgentIdentity,
        pairing_token: String,
        environment_id: String,
        public: PublicRegistration,
    ) -> Result<Self, String> {
        let proof_payload = PairingProofPayload {
            environment_id: &environment_id,
            instance_fingerprint: &public.instance_fingerprint,
            pairing_token: &pairing_token,
            protocol_version: &public.protocol_version,
            public_encryption_key: &public.public_encryption_key,
            public_signing_key: &public.public_signing_key,
            encryption_key_id: &public.encryption_key_id,
            signing_key_id: &public.signing_key_id,
            subject_hmac_key_version: public.subject_hmac_key_version,
            version: &public.version,
        };
        let payload = canonical_proof_payload(&proof_payload)?;
        let proof = URL_SAFE_NO_PAD.encode(identity.sign(payload.as_bytes()));

        Ok(Self {
            pairing_token,
            environment_id,
            public_signing_key: public.public_signing_key,
            public_encryption_key: public.public_encryption_key,
            signing_key_id: public.signing_key_id,
            encryption_key_id: public.encryption_key_id,
            subject_hmac_key_version: public.subject_hmac_key_version,
            version: public.version,
            protocol_version: public.protocol_version,
            instance_fingerprint: public.instance_fingerprint,
            proof,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingProofPayload<'a> {
    environment_id: &'a str,
    instance_fingerprint: &'a str,
    pairing_token: &'a str,
    protocol_version: &'a str,
    public_encryption_key: &'a str,
    public_signing_key: &'a str,
    encryption_key_id: &'a str,
    signing_key_id: &'a str,
    subject_hmac_key_version: u32,
    version: &'a str,
}

fn canonical_proof_payload(payload: &PairingProofPayload<'_>) -> Result<String, String> {
    let bytes = canonical_json_bytes(payload)
        .map_err(|error| format!("cannot serialize pairing proof: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("pairing proof is not UTF-8: {error}"))
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn test_directory() -> PathBuf {
        let nonce = TEST_ID.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "forgetops-pair-{timestamp}-{nonce}-{}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn proof_payload_matches_the_typescript_field_order() {
        let payload = canonical_proof_payload(&PairingProofPayload {
            environment_id: "env_1",
            instance_fingerprint: "sha256:fingerprint",
            pairing_token: "token",
            protocol_version: "1.0",
            public_encryption_key: "encrypt",
            public_signing_key: "sign",
            encryption_key_id: "x25519:sha256:encrypt",
            signing_key_id: "ed25519:sha256:sign",
            subject_hmac_key_version: 7,
            version: "1.2.3",
        })
        .expect("serialize proof");

        assert_eq!(
            payload,
            r#"{"encryptionKeyId":"x25519:sha256:encrypt","environmentId":"env_1","instanceFingerprint":"sha256:fingerprint","pairingToken":"token","protocolVersion":"1.0","publicEncryptionKey":"encrypt","publicSigningKey":"sign","signingKeyId":"ed25519:sha256:sign","subjectHmacKeyVersion":7,"version":"1.2.3"}"#
        );
    }

    #[test]
    fn pairing_request_proof_verifies_with_the_generated_identity() {
        let identity = AgentIdentity::generate();
        let public =
            PublicRegistration::from_identity(&identity, 7, "1.2.3".to_owned(), "1.0".to_owned());
        let request =
            PairingRequest::new(&identity, "token".to_owned(), "env_1".to_owned(), public)
                .expect("build request");
        let payload = canonical_proof_payload(&PairingProofPayload {
            environment_id: &request.environment_id,
            instance_fingerprint: &request.instance_fingerprint,
            pairing_token: &request.pairing_token,
            protocol_version: &request.protocol_version,
            public_encryption_key: &request.public_encryption_key,
            public_signing_key: &request.public_signing_key,
            encryption_key_id: &request.encryption_key_id,
            signing_key_id: &request.signing_key_id,
            subject_hmac_key_version: request.subject_hmac_key_version,
            version: &request.version,
        })
        .expect("serialize proof");
        let signature: [u8; 64] = URL_SAFE_NO_PAD
            .decode(&request.proof)
            .expect("decode proof")
            .try_into()
            .expect("64-byte proof");
        let public_key: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&request.public_signing_key)
            .expect("decode key")
            .try_into()
            .expect("32-byte key");

        assert!(AgentIdentity::verify_signature(
            &public_key,
            payload.as_bytes(),
            &signature,
        ));
    }

    #[test]
    fn public_registration_omits_secrets_and_pairing_credentials() {
        let identity = AgentIdentity::generate();
        let public =
            PublicRegistration::from_identity(&identity, 7, "1.2.3".to_owned(), "1.0".to_owned());
        let value = serde_json::to_value(public).expect("serialize public identity");
        let object = value.as_object().expect("public identity object");

        assert_eq!(object.len(), 8);
        assert!(object.contains_key("publicSigningKey"));
        assert!(object.contains_key("publicEncryptionKey"));
        assert!(
            object["signingKeyId"]
                .as_str()
                .expect("signing key ID")
                .starts_with("ed25519:sha256:")
        );
        assert!(
            object["encryptionKeyId"]
                .as_str()
                .expect("encryption key ID")
                .starts_with("x25519:sha256:")
        );
        assert!(!object.contains_key("pairingToken"));
        assert!(!object.contains_key("proof"));
    }

    #[test]
    fn cli_requires_secret_paths_and_emits_only_public_registration_data() {
        assert!(Options::parse(vec!["--data-dir".to_owned(), "state".to_owned()]).is_err());
        assert!(
            Options::parse(vec![
                "--data-dir".to_owned(),
                "state".to_owned(),
                "--state-master-key-file".to_owned(),
                "master".to_owned(),
                "--subject-hmac-key-file".to_owned(),
                "subject".to_owned(),
                "--subject-hmac-key-version".to_owned(),
                "0".to_owned(),
            ])
            .is_err()
        );

        let directory = test_directory();
        let data_dir = directory.join("state");
        let subject = directory.join("subject");
        let master = directory.join("master");
        fs::write(&subject, [3u8; 32]).expect("write subject secret");
        fs::write(&master, [9u8; 32]).expect("write state master secret");
        let options = Options::parse(vec![
            "--data-dir".to_owned(),
            data_dir.display().to_string(),
            "--state-master-key-file".to_owned(),
            master.display().to_string(),
            "--subject-hmac-key-file".to_owned(),
            subject.display().to_string(),
            "--subject-hmac-key-version".to_owned(),
            "7".to_owned(),
        ])
        .expect("parse pairing options");

        let output = run_with(options, None).expect("emit public registration");
        let registration: serde_json::Value = serde_json::from_str(&output).expect("parse output");
        assert!(data_dir.join(IDENTITY_FILE).is_file());
        assert!(
            registration["signingKeyId"]
                .as_str()
                .expect("signing key ID")
                .starts_with("ed25519:sha256:")
        );
        assert!(
            registration["encryptionKeyId"]
                .as_str()
                .expect("encryption key ID")
                .starts_with("x25519:sha256:")
        );
        assert_eq!(registration["subjectHmacKeyVersion"], 7);
        assert!(!output.contains(&URL_SAFE_NO_PAD.encode([3u8; 32])));
        assert!(!output.contains(&URL_SAFE_NO_PAD.encode([9u8; 32])));

        let _ = fs::remove_dir_all(directory);
    }
}
