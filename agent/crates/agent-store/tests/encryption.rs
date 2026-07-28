use agent_store::EncryptedStore;

#[tokio::test]
async fn sqlite_file_does_not_contain_plaintext_subject() {
    let directory = tempfile::tempdir().expect("temporary state directory");
    let path = directory.path().join("state.db");
    let store = EncryptedStore::open(&path, [7u8; 32]).expect("open encrypted store");

    store
        .save_subject("req_1", "canary@example.com")
        .await
        .expect("save encrypted subject");

    let bytes = std::fs::read(store.path()).expect("read SQLite state");
    assert!(
        !bytes
            .windows(b"canary@example.com".len())
            .any(|window| window == b"canary@example.com")
    );
    assert_eq!(
        store.load_subject("req_1").await.expect("load subject"),
        Some("canary@example.com".to_owned())
    );
}
