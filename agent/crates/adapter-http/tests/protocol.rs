use adapter_http::{AdapterHttpConnector, sign_adapter_request};
use async_trait::async_trait;
use connector_sdk::{
    Connector, ConnectorCapability, ConnectorDescriptor, ConnectorError, ExportSelection,
    ExportSink, SubjectIdentity,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn signature_matches_the_typescript_adapter_vector() {
    let signature = sign_adapter_request(
        b"ssssssssssssssssssssssssssssssss",
        "POST",
        "/forgetops/v1/erase",
        "2026-07-24T08:00:00.000Z",
        "abcdefghijklmnopqrstuvwx",
        "application/json",
        br#"{"subject":{"userId":"user_target"}}"#,
    )
    .unwrap();
    assert_eq!(signature, "OpPY8KLDUiwV4hwXy8TWCxw02J6iNFHNjWkWHIcDGXw");
}

#[tokio::test]
async fn streams_bounded_export_frames_into_the_agent_sink() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = vec![0u8; 4096];
        let read = socket.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.starts_with("POST /forgetops/v1/export HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-forgetops-signature:")
        );

        let body = concat!(
            "{\"type\":\"data\",\"path\":\"documents/records.json\",",
            "\"contentType\":\"application/json\",\"data\":\"aGVsbG8\"}\n",
            "{\"type\":\"complete\",\"exportedCount\":1}\n"
        );
        let response = format!(
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "content-type: application/x-ndjson\r\n",
                "content-length: {}\r\n",
                "connection: close\r\n\r\n{}"
            ),
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });

    let connector = AdapterHttpConnector::new(
        &format!("http://{address}/"),
        vec![b's'; 32],
        ConnectorDescriptor {
            name: "custom".into(),
            version: "1".into(),
            capabilities: vec![ConnectorCapability::Discover, ConnectorCapability::Export],
        },
    )
    .unwrap();
    let subject = SubjectIdentity {
        application_user_id: Some("user_target".into()),
        email: None,
    };
    let mut sink = MemorySink::default();
    let result = connector
        .export(
            &subject,
            &ExportSelection {
                resources: vec!["documents".into()],
            },
            &mut sink,
        )
        .await
        .unwrap();

    assert_eq!(result.exported_count, 1);
    assert_eq!(
        sink.files,
        vec![(
            "documents/records.json".into(),
            "application/json".into(),
            b"hello".to_vec()
        )]
    );
    server.await.unwrap();
}

#[derive(Default)]
struct MemorySink {
    files: Vec<(String, String, Vec<u8>)>,
}

#[async_trait]
impl ExportSink for MemorySink {
    async fn write(
        &mut self,
        path: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> Result<(), ConnectorError> {
        self.files
            .push((path.into(), content_type.into(), bytes.to_vec()));
        Ok(())
    }
}
