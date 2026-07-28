use agent_protocol::{
    ExecutionAuthorizationClaims, ExecutionLeaseClaims, signing::canonical_json_bytes,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::{collections::HashSet, error::Error, fmt};

const AUTHORIZATION_CONTEXT: &[u8] = b"forgetops.execution-authorization.v1";
const LEASE_CONTEXT: &[u8] = b"forgetops.execution-lease.v1";

#[derive(Debug, Clone)]
pub struct AuthorizationContext {
    pub now: String,
    pub request_id: String,
    pub environment_id: String,
    pub agent_id: String,
    pub request_version: u32,
    pub plan_version: u32,
    pub plan_fingerprint: String,
    pub connector_configuration_fingerprint: String,
    pub policy_version: u32,
    pub allowed_step_ids: Vec<String>,
    pub agent_online: bool,
    pub execution_paused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationError {
    InvalidPublicKey,
    InvalidSignature,
    SignatureVerificationFailed,
    InvalidClaims,
    ClaimsExpired,
    ClaimsNotYetValid,
    RequestVersionMismatch,
    PlanVersionMismatch,
    ScopeViolation,
    AgentUnavailable,
    ExecutionPaused,
    AuthorizationAlreadyConsumed,
}

impl fmt::Display for AuthorizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPublicKey => "invalid authorization public key",
            Self::InvalidSignature => "invalid authorization signature",
            Self::SignatureVerificationFailed => "authorization signature verification failed",
            Self::InvalidClaims => "authorization claims are invalid",
            Self::ClaimsExpired => "authorization claims are expired",
            Self::ClaimsNotYetValid => "authorization claims are not yet valid",
            Self::RequestVersionMismatch => "authorization request version mismatch",
            Self::PlanVersionMismatch => "authorization plan version mismatch",
            Self::ScopeViolation => "authorization step scope violation",
            Self::AgentUnavailable => "agent is not online",
            Self::ExecutionPaused => "execution is globally paused",
            Self::AuthorizationAlreadyConsumed => "authorization nonce already consumed",
        })
    }
}

impl Error for AuthorizationError {}

pub fn verify_authorization(
    claims: &ExecutionAuthorizationClaims,
    signature: &str,
    public_key: &str,
    context: &AuthorizationContext,
) -> Result<(), AuthorizationError> {
    verify_signed_value(AUTHORIZATION_CONTEXT, claims, signature, public_key)?;
    if claims.r#type != "forgetops.execution-authorization"
        || claims.version != 1
        || claims.issuer != "forgetops-control-plane"
        || claims.audience != "forgetops-agent"
        || claims.request_id != context.request_id
        || claims.environment_id != context.environment_id
        || claims.agent_id != context.agent_id
    {
        // The request version is intentionally carried by the local context,
        // not by the immutable authorization contract.
        return Err(AuthorizationError::InvalidClaims);
    }
    if claims.plan_version != context.plan_version
        || claims.plan_fingerprint != context.plan_fingerprint
        || claims.connector_configuration_fingerprint != context.connector_configuration_fingerprint
        || claims.policy_version != context.policy_version
    {
        return Err(AuthorizationError::PlanVersionMismatch);
    }
    if claims.allowed_step_ids.is_empty()
        || claims
            .allowed_step_ids
            .iter()
            .any(|step| !context.allowed_step_ids.contains(step))
        || duplicate_ids(&claims.allowed_step_ids)
    {
        return Err(AuthorizationError::ScopeViolation);
    }
    if context.execution_paused {
        return Err(AuthorizationError::ExecutionPaused);
    }
    if !context.agent_online {
        return Err(AuthorizationError::AgentUnavailable);
    }
    let now = parse_rfc3339(&context.now).ok_or(AuthorizationError::InvalidClaims)?;
    let not_before = parse_rfc3339(&claims.not_before).ok_or(AuthorizationError::InvalidClaims)?;
    let expires_at = parse_rfc3339(&claims.expires_at).ok_or(AuthorizationError::InvalidClaims)?;
    if expires_at <= not_before {
        return Err(AuthorizationError::InvalidClaims);
    }
    if now < not_before {
        return Err(AuthorizationError::ClaimsNotYetValid);
    }
    if now >= expires_at {
        return Err(AuthorizationError::ClaimsExpired);
    }
    Ok(())
}

pub fn verify_execution_lease(
    claims: &ExecutionLeaseClaims,
    signature: &str,
    public_key: &str,
    authorization: &ExecutionAuthorizationClaims,
    now: &str,
) -> Result<(), AuthorizationError> {
    verify_signed_value(LEASE_CONTEXT, claims, signature, public_key)?;
    if claims.r#type != "forgetops.execution-lease"
        || claims.version != 1
        || claims.environment_id != authorization.environment_id
        || claims.agent_id != authorization.agent_id
        || claims.request_id != authorization.request_id
        || claims.attempt_id != authorization.attempt_id
        || claims.allowed_step_ids.is_empty()
        || claims
            .allowed_step_ids
            .iter()
            .any(|step| !authorization.allowed_step_ids.contains(step))
        || duplicate_ids(&claims.allowed_step_ids)
    {
        return Err(AuthorizationError::ScopeViolation);
    }
    let issued_at = parse_rfc3339(&claims.issued_at).ok_or(AuthorizationError::InvalidClaims)?;
    let expires_at = parse_rfc3339(&claims.expires_at).ok_or(AuthorizationError::InvalidClaims)?;
    if expires_at <= issued_at || expires_at - issued_at > 90_000_000_000 {
        return Err(AuthorizationError::InvalidClaims);
    }
    let current = parse_rfc3339(now).ok_or(AuthorizationError::InvalidClaims)?;
    if current >= expires_at {
        return Err(AuthorizationError::ClaimsExpired);
    }
    Ok(())
}

pub trait AuthorizationNonceStore {
    fn consume_nonce(&mut self, nonce: &str, request_id: &str) -> Result<(), AuthorizationError>;
}

pub fn consume_authorization_nonce<S: AuthorizationNonceStore>(
    store: &mut S,
    claims: &ExecutionAuthorizationClaims,
) -> Result<(), AuthorizationError> {
    store.consume_nonce(&claims.nonce, &claims.request_id)
}

fn verify_signed_value<T: serde::Serialize>(
    context: &[u8],
    value: &T,
    signature: &str,
    public_key: &str,
) -> Result<(), AuthorizationError> {
    let public_key = decode_url(public_key).ok_or(AuthorizationError::InvalidPublicKey)?;
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| AuthorizationError::InvalidPublicKey)?;
    let key =
        VerifyingKey::from_bytes(&public_key).map_err(|_| AuthorizationError::InvalidPublicKey)?;
    let signature = decode_url(signature).ok_or(AuthorizationError::InvalidSignature)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| AuthorizationError::InvalidSignature)?;
    let canonical = canonical_json_bytes(value).map_err(|_| AuthorizationError::InvalidClaims)?;
    let mut material = Vec::with_capacity(context.len() + 1 + canonical.len());
    material.extend_from_slice(context);
    material.push(0);
    material.extend_from_slice(&canonical);
    key.verify(&material, &Signature::from_bytes(&signature))
        .map_err(|_| AuthorizationError::SignatureVerificationFailed)
}

fn decode_url(value: &str) -> Option<Vec<u8>> {
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    (URL_SAFE_NO_PAD.encode(&decoded) == value).then_some(decoded)
}

fn duplicate_ids(ids: &[String]) -> bool {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.iter().any(|id| !seen.insert(id))
}

// Nanoseconds since the Unix epoch. This intentionally accepts only the
// canonical UTC/RFC3339 forms emitted by the contracts.
fn parse_rfc3339(value: &str) -> Option<i128> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i128 = date_parts.next()?.parse().ok()?;
    let month: i128 = date_parts.next()?.parse().ok()?;
    let day: i128 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i128 = time_parts.next()?.parse().ok()?;
    let minute: i128 = time_parts.next()?.parse().ok()?;
    let seconds = time_parts.next()?;
    let (second_text, fraction_text) = seconds
        .split_once('.')
        .map_or((seconds, ""), |(second, fraction)| (second, fraction));
    let second: i128 = second_text.parse().ok()?;
    if fraction_text.len() > 9 || !fraction_text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let nanos: i128 = if fraction_text.is_empty() {
        0
    } else {
        fraction_text.parse::<i128>().ok()? * 10_i128.pow((9 - fraction_text.len()) as u32)
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let (adjusted_year, adjusted_month) = if month <= 2 {
        (year - 1, month + 12)
    } else {
        (year, month)
    };
    let days = 365 * adjusted_year + adjusted_year / 4 - adjusted_year / 100
        + adjusted_year / 400
        + (153 * (adjusted_month - 3) + 2) / 5
        + day
        - 1
        - 719468;
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1_000_000_000 + nanos)
}
