use serde::Serialize;

/// Error returned by every command. `code` lets the UI react (for example,
/// offer to compare when a note changed on disk) without parsing messages.
#[derive(Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// No vault is open.
    NoVault,
    NotFound,
    Exists,
    /// The file changed on disk since it was read.
    Conflict,
    NotText,
    InvalidArgument,
    Io,
    Plugin,
    Network,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }
}

impl From<itztli_vault::Error> for CommandError {
    fn from(e: itztli_vault::Error) -> Self {
        use itztli_vault::Error as E;
        let code = match e {
            E::InvalidPath(_) | E::Outside(_) | E::MoveIntoItself => ErrorCode::InvalidArgument,
            E::NotFound(_) => ErrorCode::NotFound,
            E::Exists(_) => ErrorCode::Exists,
            E::Conflict(_) => ErrorCode::Conflict,
            E::NotText(_) => ErrorCode::NotText,
            E::Io { .. } | E::Trash { .. } => ErrorCode::Io,
        };
        Self::new(code, e.to_string())
    }
}

impl From<itztli_core::path::InvalidPath> for CommandError {
    fn from(e: itztli_core::path::InvalidPath) -> Self {
        Self::invalid(e.to_string())
    }
}

impl From<itztli_history::Error> for CommandError {
    fn from(e: itztli_history::Error) -> Self {
        Self::new(ErrorCode::Io, e.to_string())
    }
}

impl From<itztli_index::QueryError> for CommandError {
    fn from(e: itztli_index::QueryError) -> Self {
        Self::invalid(e.to_string())
    }
}

impl From<itztli_plugins::Error> for CommandError {
    fn from(e: itztli_plugins::Error) -> Self {
        Self::new(ErrorCode::Plugin, e.to_string())
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
