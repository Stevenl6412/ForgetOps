use agent_core::redaction::{redact_text, sanitize_log_fields};
use std::collections::BTreeMap;

#[test]
fn removes_unapproved_fields_and_identifier_values() {
    let fields = BTreeMap::from([
        ("requestId".into(), "req_1".into()),
        ("email".into(), "canary@example.com".into()),
        ("accessToken".into(), "secret-canary".into()),
    ]);
    let sanitized = sanitize_log_fields(&fields);
    assert_eq!(
        sanitized,
        BTreeMap::from([("requestId".into(), "req_1".into())])
    );
    assert_eq!(redact_text("canary@example.com"), "<redacted>");
}
