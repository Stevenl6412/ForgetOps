use agent_core::{
    environment_secrets::subject_hash,
    subject::{
        CANONICALIZATION_VERSION, SubjectIdentifierKind, SubjectIdentity, canonical_aliases,
        canonical_identity,
    },
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectFixture {
    canonicalization_version: u32,
    cases: Vec<SubjectFixtureCase>,
}

#[derive(Deserialize)]
struct SubjectFixtureCase {
    identity: SubjectIdentity,
    primary: String,
    aliases: Vec<SubjectAliasFixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubjectAliasFixture {
    identifier_kind: String,
    canonical: String,
}

#[test]
fn canonicalization_matches_the_cross_language_fixture() {
    let fixture: SubjectFixture = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/contracts/fixtures/subject-identities.json"
    )))
    .expect("parse subject fixture");

    assert_eq!(fixture.canonicalization_version, CANONICALIZATION_VERSION);
    for case in fixture.cases {
        assert_eq!(canonical_identity(&case.identity).unwrap(), case.primary);
        let aliases = canonical_aliases(&case.identity).unwrap();
        assert_eq!(aliases.len(), case.aliases.len());
        for ((kind, canonical), expected) in aliases.iter().zip(case.aliases) {
            assert_eq!(*kind, SubjectIdentifierKind::Email);
            assert_eq!(expected.identifier_kind, "email");
            assert_eq!(*canonical, expected.canonical);
        }
    }
}

#[test]
fn application_user_id_is_primary_and_email_is_an_explicit_alias() {
    let subject = SubjectIdentity {
        application_user_id: Some("  Customer-42  ".into()),
        email: Some("  Canary@Example.COM  ".into()),
    };

    assert_eq!(
        canonical_identity(&subject).expect("canonical primary identity"),
        "app_user_id:Customer-42",
    );
    assert_eq!(
        canonical_aliases(&subject).expect("canonical aliases"),
        vec![(
            SubjectIdentifierKind::Email,
            "email:canary@example.com".into()
        )],
    );
}

#[test]
fn email_is_canonicalized_only_when_no_stable_application_id_exists() {
    let subject = SubjectIdentity {
        application_user_id: None,
        email: Some("  Canary@Example.COM  ".into()),
    };

    assert_eq!(
        canonical_identity(&subject).expect("canonical identity"),
        "email:canary@example.com",
    );
    assert!(canonical_aliases(&subject).unwrap().is_empty());
}

#[test]
fn blank_identifiers_are_rejected() {
    let subject = SubjectIdentity {
        application_user_id: Some(" \t ".into()),
        email: Some("\r\n".into()),
    };

    assert_eq!(
        canonical_identity(&subject).unwrap_err().to_string(),
        "SUBJECT_IDENTIFIER_REQUIRED",
    );
}

#[test]
fn subject_hash_is_stable_and_versioned() {
    let binding = subject_hash(&[0x0b; 32], 7, "email:canary@example.com").expect("subject hash");

    assert_eq!(
        binding.value,
        "hmac-sha256:7aefdd9792182154eca0bd4dea907e1ee81801c921176f30cbb48069fa8f9472",
    );
    assert_eq!(binding.key_version, 7);
    assert_eq!(binding.canonicalization_version, CANONICALIZATION_VERSION,);
    assert!(subject_hash(&[0x0b; 32], 0, "email:canary@example.com").is_err());
}
