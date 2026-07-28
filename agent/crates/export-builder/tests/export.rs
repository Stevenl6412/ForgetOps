use export_builder::{
    EncryptedArchiveWriter, ExportManifest, decrypt_chunk, safe_archive_path, unwrap_archive_key,
    wrap_archive_key,
};

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
    let public = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret));
    let archive_key = [3u8; 32];
    let wrapped = wrap_archive_key(&archive_key, public.as_bytes(), b"req_1").unwrap();
    assert_eq!(
        unwrap_archive_key(&wrapped, &secret, b"req_1").unwrap(),
        archive_key
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
