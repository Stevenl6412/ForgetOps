use serde::Serialize;

pub fn canonical_json_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    serde_json_canonicalizer::to_vec(&serde_json::to_value(value)?)
}
