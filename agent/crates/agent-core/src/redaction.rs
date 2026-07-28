use std::collections::{BTreeMap, HashSet};

pub fn sanitize_log_fields(fields: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let allowed: HashSet<&str> = [
        "requestId",
        "environmentId",
        "agentId",
        "attemptId",
        "jobId",
        "status",
        "action",
        "errorCode",
        "durationMs",
        "count",
    ]
    .into_iter()
    .collect();
    fields
        .iter()
        .filter(|(key, _)| allowed.contains(key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn redact_text(value: &str) -> String {
    if value.contains('@') || value.len() > 256 {
        "<redacted>".into()
    } else {
        value.into()
    }
}
