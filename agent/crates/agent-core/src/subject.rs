//! Versioned subject normalization. Raw identifiers stay in agent memory only.

use std::fmt;

use serde::Deserialize;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const CANONICALIZATION_VERSION: u32 = 1;

#[derive(Deserialize, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectIdentity {
    pub application_user_id: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubjectIdentifierKind {
    Email,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubjectIdentityError;

impl fmt::Display for SubjectIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SUBJECT_IDENTIFIER_REQUIRED")
    }
}

impl std::error::Error for SubjectIdentityError {}

pub fn canonical_identity(subject: &SubjectIdentity) -> Result<String, SubjectIdentityError> {
    if let Some(application_user_id) = non_empty(subject.application_user_id.as_deref()) {
        return Ok(format!("app_user_id:{application_user_id}"));
    }
    if let Some(email) = non_empty(subject.email.as_deref()) {
        return Ok(format!("email:{}", email.to_lowercase()));
    }
    Err(SubjectIdentityError)
}

pub fn canonical_aliases(
    subject: &SubjectIdentity,
) -> Result<Vec<(SubjectIdentifierKind, String)>, SubjectIdentityError> {
    canonical_identity(subject)?;
    let has_application_user_id = non_empty(subject.application_user_id.as_deref()).is_some();
    let email = non_empty(subject.email.as_deref());
    Ok(match (has_application_user_id, email) {
        (true, Some(email)) => vec![(
            SubjectIdentifierKind::Email,
            format!("email:{}", email.to_lowercase()),
        )],
        _ => Vec::new(),
    })
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
