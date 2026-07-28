use std::collections::HashMap;

pub trait ArchiveStorage {
    type Error;

    fn put(&mut self, object_key: &str, bytes: &[u8]) -> Result<(), Self::Error>;
    fn get(&self, object_key: &str) -> Result<Vec<u8>, Self::Error>;
}

#[derive(Default)]
pub struct MemoryArchiveStorage {
    objects: HashMap<String, Vec<u8>>,
}

impl ArchiveStorage for MemoryArchiveStorage {
    type Error = String;

    fn put(&mut self, object_key: &str, bytes: &[u8]) -> Result<(), Self::Error> {
        if object_key.is_empty() {
            return Err("OBJECT_KEY_REQUIRED".into());
        }
        self.objects.insert(object_key.to_owned(), bytes.to_vec());
        Ok(())
    }

    fn get(&self, object_key: &str) -> Result<Vec<u8>, Self::Error> {
        self.objects
            .get(object_key)
            .cloned()
            .ok_or_else(|| "OBJECT_NOT_FOUND".into())
    }
}
