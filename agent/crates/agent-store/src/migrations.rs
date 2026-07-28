pub const INITIAL_SCHEMA: &str = r#"
pragma journal_mode = wal;
pragma synchronous = full;

create table if not exists encrypted_subjects (
  request_id text primary key,
  ciphertext blob not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists execution_steps (
  step_id text primary key,
  ciphertext blob not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists consumed_authorization_nonces (
  nonce_hash blob primary key,
  request_id text not null,
  consumed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
"#;
