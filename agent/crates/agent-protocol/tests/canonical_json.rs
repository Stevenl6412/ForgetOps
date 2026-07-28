use agent_protocol::canonical_json::canonical_json_bytes;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingProof<'a> {
    signing_key_id: &'a str,
    subject_hmac_key_version: u32,
    environment_id: &'a str,
}

#[test]
fn canonicalizes_pairing_proof_with_sorted_rfc8785_keys() {
    let bytes = canonical_json_bytes(&PairingProof {
        signing_key_id: "ed25519:sha256:key",
        subject_hmac_key_version: 7,
        environment_id: "env_1",
    })
    .expect("proof should canonicalize");

    assert_eq!(
        String::from_utf8(bytes).expect("canonical JSON is UTF-8"),
        r#"{"environmentId":"env_1","signingKeyId":"ed25519:sha256:key","subjectHmacKeyVersion":7}"#,
    );
}
