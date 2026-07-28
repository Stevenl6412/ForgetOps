//! Signed, bounded HTTP transport for a private TypeScript lifecycle adapter.

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use connector_sdk::{
    Connector, ConnectorDescriptor, ConnectorError, ConnectorErrorKind, DiscoveryRequest,
    DiscoveryResult, ErasePlan, EraseResult, ExecutionContext, ExportResult, ExportSelection,
    ExportSink, HealthStatus, SubjectIdentity, VerificationExpectation, VerificationResult,
};
use futures_util::StreamExt;
use hmac::{Hmac, KeyInit, Mac};
use jiff::Timestamp;
use rand::RngExt;
use reqwest::{Client, Response, StatusCode, Url, header};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const SIGNATURE_DOMAIN: &[u8] = b"forgetops.adapter-request.v1";
const JSON_CONTENT_TYPE: &str = "application/json";
const EXPORT_CONTENT_TYPE: &str = "application/x-ndjson";
const DEFAULT_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES: usize = 256 * 1024;
const DEFAULT_MAX_EXPORT_BYTES: usize = 100 * 1024 * 1024;

pub struct AdapterHttpConnector {
    descriptor: ConnectorDescriptor,
    base_url: Url,
    secret: Zeroizing<Vec<u8>>,
    client: Client,
    max_response_bytes: usize,
    max_frame_bytes: usize,
    max_export_bytes: usize,
}

impl AdapterHttpConnector {
    pub fn new(
        base_url: &str,
        secret: Vec<u8>,
        descriptor: ConnectorDescriptor,
    ) -> Result<Self, ConnectorError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        descriptor.validate()?;
        if secret.len() < 32 {
            return Err(ConnectorError::invalid_config("ADAPTER_SECRET_INVALID"));
        }
        let base_url = Url::parse(base_url)
            .map_err(|_| ConnectorError::invalid_config("ADAPTER_URL_INVALID"))?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(ConnectorError::invalid_config("ADAPTER_URL_INVALID"));
        }
        Ok(Self {
            descriptor,
            base_url,
            secret: Zeroizing::new(secret),
            client: Client::new(),
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_export_bytes: DEFAULT_MAX_EXPORT_BYTES,
        })
    }

    pub fn with_limits(
        mut self,
        max_response_bytes: usize,
        max_frame_bytes: usize,
        max_export_bytes: usize,
    ) -> Result<Self, ConnectorError> {
        if max_response_bytes == 0 || max_frame_bytes == 0 || max_export_bytes == 0 {
            return Err(ConnectorError::invalid_config("ADAPTER_LIMIT_INVALID"));
        }
        self.max_response_bytes = max_response_bytes;
        self.max_frame_bytes = max_frame_bytes;
        self.max_export_bytes = max_export_bytes;
        Ok(self)
    }

    async fn post_json<T: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        path: &str,
        payload: &T,
        destructive: bool,
    ) -> Result<R, ConnectorError> {
        let response = self.send(path, payload, destructive).await?;
        let body = read_bounded(response, self.max_response_bytes).await?;
        serde_json::from_slice(&body)
            .map_err(|_| ConnectorError::invalid_response("ADAPTER_RESPONSE_INVALID"))
    }

    async fn send<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
        destructive: bool,
    ) -> Result<Response, ConnectorError> {
        let body = serde_json::to_vec(payload)
            .map_err(|_| ConnectorError::invalid_config("ADAPTER_REQUEST_INVALID"))?;
        if body.len() > self.max_response_bytes {
            return Err(ConnectorError::invalid_config("ADAPTER_REQUEST_TOO_LARGE"));
        }
        let timestamp = Timestamp::now().to_string();
        let mut nonce_bytes = [0u8; 24];
        rand::rng().fill(&mut nonce_bytes);
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
        let signature = sign_adapter_request(
            &self.secret,
            "POST",
            path,
            &timestamp,
            &nonce,
            JSON_CONTENT_TYPE,
            &body,
        )?;
        let url = self
            .base_url
            .join(path.trim_start_matches('/'))
            .map_err(|_| ConnectorError::invalid_config("ADAPTER_URL_INVALID"))?;
        let response = self
            .client
            .post(url)
            .header(header::CONTENT_TYPE, JSON_CONTENT_TYPE)
            .header("x-forgetops-timestamp", timestamp)
            .header("x-forgetops-nonce", nonce)
            .header("x-forgetops-signature", signature)
            .body(body)
            .send()
            .await
            .map_err(|_| {
                ConnectorError::remote(
                    if destructive {
                        ConnectorErrorKind::Uncertain
                    } else {
                        ConnectorErrorKind::Remote
                    },
                    "ADAPTER_REQUEST_FAILED",
                )
            })?;
        classify_status(response.status())?;
        Ok(response)
    }
}

#[async_trait]
impl Connector for AdapterHttpConnector {
    fn descriptor(&self) -> ConnectorDescriptor {
        self.descriptor.clone()
    }

    async fn health_check(&self) -> Result<HealthStatus, ConnectorError> {
        self.post_json("/forgetops/v1/health", &Empty {}, false)
            .await
    }

    async fn discover(
        &self,
        subject: &SubjectIdentity,
        request: &DiscoveryRequest,
    ) -> Result<DiscoveryResult, ConnectorError> {
        self.post_json(
            "/forgetops/v1/discover",
            &SubjectRequest {
                subject: AdapterSubject::from(subject),
                request,
            },
            false,
        )
        .await
    }

    async fn export(
        &self,
        subject: &SubjectIdentity,
        selection: &ExportSelection,
        sink: &mut dyn ExportSink,
    ) -> Result<ExportResult, ConnectorError> {
        let response = self
            .send(
                "/forgetops/v1/export",
                &ExportRequest {
                    subject: AdapterSubject::from(subject),
                    selection,
                },
                false,
            )
            .await?;
        if response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_none_or(|value| !value.starts_with(EXPORT_CONTENT_TYPE))
        {
            return Err(ConnectorError::invalid_response(
                "ADAPTER_EXPORT_CONTENT_TYPE_INVALID",
            ));
        }
        read_export_frames(response, sink, self.max_frame_bytes, self.max_export_bytes).await
    }

    async fn erase(
        &self,
        subject: &SubjectIdentity,
        plan: &ErasePlan,
        context: &ExecutionContext,
    ) -> Result<EraseResult, ConnectorError> {
        self.post_json(
            "/forgetops/v1/erase",
            &EraseRequest {
                subject: AdapterSubject::from(subject),
                resource: &plan.resource,
                plan,
                context,
            },
            true,
        )
        .await
    }

    async fn verify(
        &self,
        subject: &SubjectIdentity,
        expectation: &VerificationExpectation,
    ) -> Result<VerificationResult, ConnectorError> {
        self.post_json(
            "/forgetops/v1/verify",
            &VerifyRequest {
                subject: AdapterSubject::from(subject),
                resource: &expectation.resource,
                expectation,
            },
            false,
        )
        .await
    }
}

pub fn sign_adapter_request(
    secret: &[u8],
    method: &str,
    normalized_path: &str,
    timestamp: &str,
    nonce: &str,
    content_type: &str,
    body: &[u8],
) -> Result<String, ConnectorError> {
    if secret.len() < 32
        || method != method.to_ascii_uppercase()
        || !normalized_path.starts_with('/')
        || nonce.len() < 16
    {
        return Err(ConnectorError::invalid_config(
            "ADAPTER_SIGNATURE_INPUT_INVALID",
        ));
    }
    let envelope = SignatureEnvelope {
        body_digest: format!("sha256:{}", hex_digest(body)),
        content_type,
        method,
        nonce,
        path: normalized_path,
        timestamp,
        message_type: "forgetops.adapter-request",
        version: 1,
    };
    let canonical = serde_json_canonicalizer::to_vec(&envelope)
        .map_err(|_| ConnectorError::invalid_config("ADAPTER_SIGNATURE_CANONICALIZATION_FAILED"))?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)
        .map_err(|_| ConnectorError::invalid_config("ADAPTER_SECRET_INVALID"))?;
    mac.update(SIGNATURE_DOMAIN);
    mac.update(&[0]);
    mac.update(&canonical);
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

async fn read_bounded(response: Response, max_bytes: usize) -> Result<Vec<u8>, ConnectorError> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| ConnectorError::invalid_response("ADAPTER_RESPONSE_STREAM_FAILED"))?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ConnectorError::invalid_response(
                "ADAPTER_RESPONSE_TOO_LARGE",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_export_frames(
    response: Response,
    sink: &mut dyn ExportSink,
    max_frame_bytes: usize,
    max_export_bytes: usize,
) -> Result<ExportResult, ConnectorError> {
    let max_encoded_frame_bytes = max_frame_bytes.saturating_mul(2).saturating_add(1024);
    let mut buffer = Vec::new();
    let mut raw_total = 0usize;
    let mut completion = None;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| ConnectorError::invalid_response("ADAPTER_EXPORT_STREAM_FAILED"))?;
        if buffer.len().saturating_add(chunk.len()) > max_encoded_frame_bytes {
            return Err(ConnectorError::invalid_response(
                "ADAPTER_EXPORT_FRAME_TOO_LARGE",
            ));
        }
        buffer.extend_from_slice(&chunk);
        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            if line.len() <= 1 {
                return Err(ConnectorError::invalid_response(
                    "ADAPTER_EXPORT_FRAME_INVALID",
                ));
            }
            match serde_json::from_slice::<ExportFrame>(&line[..line.len() - 1])
                .map_err(|_| ConnectorError::invalid_response("ADAPTER_EXPORT_FRAME_INVALID"))?
            {
                ExportFrame::Data {
                    path,
                    content_type,
                    data,
                } => {
                    if completion.is_some() || !safe_export_path(&path) {
                        return Err(ConnectorError::invalid_response(
                            "ADAPTER_EXPORT_FRAME_INVALID",
                        ));
                    }
                    let decoded = URL_SAFE_NO_PAD.decode(&data).map_err(|_| {
                        ConnectorError::invalid_response("ADAPTER_EXPORT_FRAME_INVALID")
                    })?;
                    if decoded.len() > max_frame_bytes
                        || URL_SAFE_NO_PAD.encode(&decoded) != data
                        || raw_total.saturating_add(decoded.len()) > max_export_bytes
                    {
                        return Err(ConnectorError::invalid_response("ADAPTER_EXPORT_TOO_LARGE"));
                    }
                    raw_total += decoded.len();
                    sink.write(&path, &content_type, &decoded).await?;
                }
                ExportFrame::Complete { exported_count } => {
                    if completion.replace(exported_count).is_some() {
                        return Err(ConnectorError::invalid_response(
                            "ADAPTER_EXPORT_FRAME_INVALID",
                        ));
                    }
                }
                ExportFrame::Error { _code: _ } => {
                    return Err(ConnectorError::remote(
                        ConnectorErrorKind::Remote,
                        "ADAPTER_EXPORT_FAILED",
                    ));
                }
            }
        }
    }
    if !buffer.is_empty() {
        return Err(ConnectorError::invalid_response(
            "ADAPTER_EXPORT_FRAME_INCOMPLETE",
        ));
    }
    completion
        .map(|exported_count| ExportResult { exported_count })
        .ok_or_else(|| ConnectorError::invalid_response("ADAPTER_EXPORT_COMPLETION_MISSING"))
}

fn classify_status(status: StatusCode) -> Result<(), ConnectorError> {
    if status.is_success() {
        return Ok(());
    }
    let kind = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ConnectorErrorKind::PermissionDenied,
        StatusCode::TOO_MANY_REQUESTS => ConnectorErrorKind::RateLimited,
        StatusCode::NOT_IMPLEMENTED => ConnectorErrorKind::Unsupported,
        status if status.is_server_error() => ConnectorErrorKind::Remote,
        _ => ConnectorErrorKind::InvalidResponse,
    };
    Err(ConnectorError::remote(kind, "ADAPTER_HTTP_ERROR"))
}

fn safe_export_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureEnvelope<'a> {
    body_digest: String,
    content_type: &'a str,
    method: &'a str,
    nonce: &'a str,
    path: &'a str,
    timestamp: &'a str,
    #[serde(rename = "type")]
    message_type: &'a str,
    version: u8,
}

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterSubject<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
}

impl<'a> From<&'a SubjectIdentity> for AdapterSubject<'a> {
    fn from(subject: &'a SubjectIdentity) -> Self {
        Self {
            user_id: subject.application_user_id.as_deref(),
            email: subject.email.as_deref(),
        }
    }
}

#[derive(Serialize)]
struct SubjectRequest<'a> {
    subject: AdapterSubject<'a>,
    request: &'a DiscoveryRequest,
}

#[derive(Serialize)]
struct ExportRequest<'a> {
    subject: AdapterSubject<'a>,
    selection: &'a ExportSelection,
}

#[derive(Serialize)]
struct EraseRequest<'a> {
    subject: AdapterSubject<'a>,
    resource: &'a str,
    plan: &'a ErasePlan,
    context: &'a ExecutionContext,
}

#[derive(Serialize)]
struct VerifyRequest<'a> {
    subject: AdapterSubject<'a>,
    resource: &'a str,
    expectation: &'a VerificationExpectation,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ExportFrame {
    Data {
        path: String,
        #[serde(rename = "contentType")]
        content_type: String,
        data: String,
    },
    Complete {
        #[serde(rename = "exportedCount")]
        exported_count: u64,
    },
    Error {
        #[serde(rename = "code")]
        _code: String,
    },
}
