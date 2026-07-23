use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use agent_core::identity::{AgentIdentity, SIGNATURE_BYTES};
static TEST_ID: AtomicU64 = AtomicU64::new(0);

fn test_directory() -> PathBuf {
    let nonce = TEST_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "forgetops-agent-{}-{timestamp}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&directory).expect("create test directory");
    directory
}

fn remove_test_directory(directory: &PathBuf) {
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn identity_keys_and_signatures_have_protocol_lengths() {
    let identity = AgentIdentity::generate();
    let public = identity.public_keys();
    assert_eq!(public.signing_key().len(), 32);
    assert_eq!(public.encryption_key().len(), 32);

    let message = b"forgetops identity proof";
    let signature = identity.sign(message);
    assert_eq!(signature.len(), SIGNATURE_BYTES);
    assert!(AgentIdentity::verify_signature(
        &public.signing_key(),
        message,
        &signature
    ));

    let mut tampered = signature;
    tampered[0] ^= 1;
    assert!(!AgentIdentity::verify_signature(
        &public.signing_key(),
        message,
        &tampered
    ));
}

#[test]
fn x25519_identities_derive_the_same_shared_secret() {
    let alice = AgentIdentity::generate();
    let bob = AgentIdentity::generate();
    let alice_secret = alice.shared_secret(&bob.encryption_public_key());
    let bob_secret = bob.shared_secret(&alice.encryption_public_key());
    assert_eq!(alice_secret, bob_secret);
    assert_eq!(alice_secret.len(), 32);
}

#[test]
fn debug_output_redacts_all_private_material() {
    let identity = AgentIdentity::generate();
    let debug = format!("{identity:?}");

    assert!(debug.contains("signing_secret: \"<redacted>\""));
    assert!(debug.contains("encryption_secret: \"<redacted>\""));
    assert!(debug.contains("subject_hmac_key: \"<redacted>\""));
}

#[test]
fn private_files_are_create_new_and_never_overwritten() {
    let directory = test_directory();
    let first = AgentIdentity::generate();
    let paths = first
        .write_private_material(&directory)
        .expect("write first identity");
    let before = [
        fs::read(&paths.signing_key).expect("read signing key"),
        fs::read(&paths.encryption_key).expect("read encryption key"),
        fs::read(&paths.subject_hmac_key).expect("read subject key"),
    ];

    let second = AgentIdentity::generate();
    let error = second
        .write_private_material(&directory)
        .expect_err("second identity must not overwrite");
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);

    let after = [
        fs::read(&paths.signing_key).expect("read signing key"),
        fs::read(&paths.encryption_key).expect("read encryption key"),
        fs::read(&paths.subject_hmac_key).expect("read subject key"),
    ];
    assert_eq!(before, after);
    assert!(before.iter().all(|bytes| bytes.len() == 32));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [
            &paths.signing_key,
            &paths.encryption_key,
            &paths.subject_hmac_key,
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    remove_test_directory(&directory);
}
