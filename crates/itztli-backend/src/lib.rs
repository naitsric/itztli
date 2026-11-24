//! Everything behind the UI, independent of the window it runs in: the Tauri
//! app and the development server are two thin hosts over [`Backend::call`].
//!
//! What widens what the UI may do (opening a folder it never opened, running
//! a plugin, loading images from the web) is *not* a command. Plugins share
//! the UI's powers, so those are separate methods a host calls only after
//! asking the user in a dialog of its own.

mod commands;
mod error;
pub mod net;
mod state;
mod welcome;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use itztli_history::History;
use itztli_plugins::{PluginInfo, Plugins, VaultPlugins};
use itztli_vault::Vault;
use serde_json::{Value, json};

pub use error::{CommandError, CommandResult, ErrorCode};
pub use state::{Recent, State};
use workspace::lock;
pub use workspace::{Change, IndexStatus, NoteTask, Origin, Usages, VaultInfo, Workspace};

/// Names of the events the UI listens to.
pub mod event {
    pub const VAULT_CHANGED: &str = "vault-changed";
    pub const INDEX_READY: &str = "index-ready";
    pub const PLUGINS_CHANGED: &str = "plugins-changed";
    pub const CONFIG_CHANGED: &str = "config-changed";
    /// What the MCP server (crates/itztli-mcp) reports.
    pub const MCP: &str = "mcp";
    /// Something went wrong that nobody was waiting for.
    pub const WARNING: &str = "warning";
}

/// Text that names itself (a plugin, an MCP client, a folder), for a dialog
/// that asks about it: it must not be able to imitate the dialog.
pub fn printable(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(80).collect()
}

/// Where events go: to the window, or to the development server's clients.
pub trait Events: Send + Sync {
    fn emit(&self, name: &'static str, payload: Value);
}

pub struct Backend {
    state: State,
    plugins: Plugins,
    history: Arc<History>,
    events: Arc<dyn Events>,
    open: RwLock<Option<Arc<Workspace>>>,
    /// Opening a vault replaces the one before; never two at once.
    opening: Mutex<()>,
    trash_folder: Option<PathBuf>,
    safe_mode: bool,
}

impl Backend {
    /// `data` is the app's data folder.
    pub fn new(data: &Path, events: Arc<dyn Events>) -> std::io::Result<Self> {
        std::fs::create_dir_all(data)?;
        let history = match History::open(&data.join("history.db")) {
            Ok(history) => history,
            // Notes matter more than their past: work without it.
            Err(e) => {
                events.emit(event::WARNING, json!({ "message": e.to_string() }));
                History::in_memory().map_err(std::io::Error::other)?
            }
        };
        if let Err(e) = history.prune(workspace::now_ms()) {
            events.emit(event::WARNING, json!({ "message": e.to_string() }));
        }
        Ok(Self {
            state: State::open(data),
            plugins: Plugins::open(data),
            history: Arc::new(history),
            events,
            open: RwLock::default(),
            opening: Mutex::default(),
            trash_folder: None,
            safe_mode: false,
        })
    }

    /// Runs no plugins at all.
    pub fn with_safe_mode(self, safe_mode: bool) -> Self {
        Self { safe_mode, ..self }
    }

    /// Deleted files go to a folder instead of the system trash.
    pub fn with_trash_folder(self, folder: PathBuf) -> Self {
        Self { trash_folder: Some(folder), ..self }
    }

    pub fn plugins(&self) -> &Plugins {
        &self.plugins
    }

    pub fn safe_mode(&self) -> bool {
        self.safe_mode
    }

    pub fn workspace(&self) -> CommandResult<Arc<Workspace>> {
        self.current().ok_or_else(|| CommandError::new(ErrorCode::NoVault, "no vault is open"))
    }

    fn current(&self) -> Option<Arc<Workspace>> {
        self.open.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn vault_plugins(&self) -> Option<VaultPlugins> {
        self.current().map(|w| w.plugins())
    }

    /// Opens a folder the user picked as a vault.
    pub fn open_vault(&self, folder: &Path) -> CommandResult<VaultInfo> {
        let _opening = lock(&self.opening);
        let mut vault = Vault::open(folder)?;
        if let Some(trash) = &self.trash_folder {
            vault = vault.with_trash_folder(trash.clone());
        }
        self.close_vault();
        let workspace = Workspace::open(vault, self.history.clone(), self.events.clone());
        let info = workspace.info.clone();
        *self.open.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(workspace);
        let (id, name, path) = (info.id.clone(), info.name.clone(), info.path.clone());
        if let Err(e) = self.state.remember(Recent { id, name, path, opened_at: workspace::now_ms() }) {
            self.events.emit(event::WARNING, json!({ "message": format!("cannot remember this vault: {e}") }));
        }
        Ok(info)
    }

    /// The vaults the user opened, the last one first.
    pub fn recents(&self) -> Vec<Recent> {
        self.state.recents()
    }

    /// Opens a vault the user opened before, the only ones a command may ask for.
    fn open_recent(&self, id: &str) -> CommandResult<VaultInfo> {
        let recent = self.state.recents().into_iter().find(|r| r.id == id);
        let recent = recent.ok_or_else(|| CommandError::new(ErrorCode::NotFound, "that vault is not in the list"))?;
        self.open_vault(&recent.path)
    }

    /// Writes a few notes to look around, in a folder the user picked.
    pub fn write_welcome(&self, folder: &Path) -> CommandResult<()> {
        welcome::write(&Vault::open(folder)?)
    }

    pub fn close_vault(&self) {
        let open = self.open.write().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(workspace) = open {
            workspace.close();
            self.plugins.unload_all();
        }
    }

    /// The plugin as it is now, to describe it when asking the user.
    pub fn plugin(&self, id: &str) -> CommandResult<PluginInfo> {
        Ok(self.plugins.get(id, self.vault_plugins().as_ref())?)
    }

    /// Enables a plugin. Only after the user agreed, seeing `fingerprint`.
    pub fn grant_plugin(&self, id: &str, fingerprint: &str, development: bool) -> CommandResult<()> {
        self.plugins.grant(id, self.vault_plugins().as_ref(), fingerprint, development)?;
        self.events.emit(event::PLUGINS_CHANGED, json!({ "folders": [id] }));
        Ok(())
    }

    /// Installs a plugin from a folder the user picked. It stays disabled.
    pub fn install_plugin(&self, folder: &Path) -> CommandResult<PluginInfo> {
        let info = self.plugins.install(folder)?;
        self.events.emit(event::PLUGINS_CHANGED, json!({ "folders": [info.id] }));
        Ok(info)
    }

    /// A vault file's bytes, for images and the like.
    pub fn vault_file(&self, path: &str) -> CommandResult<Vec<u8>> {
        Ok(self.workspace()?.vault.read_bytes(path)?)
    }
}

#[cfg(test)]
mod tests;
