use agent_protocol::{
    AgentMessage,
    signing::{canonical_unsigned_bytes, sign_message, verify_message},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use serde::Deserialize;

const FIXTURES: &str = "../../../packages/contracts/fixtures";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedFixture {
    public_key: String,
    canonical_bytes: String,
    message: AgentMessage,
}

#[test]
fn rust_signing_matches_the_agent_fixture_and_canonical_bytes() {
    let fixture = load_fixture("signed-agent-message.json");
    let expected_canonical = URL_SAFE_NO_PAD
        .decode(&fixture.canonical_bytes)
        .expect("canonical bytes should be base64url");
    assert_eq!(
        canonical_unsigned_bytes(&fixture.message).expect("message should canonicalize"),
        expected_canonical
    );

    let mut seed = [0_u8; 32];
    for (index, byte) in seed.iter_mut().enumerate() {
        *byte = u8::try_from(index + 1).expect("fixture seed byte should fit");
    }
    let signing_key = SigningKey::from_bytes(&seed);
    assert_eq!(
        URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes()),
        fixture.public_key
    );

    let mut signed = fixture.message.clone();
    sign_message(&mut signed, &signing_key).expect("fixture should sign");
    assert_eq!(signed.signature, fixture.message.signature);
}

#[test]
fn verifies_typescript_control_fixture_and_rejects_tampering() {
    let fixture = load_fixture("signed-control-message.json");
    let expected_canonical = URL_SAFE_NO_PAD
        .decode(&fixture.canonical_bytes)
        .expect("canonical bytes should be base64url");
    assert_eq!(
        canonical_unsigned_bytes(&fixture.message).expect("message should canonicalize"),
        expected_canonical
    );
    verify_message(&fixture.message, &fixture.public_key).expect("fixture should verify");

    let mut tampered = fixture.message;
    tampered.sequence = "12".to_owned();
    assert!(verify_message(&tampered, &fixture.public_key).is_err());
}

fn load_fixture(name: &str) -> SignedFixture {
    let contents = std::fs::read_to_string(format!("{FIXTURES}/{name}"))
        .expect("signed message fixture should exist");
    serde_json::from_str(&contents).expect("signed message fixture should deserialize")
}
