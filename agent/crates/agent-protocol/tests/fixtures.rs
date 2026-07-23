use agent_protocol::{AgentMessage, ExecutionAuthorizationClaims, PrivacyRequestStatus};

const FIXTURES: &str = "../../../packages/contracts/fixtures";

#[test]
fn deserializes_sanitized_planning_job_fixture_with_camel_case_fields() {
    let fixture = std::fs::read_to_string(format!("{FIXTURES}/agent-job-plan.json"))
        .expect("agent job plan fixture should exist");
    let message: AgentMessage = serde_json::from_str(&fixture).expect("fixture should deserialize");

    assert_eq!(message.protocol_version, "1.0");
    assert_eq!(message.message_type, "job.available");
    assert_eq!(message.payload["kind"], "plan");
    assert_eq!(message.payload["planVersion"], 3);
    assert_eq!(
        message.payload["planProjection"]["planFingerprint"],
        "sha256:plan-v3-sanitized"
    );
    assert_eq!(
        message.payload["planProjection"]["steps"][0]["action"],
        "delete"
    );
}

#[test]
fn deserializes_execution_authorization_fixture_with_camel_case_fields() {
    let fixture = std::fs::read_to_string(format!("{FIXTURES}/execution-authorization.json"))
        .expect("execution authorization fixture should exist");
    let authorization: ExecutionAuthorizationClaims =
        serde_json::from_str(&fixture).expect("fixture should deserialize");

    assert_eq!(authorization.environment_id, "env_01demo");
    assert_eq!(authorization.plan_version, 3);
    assert_eq!(authorization.plan_fingerprint, "sha256:plan-v3-sanitized");
}

#[test]
fn privacy_request_status_uses_snake_case_wire_values() {
    let status: PrivacyRequestStatus =
        serde_json::from_str("\"awaiting_approval\"").expect("status should deserialize");

    assert_eq!(status, PrivacyRequestStatus::AwaitingApproval);
}
