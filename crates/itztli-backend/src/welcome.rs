//! The notes a new vault may start with: a tour that is itself a vault.

use itztli_vault::{Error, Vault};

use crate::error::CommandResult;

const NOTES: &[(&str, &str)] = &[
    ("Welcome.md", include_str!("../welcome/Welcome.md")),
    ("Guide/Linking.md", include_str!("../welcome/Linking.md")),
    ("Guide/Keyboard.md", include_str!("../welcome/Keyboard.md")),
    ("Guide/Formatting.md", include_str!("../welcome/Formatting.md")),
    ("Guide/Plugins.md", include_str!("../welcome/Plugins.md")),
    ("Templates/Meeting.md", include_str!("../welcome/Meeting.md")),
];

/// Never overwrites: a note already there stays as it is.
pub fn write(vault: &Vault) -> CommandResult<()> {
    for (path, text) in NOTES {
        match vault.create(path, text.as_bytes()) {
            Ok(()) | Err(Error::Exists(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
