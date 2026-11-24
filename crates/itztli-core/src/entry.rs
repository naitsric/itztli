use serde::Serialize;

/// A file or folder of the vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub folder: bool,
    pub size: u64,
    /// Milliseconds since the epoch.
    pub modified: u64,
}
