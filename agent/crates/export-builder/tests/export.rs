use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use export_builder::{
    ArchiveEncryptionError, EncryptedArchiveWriter, ExportManifest, WrappedArchiveKey,
    decrypt_chunk, safe_archive_path, unwrap_archive_key, wrap_archive_key,
};
use x25519_dalek::{PublicKey, StaticSecret};

const KEY_WRAP_CONTEXT: &[u8] = b"req_1\0portal_1\0browser_1\x002026-07-24T01:00:00.000Z";
const LEGACY_WRAP_CONTEXT: &[u8] = b"forgetops.export-key-wrap.v1\0";

fn manifest() -> ExportManifest {
    ExportManifest {
        format_version: "forgetops.export-manifest.v1".into(),
        request_id: "req_1".into(),
        generated_at: "2026-07-24T00:00:00.000Z".into(),
        connectors: Vec::new(),
        files: Vec::new(),
        archive_format: "forgetops.chunked-aead.v1".into(),
        chunk_bytes: 1024,
        plaintext_bytes: 0,
        ciphertext_sha256: "sha256:pending".into(),
    }
}

#[test]
fn rejects_traversal_and_encrypts_chunks() {
    assert!(safe_archive_path("../secret").is_err());
    assert!(safe_archive_path("/absolute").is_err());
    let key = [7u8; 32];
    let mut writer = EncryptedArchiveWriter::new(key, 1024, 1024, &manifest()).unwrap();
    writer.write_chunk(b"canary@example.com").unwrap();
    let archive = writer.finish();
    assert!(
        !archive
            .bytes
            .windows(18)
            .any(|window| window == b"canary@example.com")
    );
}

#[test]
fn wraps_and_unwraps_archive_key_for_recipient() {
    let secret = [9u8; 32];
    let public = PublicKey::from(&StaticSecret::from(secret));
    let archive_key = [3u8; 32];
    let wrapped = wrap_archive_key(&archive_key, public.as_bytes(), KEY_WRAP_CONTEXT).unwrap();
    assert_eq!(
        unwrap_archive_key(&wrapped, &secret, KEY_WRAP_CONTEXT).unwrap(),
        archive_key
    );
}

#[test]
fn rejects_non_contributory_recipient_and_ephemeral_keys() {
    let archive_key = [3u8; 32];
    assert_eq!(
        wrap_archive_key(&archive_key, &[0u8; 32], KEY_WRAP_CONTEXT),
        Err(ArchiveEncryptionError::InvalidKey)
    );

    let wrapped = WrappedArchiveKey {
        version: 1,
        ephemeral_public_key: [0u8; 32],
        nonce: [5u8; 24],
        ciphertext: vec![0u8; 48],
    };
    assert_eq!(
        unwrap_archive_key(&wrapped, &[9u8; 32], KEY_WRAP_CONTEXT),
        Err(ArchiveEncryptionError::InvalidKey)
    );
}

#[test]
fn rejects_wrong_key_wrap_context_and_tampering() {
    let secret = [9u8; 32];
    let public = PublicKey::from(&StaticSecret::from(secret));
    let archive_key = [3u8; 32];
    let wrapped = wrap_archive_key(&archive_key, public.as_bytes(), KEY_WRAP_CONTEXT).unwrap();

    assert_eq!(
        unwrap_archive_key(&wrapped, &secret, b"req_other"),
        Err(ArchiveEncryptionError::AuthenticationFailed)
    );

    let mut tampered = wrapped;
    tampered.ciphertext[0] ^= 1;
    assert_eq!(
        unwrap_archive_key(&tampered, &secret, KEY_WRAP_CONTEXT),
        Err(ArchiveEncryptionError::AuthenticationFailed)
    );
}

#[test]
fn rejects_legacy_raw_shared_secret_key_derivation() {
    let recipient_secret = [9u8; 32];
    let recipient_public = PublicKey::from(&StaticSecret::from(recipient_secret));
    let ephemeral_secret = StaticSecret::from([7u8; 32]);
    let ephemeral_public_key = PublicKey::from(&ephemeral_secret).to_bytes();
    let shared = ephemeral_secret.diffie_hellman(&recipient_public);
    let nonce = [5u8; 24];
    let aad = [LEGACY_WRAP_CONTEXT, KEY_WRAP_CONTEXT].concat();
    let ciphertext = XChaCha20Poly1305::new_from_slice(shared.as_bytes())
        .unwrap()
        .encrypt(
            &XNonce::try_from(&nonce[..]).unwrap(),
            Payload {
                msg: &[3u8; 32],
                aad: &aad,
            },
        )
        .unwrap();
    let legacy = WrappedArchiveKey {
        version: 1,
        ephemeral_public_key,
        nonce,
        ciphertext,
    };

    assert_eq!(
        unwrap_archive_key(&legacy, &recipient_secret, KEY_WRAP_CONTEXT),
        Err(ArchiveEncryptionError::AuthenticationFailed)
    );
}

#[test]
fn preserves_versioned_serialized_key_envelope_contract() {
    let wrapped = WrappedArchiveKey {
        version: 1,
        ephemeral_public_key: [7u8; 32],
        nonce: [5u8; 24],
        ciphertext: vec![3u8; 48],
    };

    let encoded = serde_json::to_value(&wrapped).unwrap();
    assert_eq!(encoded["version"], 1);
    assert_eq!(encoded["ephemeralPublicKey"].as_array().unwrap().len(), 32);
    assert_eq!(encoded["nonce"].as_array().unwrap().len(), 24);
    assert_eq!(encoded["ciphertext"].as_array().unwrap().len(), 48);
    assert!(encoded.get("ephemeral_public_key").is_none());
    assert_eq!(
        serde_json::from_value::<WrappedArchiveKey>(encoded).unwrap(),
        wrapped
    );
}

#[test]
fn decrypts_a_chunk_with_aad() {
    let key = [4u8; 32];
    let (nonce, ciphertext) =
        export_builder::encryption::encrypt_chunk(&key, b"payload", b"manifest").unwrap();
    let plaintext = decrypt_chunk(&key, &nonce, &ciphertext, b"manifest").unwrap();
    assert_eq!(&*plaintext, b"payload");
}
