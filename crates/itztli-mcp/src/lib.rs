//! Itztli's MCP server: the tools an MCP client (an LLM) calls to read the
//! notes of the open vault and to propose changes to them, who may call
//! them, and the audit trail they leave. The transport
//! ([`McpServer::start`]: MCP's Streamable HTTP on loopback, with the
//! official SDK, rmcp) is a thin adapter that authenticates each request
//! into a [`Caller`] and calls the tools.
//!
//! What stands between a client and the notes, in order:
//! - **Token.** [`McpServer::authenticate`] looks the token's hash up in the
//!   store on every request, so revoking a client takes effect at once.
//! - **Grants.** A client sees and uses only the vaults the user granted it,
//!   re-read from the store on every call, and only the one that is open.
//! - **Notes only.** Tools reach what the index lists as notes: no
//!   attachments, nothing hidden (`.git`, `.itztli` with the plugins' code)
//!   and nothing outside the vault.
//! - **Approval.** A change is worked out, shown to the user in full, and
//!   made only if they approve it; never with a `read` grant. It is then made
//!   on the very revision they saw, or not at all. The user may let a client
//!   they trust go without, and only they can: its changes are then made at
//!   once, and audited as made without asking.
//! - **Local history.** What a change replaces can always be brought back.
//! - **Audit.** Every call leaves one row in the audit log, and its result
//!   never leaves Itztli without it.
//!
//! Who may change any of this is another matter: plugins run in the same
//! page as the UI, so what widens what programs outside Itztli may do is
//! asked by the host, in a dialog of the system's. See [`McpServer::change`].
//!
//! With the `bridge` feature, [`bridge`] is the other side: a stdio MCP
//! server for clients that only launch those (Claude Desktop), relaying
//! everything to this one over HTTP.

mod approvals;
#[cfg(feature = "bridge")]
pub mod bridge;
mod control;
mod handler;
mod http;
mod settings;
mod store;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
mod token;
mod tools;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use itztli_backend::Backend;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

pub use self::http::{MCP_PATH, ServerStatus, StartError};
pub use approvals::{Action, ApprovalRequest, Progress, Warning};
pub use control::{Change, Endpoint, Question};
pub use settings::{DEFAULT_PORT, MAX_RESULTS, McpSettings};
pub use store::{Access, AuditEntry, AuditFilter, Decision, Grant, McpClient, Store, Transport};
pub use token::{hash_token, new_token};
pub use tokio_util::sync::CancellationToken;
pub use tools::{
    AppendToNote, ChangeOutput, CreateNote, DeleteNote, DescribeNote, EditNote, INSTRUCTIONS, ListNotes, ListProblems, ListTags,
    ListTasks, ListVaults, ListVaultsOutput, MoveNote, ReadNote, ReplaceNote, SearchNotes, TextEdit,
};

use crate::approvals::Approvals;

/// How often a client's `last_seen_at` is written at most: every request
/// authenticates, and the store need not hear about each one.
const TOUCH_EVERY: Duration = Duration::from_secs(30);

/// What the server needs from the app around it.
pub trait Host: Send + Sync + 'static {
    fn backend(&self) -> &Backend;

    /// Something the UI shows happened. Called on the server's tasks, so it
    /// must not block.
    fn notify(&self, event: McpEvent);

    /// The executable that clients which only launch stdio servers run, as
    /// `<it> mcp-bridge`.
    fn bridge_command(&self) -> Option<String> {
        None
    }
}

/// What [`Host::notify`] reports, serialized for the UI as
/// `{"kind": "audit", ...}`, `{"kind": "approvalRequested", ...}`…
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpEvent {
    /// The server started or stopped listening, or failed to start.
    Status(ServerStatus),
    /// A tool call was recorded in the audit log.
    Audit(AuditEntry),
    /// A change waits for the user.
    ApprovalRequested(ApprovalRequest),
    /// An approval stopped waiting: answered, timed out or withdrawn.
    #[serde(rename_all = "camelCase")]
    ApprovalResolved { id: u64, decision: Decision },
    /// A client authenticated or called a tool; `at` is the `last_seen_at`
    /// just stored. Sent at most every 30 s per client.
    #[serde(rename_all = "camelCase")]
    ClientSeen { client_id: String, at: String },
}

/// Who calls a tool: the client its token authenticated, and what the
/// request itself says about it (unverified). The transport fills in the
/// unverified part; grants are never cached here, each call reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub client_id: String,
    /// As registered in Itztli.
    pub client_name: String,
    /// The `clientInfo` the client declared.
    pub client_info: Option<ClientInfo>,
    /// The MCP protocol version it speaks.
    pub protocol_version: Option<String>,
    pub transport: Transport,
    /// The legacy `Mcp-Session-Id`, or the bridge's instance id.
    pub session_key: Option<String>,
}

/// An MCP client's self-reported `clientInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: Option<String>,
}

/// A tool call that failed in a way the model can act on: the message says
/// what happened and what to do next. MCP returns it as a tool result with
/// `isError`, for the model to read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ToolError {
    pub message: String,
}

impl ToolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }
}

/// Something went wrong inside Itztli rather than with the call: the model
/// cannot fix it. MCP returns it as a JSON-RPC error.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Store(#[from] store::Error),
    #[error("invalid MCP settings: {0}")]
    InvalidSettings(String),
    #[error("{0}")]
    Internal(String),
}

/// How a tool call failed.
#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error(transparent)]
    Tool(#[from] ToolError),
    #[error(transparent)]
    Internal(#[from] Error),
}

impl From<store::Error> for CallError {
    fn from(e: store::Error) -> Self {
        Self::Internal(e.into())
    }
}

/// The MCP server's state, shared by every request. Cheap to clone.
#[derive(Clone)]
pub struct McpServer(Arc<Core>);

pub(crate) struct Core {
    store: Store,
    host: Arc<dyn Host>,
    approvals: Approvals,
    /// Held while something in who may do what changes; see [`control`].
    changing: tokio::sync::Mutex<()>,
    /// When each client was last written as seen, and what it declared.
    seen: Mutex<HashMap<String, Seen>>,
    /// The HTTP listener and its status.
    listener: http::Listener,
}

struct Seen {
    at: Instant,
    info: Option<ClientInfo>,
}

impl McpServer {
    pub fn new(store: Store, host: Arc<dyn Host>) -> Self {
        Self::with_approvals(store, host, Approvals::default())
    }

    /// A server whose waiting changes report progress every `every` rather
    /// than every 15 s, for tests.
    #[cfg(any(test, feature = "testing"))]
    pub fn with_progress_every(store: Store, host: Arc<dyn Host>, every: Duration) -> Self {
        Self::with_approvals(store, host, Approvals::new(every))
    }

    fn with_approvals(store: Store, host: Arc<dyn Host>, approvals: Approvals) -> Self {
        let listener = http::Listener::default();
        Self(Arc::new(Core { store, host, approvals, changing: Default::default(), seen: Mutex::default(), listener }))
    }

    pub fn store(&self) -> &Store {
        &self.0.store
    }

    /// The stored settings, defaults for what is missing.
    pub fn settings(&self) -> Result<McpSettings, Error> {
        self.0.settings()
    }

    /// The client `token` belongs to, or None when it is unknown or revoked.
    /// Looked up in the store every time, so a revoked token stops working
    /// at once. Marks the client seen (see [`McpEvent::ClientSeen`]).
    pub fn authenticate(&self, token: &str) -> Result<Option<Caller>, Error> {
        let Some(client) = self.0.store.client_by_token_hash(&hash_token(token))? else {
            return Ok(None);
        };
        self.0.seen(&client.id, None);
        Ok(Some(Caller {
            client_id: client.id,
            client_name: client.name,
            client_info: None,
            protocol_version: None,
            transport: Transport::Http,
            session_key: None,
        }))
    }

    /// Answers a pending approval. False when it is no longer pending (it was
    /// answered, timed out or withdrawn).
    pub fn answer_approval(&self, id: u64, approve: bool) -> bool {
        self.0.approvals.answer(id, approve)
    }

    /// Changes waiting for the user, oldest first.
    pub fn pending_approvals(&self) -> Vec<ApprovalRequest> {
        self.0.approvals.pending()
    }
}

impl Core {
    fn settings(&self) -> Result<McpSettings, Error> {
        Ok(settings::load(&self.store)?)
    }

    /// Records that a client was seen, at most every [`TOUCH_EVERY`], or
    /// sooner when it declares a different `clientInfo`. Best effort: a
    /// failure to record it never fails the request.
    fn seen(&self, client_id: &str, info: Option<&ClientInfo>) {
        let now = Instant::now();
        {
            let mut seen = lock(&self.seen);
            let last = seen.get(client_id);
            let due = last.is_none_or(|last| {
                now.duration_since(last.at) >= TOUCH_EVERY || info.is_some_and(|info| last.info.as_ref() != Some(info))
            });
            if !due {
                return;
            }
            let info = info.cloned().or_else(|| last.and_then(|last| last.info.clone()));
            seen.insert(client_id.to_owned(), Seen { at: now, info });
        }
        let (name, version) = info.map_or((None, None), |info| (Some(info.name.as_str()), info.version.as_deref()));
        if let Ok(Some(at)) = self.store.touch_client(client_id, name, version) {
            self.host.notify(McpEvent::ClientSeen { client_id: client_id.to_owned(), at });
        }
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
