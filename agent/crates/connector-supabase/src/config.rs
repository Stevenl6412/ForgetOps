use std::collections::{BTreeMap, HashSet};

use connector_sdk::{ConnectorError, ProposedAction, SubjectIdentity};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupabaseMapping {
    #[serde(default)]
    pub tables: BTreeMap<String, TableMappingInput>,
    #[serde(default)]
    pub storage: BTreeMap<String, StorageMappingInput>,
    #[serde(default)]
    pub delete_auth_user: bool,
    #[serde(default)]
    pub approved_functions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TableMappingInput {
    #[serde(default = "default_schema")]
    pub schema: String,
    pub identity_column: String,
    #[serde(default)]
    pub subject_field: SubjectField,
    #[serde(default)]
    pub delete: bool,
    pub action: Option<TableAction>,
    #[serde(default)]
    pub fields: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageMappingInput {
    pub prefix: String,
    #[serde(default)]
    pub delete: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubjectField {
    #[default]
    ApplicationUserId,
    Email,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TableAction {
    Delete,
    Anonymize,
}

#[derive(Debug, Clone)]
pub struct ValidatedSupabaseMapping {
    pub tables: Vec<TableMapping>,
    pub storage: Vec<StorageMapping>,
    pub delete_auth_user: bool,
    pub approved_functions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TableMapping {
    pub schema: String,
    pub table: String,
    pub identity_column: String,
    pub subject_field: SubjectField,
    pub action: TableAction,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct StorageMapping {
    pub bucket: String,
    pub prefix: String,
}

impl SupabaseMapping {
    pub fn from_yaml(yaml: &str) -> Result<Self, ConnectorError> {
        serde_yaml_bw::from_str(yaml)
            .map_err(|_| ConnectorError::invalid_config("SUPABASE_MAPPING_YAML_INVALID"))
    }

    pub fn validate(self) -> Result<ValidatedSupabaseMapping, ConnectorError> {
        if self.tables.is_empty() && self.storage.is_empty() && !self.delete_auth_user {
            return Err(ConnectorError::invalid_config("SUPABASE_MAPPING_EMPTY"));
        }
        let mut tables = Vec::with_capacity(self.tables.len());
        for (table, input) in self.tables {
            validate_identifier(&input.schema)?;
            validate_identifier(&table)?;
            validate_identifier(&input.identity_column)?;
            let action = match (input.delete, input.action) {
                (true, None | Some(TableAction::Delete)) => TableAction::Delete,
                (false, Some(action)) => action,
                _ => {
                    return Err(ConnectorError::invalid_config(
                        "SUPABASE_TABLE_ACTION_INVALID",
                    ));
                }
            };
            if (action == TableAction::Delete && !input.fields.is_empty())
                || (action == TableAction::Anonymize
                    && (input.fields.is_empty() || !input.fields.contains(&input.identity_column)))
            {
                return Err(ConnectorError::invalid_config(
                    "SUPABASE_TABLE_FIELDS_INVALID",
                ));
            }
            let mut unique_fields = HashSet::new();
            for field in &input.fields {
                validate_identifier(field)?;
                if !unique_fields.insert(field.clone()) {
                    return Err(ConnectorError::invalid_config(
                        "SUPABASE_TABLE_FIELDS_INVALID",
                    ));
                }
            }
            tables.push(TableMapping {
                schema: input.schema,
                table,
                identity_column: input.identity_column,
                subject_field: input.subject_field,
                action,
                fields: input.fields,
            });
        }

        let mut storage = Vec::with_capacity(self.storage.len());
        for (bucket, input) in self.storage {
            validate_bucket(&bucket)?;
            if !input.delete || !valid_prefix_template(&input.prefix) {
                return Err(ConnectorError::invalid_config(
                    "SUPABASE_STORAGE_MAPPING_INVALID",
                ));
            }
            storage.push(StorageMapping {
                bucket,
                prefix: input.prefix,
            });
        }

        let mut approved_functions = HashSet::new();
        for function in self.approved_functions {
            validate_qualified_name(&function)?;
            if !approved_functions.insert(function) {
                return Err(ConnectorError::invalid_config(
                    "SUPABASE_APPROVED_FUNCTION_INVALID",
                ));
            }
        }
        Ok(ValidatedSupabaseMapping {
            tables,
            storage,
            delete_auth_user: self.delete_auth_user,
            approved_functions: approved_functions.into_iter().collect(),
        })
    }
}

impl TableMapping {
    pub fn qualified_name(&self) -> String {
        format!("{}.{}", self.schema, self.table)
    }

    pub fn quoted_name(&self) -> String {
        format!("\"{}\".\"{}\"", self.schema, self.table)
    }

    pub fn local_reference(&self) -> String {
        format!("supabase:table:{}", self.qualified_name())
    }

    pub fn proposed_action(&self) -> ProposedAction {
        match self.action {
            TableAction::Delete => ProposedAction::Delete,
            TableAction::Anonymize => ProposedAction::Anonymize,
        }
    }

    pub fn subject_value<'a>(
        &self,
        subject: &'a SubjectIdentity,
    ) -> Result<&'a str, ConnectorError> {
        match self.subject_field {
            SubjectField::ApplicationUserId => subject.application_user_id.as_deref(),
            SubjectField::Email => subject.email.as_deref(),
        }
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectorError::invalid_config("SUPABASE_SUBJECT_FIELD_REQUIRED"))
    }
}

impl StorageMapping {
    pub fn local_reference(&self) -> String {
        format!("supabase:storage:{}", self.bucket)
    }

    pub fn subject_prefix(&self, subject: &SubjectIdentity) -> Result<String, ConnectorError> {
        let user_id = stable_user_id(subject)?;
        Ok(self.prefix.replace("{user_id}", user_id))
    }
}

pub fn stable_user_id(subject: &SubjectIdentity) -> Result<&str, ConnectorError> {
    subject
        .application_user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ConnectorError::invalid_config("SUPABASE_STABLE_USER_ID_REQUIRED"))
}

pub fn quote_identifier(value: &str) -> String {
    debug_assert!(valid_identifier(value));
    format!("\"{value}\"")
}

fn validate_identifier(value: &str) -> Result<(), ConnectorError> {
    if valid_identifier(value) {
        Ok(())
    } else {
        Err(ConnectorError::invalid_config(
            "SUPABASE_IDENTIFIER_INVALID",
        ))
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with(|character: char| character.is_ascii_digit())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn validate_qualified_name(value: &str) -> Result<(), ConnectorError> {
    let segments: Vec<_> = value.split('.').collect();
    if segments.len() == 2 && segments.iter().all(|segment| valid_identifier(segment)) {
        Ok(())
    } else {
        Err(ConnectorError::invalid_config(
            "SUPABASE_APPROVED_FUNCTION_INVALID",
        ))
    }
}

fn validate_bucket(value: &str) -> Result<(), ConnectorError> {
    if !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        Ok(())
    } else {
        Err(ConnectorError::invalid_config("SUPABASE_BUCKET_INVALID"))
    }
}

fn valid_prefix_template(value: &str) -> bool {
    let path = value.strip_suffix('/').unwrap_or(value);
    value.matches("{user_id}").count() == 1
        && !path.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn default_schema() -> String {
    "public".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_identifiers_before_they_can_reach_dynamic_sql() {
        let mapping = SupabaseMapping::from_yaml(
            r#"
tables:
  "profiles; drop table profiles":
    identity_column: user_id
    delete: true
"#,
        )
        .unwrap();
        assert_eq!(
            mapping.validate().unwrap_err().code,
            "SUPABASE_IDENTIFIER_INVALID"
        );
    }

    #[test]
    fn accepts_the_documented_delete_anonymize_and_storage_shape() {
        let mapping = SupabaseMapping::from_yaml(
            r#"
tables:
  profiles:
    identity_column: user_id
    delete: true
  audit_events:
    identity_column: actor_user_id
    action: anonymize
    fields: [actor_user_id, actor_email]
storage:
  user-uploads:
    prefix: "users/{user_id}/"
    delete: true
"#,
        )
        .unwrap()
        .validate()
        .unwrap();
        assert_eq!(mapping.tables.len(), 2);
        assert_eq!(mapping.storage.len(), 1);
    }
}
