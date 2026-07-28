use agent_core::authorization::{
    AuthorizationContext, AuthorizationError, verify_authorization, verify_execution_lease,
};
use agent_protocol::{
    ExecutionAuthorizationClaims, ExecutionLeaseClaims, signing::sign_domain_separated,
};
use base64::Engine as _;
use ed25519_dalek::SigningKey;

fn auth() -> ExecutionAuthorizationClaims {
    ExecutionAuthorizationClaims {
        r#type: "forgetops.execution-authorization".into(),
        version: 1,
        key_id: "ed25519:auth".into(),
        issuer: "forgetops-control-plane".into(),
        audience: "forgetops-agent".into(),
        environment_id: "env_1".into(),
        agent_id: "agent_1".into(),
        request_id: "req_1".into(),
        attempt_id: "att_1".into(),
        authorization_kind: "initial".into(),
        plan_id: "plan_1".into(),
        plan_version: 2,
        plan_fingerprint: "sha256:plan".into(),
        policy_version: 1,
        connector_configuration_fingerprint: "sha256:connector".into(),
        allowed_step_ids: vec!["step_1".into()],
        approval_evidence_hash: "sha256:evidence".into(),
        issued_at: "2026-07-24T00:00:00.000Z".into(),
        not_before: "2026-07-24T00:00:00.000Z".into(),
        expires_at: "2026-07-24T00:10:00.000Z".into(),
        nonce: "nonce_1234567890123456".into(),
    }
}

fn context() -> AuthorizationContext {
    AuthorizationContext {
        now: "2026-07-24T00:01:00.000Z".into(),
        request_id: "req_1".into(),
        environment_id: "env_1".into(),
        agent_id: "agent_1".into(),
        request_version: 7,
        plan_version: 2,
        plan_fingerprint: "sha256:plan".into(),
        connector_configuration_fingerprint: "sha256:connector".into(),
        policy_version: 1,
        allowed_step_ids: vec!["step_1".into()],
        agent_online: true,
        execution_paused: false,
    }
}

#[test]
fn verifies_exact_authorization_scope() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let claims = auth();
    let signature = sign_domain_separated(b"forgetops.execution-authorization.v1", &claims, &key)
        .expect("signature");
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature);
    let public_key =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());

    verify_authorization(&claims, &signature, &public_key, &context()).expect("valid auth");
}

#[test]
fn rejects_paused_or_expired_authorizations() {
    let key = SigningKey::from_bytes(&[8; 32]);
    let claims = auth();
    let signature = sign_domain_separated(b"forgetops.execution-authorization.v1", &claims, &key)
        .expect("signature");
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature);
    let public_key =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
    let mut paused = context();
    paused.execution_paused = true;
    assert_eq!(
        verify_authorization(&claims, &signature, &public_key, &paused),
        Err(AuthorizationError::ExecutionPaused)
    );
    let mut expired = context();
    expired.now = "2026-07-24T00:11:00.000Z".into();
    assert_eq!(
        verify_authorization(&claims, &signature, &public_key, &expired),
        Err(AuthorizationError::ClaimsExpired)
    );
}

#[test]
fn rejects_lease_longer_than_ninety_seconds() {
    let key = SigningKey::from_bytes(&[9; 32]);
    let authorization = auth();
    let lease = ExecutionLeaseClaims {
        r#type: "forgetops.execution-lease".into(),
        version: 1,
        key_id: "ed25519:lease".into(),
        environment_id: "env_1".into(),
        agent_id: "agent_1".into(),
        request_id: "req_1".into(),
        attempt_id: "att_1".into(),
        allowed_step_ids: vec!["step_1".into()],
        issued_at: "2026-07-24T00:00:00.000Z".into(),
        expires_at: "2026-07-24T00:02:00.000Z".into(),
        lease_id: "lease_1234567890123456".into(),
    };
    let signature =
        sign_domain_separated(b"forgetops.execution-lease.v1", &lease, &key).expect("signature");
    let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature);
    let public_key =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
    assert_eq!(
        verify_execution_lease(
            &lease,
            &signature,
            &public_key,
            &authorization,
            "2026-07-24T00:00:01.000Z",
        ),
        Err(AuthorizationError::InvalidClaims)
    );
}
