use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use agent_core::{
    environment_secrets::EnvironmentSecrets,
    identity::{AgentIdentity, IDENTITY_FILE, IdentityError, SIGNATURE_BYTES},
};

static TEST_ID: AtomicU64 = AtomicU64::new(0);

fn test_directory() -> PathBuf {
    let nonce = TEST_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock before epoch")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "forgetops-agent-{timestamp}-{nonce}-{}",
        std::process::id()
    ));
    fs::create_dir(&directory).expect("create test directory");
    directory
}

fn write_secret(directory: &Path, name: &str, byte: u8) -> PathBuf {
    let path = directory.join(name);
    fs::write(&path, [byte; 32]).expect("write test secret");
    path
}

fn environment_secrets(directory: &Path, master_byte: u8) -> EnvironmentSecrets {
    let subject = write_secret(directory, "subject-hmac-key", 3);
    let master = write_secret(directory, "state-master-key", master_byte);
    EnvironmentSecrets::from_secret_files(&subject, 7, &master).expect("load secrets")
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
fn debug_output_redacts_private_material() {
    let debug = format!("{:?}", AgentIdentity::generate());

    assert!(debug.contains("signing_secret: \"<redacted>\""));
    assert!(debug.contains("encryption_secret: \"<redacted>\""));
}

#[test]
fn encrypted_identity_blob_round_trips_without_raw_private_keys() {
    let directory = test_directory();
    let secrets = environment_secrets(&directory, 9);
    let path = directory.join(IDENTITY_FILE);
    let identity = AgentIdentity::generate();

    identity
        .write_new_encrypted(&path, secrets.state_master_key())
        .expect("write encrypted identity");
    let blob = fs::read(&path).expect("read encrypted blob");

    assert_ne!(blob.len(), 64);

    let restored = AgentIdentity::read_encrypted(&path, secrets.state_master_key())
        .expect("decrypt encrypted identity");
    assert_eq!(identity.public_keys(), restored.public_keys());
    assert_eq!(identity.key_ids(), restored.key_ids());

    let _ = fs::remove_dir_all(directory);
}

#[test]
fn encrypted_identity_uses_create_new_and_unix_0600() {
    let directory = test_directory();
    let secrets = environment_secrets(&directory, 9);
    let path = directory.join(IDENTITY_FILE);

    AgentIdentity::generate()
        .write_new_encrypted(&path, secrets.state_master_key())
        .expect("write first identity");
    let before = fs::read(&path).expect("read first blob");
    let error = AgentIdentity::generate()
        .write_new_encrypted(&path, secrets.state_master_key())
        .expect_err("second identity must not overwrite");
    assert!(
        matches!(error, IdentityError::Io(ref error) if error.kind() == std::io::ErrorKind::AlreadyExists)
    );
    assert_eq!(before, fs::read(&path).expect("read preserved blob"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let _ = fs::remove_dir_all(directory);
}

#[test]
fn encrypted_identity_rejects_tampering_and_wrong_master_key() {
    let directory = test_directory();
    let secrets = environment_secrets(&directory, 9);
    let path = directory.join(IDENTITY_FILE);
    AgentIdentity::generate()
        .write_new_encrypted(&path, secrets.state_master_key())
        .expect("write encrypted identity");

    let original = fs::read(&path).expect("read blob");
    let mut tampered = original.clone();
    *tampered.last_mut().expect("blob has ciphertext") ^= 1;
    fs::write(&path, tampered).expect("write tampered blob");
    assert!(matches!(
        AgentIdentity::read_encrypted(&path, secrets.state_master_key()),
        Err(IdentityError::AuthenticationFailed)
    ));

    let mut bad_magic = original.clone();
    bad_magic[0] ^= 1;
    fs::write(&path, bad_magic).expect("write bad magic blob");
    assert!(matches!(
        AgentIdentity::read_encrypted(&path, secrets.state_master_key()),
        Err(IdentityError::InvalidBlob("bad magic"))
    ));

    let mut bad_version = original.clone();
    bad_version[8] = 2;
    fs::write(&path, bad_version).expect("write bad version blob");
    assert!(matches!(
        AgentIdentity::read_encrypted(&path, secrets.state_master_key()),
        Err(IdentityError::InvalidBlob("unsupported version"))
    ));

    fs::write(&path, &original[..original.len() - 1]).expect("write truncated blob");
    assert!(matches!(
        AgentIdentity::read_encrypted(&path, secrets.state_master_key()),
        Err(IdentityError::InvalidBlob("unexpected length"))
    ));

    AgentIdentity::generate()
        .write_new_encrypted(directory.join("other.bin"), secrets.state_master_key())
        .expect("write another encrypted identity");
    let wrong_directory = test_directory();
    let wrong = environment_secrets(&wrong_directory, 10);
    assert!(matches!(
        AgentIdentity::read_encrypted(directory.join("other.bin"), wrong.state_master_key()),
        Err(IdentityError::AuthenticationFailed)
    ));

    let _ = fs::remove_dir_all(directory);
    let _ = fs::remove_dir_all(wrong_directory);
}

#[test]
fn environment_subject_hmac_survives_agent_replacement_with_stable_version() {
    let directory = test_directory();
    let secrets = environment_secrets(&directory, 9);
    let old_identity = AgentIdentity::generate();
    let replacement_identity = AgentIdentity::generate();

    assert_ne!(old_identity.key_ids(), replacement_identity.key_ids());
    let first = secrets.subject_hash("email:canary@example.com");
    let second = secrets.subject_hash("email:canary@example.com");
    assert_eq!(first, second);
    assert_eq!(first.key_version, 7);
    assert!(first.value.starts_with("hmac-sha256:"));

    let _ = fs::remove_dir_all(directory);
}

#[test]
fn environment_secret_files_require_positive_version_and_exact_lengths() {
    let directory = test_directory();
    let subject = directory.join("subject-hmac-key");
    let master = directory.join("state-master-key");
    fs::write(&subject, [3u8; 31]).expect("write short subject key");
    fs::write(&master, [9u8; 32]).expect("write master key");
    assert!(matches!(
        EnvironmentSecrets::from_secret_files(&subject, 1, &master),
        Err(
            agent_core::environment_secrets::EnvironmentSecretError::InvalidLength {
                secret: "environment subject-HMAC key",
                length: 31
            }
        )
    ));
    fs::write(&subject, [3u8; 32]).expect("write subject key");
    assert!(matches!(
        EnvironmentSecrets::from_secret_files(&subject, 0, &master),
        Err(agent_core::environment_secrets::EnvironmentSecretError::InvalidVersion)
    ));
    let _ = fs::remove_dir_all(directory);
}
