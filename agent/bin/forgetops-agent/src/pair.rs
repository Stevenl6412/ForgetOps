use std::{fmt::Write as _, path::PathBuf};

use agent_core::identity::AgentIdentity;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};

const PAIRING_TOKEN_ENV: &str = "FORGETOPS_PAIRING_TOKEN";

pub fn usage() -> &'static str {
    "usage: forgetops-agent pair --data-dir <path> [--environment-id <id>] [--version <version>] [--protocol-version <version>]; provide FORGETOPS_PAIRING_TOKEN with --environment-id to emit a signed pairing request"
}

pub fn run(arguments: Vec<String>) -> Result<String, String> {
    let options = Options::parse(arguments)?;
    let pairing_token = std::env::var(PAIRING_TOKEN_ENV)
        .ok()
        .filter(|value| !value.is_empty());
    if pairing_token.is_some() != options.environment_id.is_some() {
        return Err(format!(
            "{PAIRING_TOKEN_ENV} and --environment-id must be provided together"
        ));
    }

    let identity = AgentIdentity::generate();
    identity
        .write_private_material(&options.data_dir)
        .map_err(|error| format!("cannot create identity files: {error}"))?;

    let public =
        PublicRegistration::from_identity(&identity, options.version, options.protocol_version);
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
    environment_id: Option<String>,
    version: String,
    protocol_version: String,
}

impl Options {
    fn parse(arguments: Vec<String>) -> Result<Self, String> {
        let mut data_dir = None;
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
                "--environment-id" => environment_id = Some(value),
                "--version" => version = value,
                "--protocol-version" => protocol_version = value,
                _ => return Err(format!("unknown option {flag}")),
            }
        }

        Ok(Self {
            data_dir: data_dir.ok_or_else(|| "--data-dir is required".to_owned())?,
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
    version: String,
    protocol_version: String,
    instance_fingerprint: String,
}

impl PublicRegistration {
    fn from_identity(identity: &AgentIdentity, version: String, protocol_version: String) -> Self {
        let public_keys = identity.public_keys();
        let signing_key = public_keys.signing_key();
        let encryption_key = public_keys.encryption_key();
        let mut fingerprint_input = Vec::with_capacity(signing_key.len() + encryption_key.len());
        fingerprint_input.extend_from_slice(&signing_key);
        fingerprint_input.extend_from_slice(&encryption_key);

        Self {
            public_signing_key: URL_SAFE_NO_PAD.encode(signing_key),
            public_encryption_key: URL_SAFE_NO_PAD.encode(encryption_key),
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
        let payload = canonical_proof_payload(
            &environment_id,
            &public.instance_fingerprint,
            &pairing_token,
            &public.protocol_version,
            &public.public_encryption_key,
            &public.public_signing_key,
            &public.version,
        )?;
        let proof = URL_SAFE_NO_PAD.encode(identity.sign(payload.as_bytes()));

        Ok(Self {
            pairing_token,
            environment_id,
            public_signing_key: public.public_signing_key,
            public_encryption_key: public.public_encryption_key,
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
    version: &'a str,
}

fn canonical_proof_payload(
    environment_id: &str,
    instance_fingerprint: &str,
    pairing_token: &str,
    protocol_version: &str,
    public_encryption_key: &str,
    public_signing_key: &str,
    version: &str,
) -> Result<String, String> {
    serde_json::to_string(&PairingProofPayload {
        environment_id,
        instance_fingerprint,
        pairing_token,
        protocol_version,
        public_encryption_key,
        public_signing_key,
        version,
    })
    .map_err(|error| format!("cannot serialize pairing proof: {error}"))
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

    #[test]
    fn proof_payload_matches_the_typescript_field_order() {
        let payload = canonical_proof_payload(
            "env_1",
            "sha256:fingerprint",
            "token",
            "1.0",
            "encrypt",
            "sign",
            "1.2.3",
        )
        .expect("serialize proof");

        assert_eq!(
            payload,
            r#"{"environmentId":"env_1","instanceFingerprint":"sha256:fingerprint","pairingToken":"token","protocolVersion":"1.0","publicEncryptionKey":"encrypt","publicSigningKey":"sign","version":"1.2.3"}"#
        );
    }

    #[test]
    fn pairing_request_proof_verifies_with_the_generated_identity() {
        let identity = AgentIdentity::generate();
        let public =
            PublicRegistration::from_identity(&identity, "1.2.3".to_owned(), "1.0".to_owned());
        let request =
            PairingRequest::new(&identity, "token".to_owned(), "env_1".to_owned(), public)
                .expect("build request");
        let payload = canonical_proof_payload(
            &request.environment_id,
            &request.instance_fingerprint,
            &request.pairing_token,
            &request.protocol_version,
            &request.public_encryption_key,
            &request.public_signing_key,
            &request.version,
        )
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
            PublicRegistration::from_identity(&identity, "1.2.3".to_owned(), "1.0".to_owned());
        let value = serde_json::to_value(public).expect("serialize public identity");
        let object = value.as_object().expect("public identity object");

        assert_eq!(object.len(), 5);
        assert!(object.contains_key("publicSigningKey"));
        assert!(object.contains_key("publicEncryptionKey"));
        assert!(!object.contains_key("pairingToken"));
        assert!(!object.contains_key("proof"));
    }
}
