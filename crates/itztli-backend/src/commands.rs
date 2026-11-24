//! The commands the UI calls. `src/backend/api.ts` is their typed side.

use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use itztli_core::path;
use itztli_index::{FindScope, TextQuery};
use itztli_plugins::Scope;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{CommandError, CommandResult, ErrorCode};
use crate::{Backend, event};

fn args<T: DeserializeOwned>(value: Value) -> CommandResult<T> {
    serde_json::from_value(value).map_err(|e| CommandError::invalid(e.to_string()))
}

fn ok(value: impl Serialize) -> CommandResult<Value> {
    serde_json::to_value(value).map_err(|e| CommandError::invalid(e.to_string()))
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
struct Write {
    path: String,
    text: String,
    #[serde(default)]
    base: Option<String>,
}

#[derive(Deserialize)]
struct NewFile {
    folder: String,
    name: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct Attachment {
    folder: String,
    name: String,
    base64: String,
}

#[derive(Deserialize)]
struct Move {
    from: String,
    to: String,
    #[serde(default = "yes")]
    relink: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct Find {
    query: String,
    #[serde(default = "notes")]
    scope: FindScope,
    #[serde(default = "fifty")]
    limit: usize,
}

fn notes() -> FindScope {
    FindScope::Notes
}

fn fifty() -> usize {
    50
}

#[derive(Deserialize)]
struct Resolve {
    source: String,
    target: String,
    #[serde(default)]
    subpath: Option<String>,
    #[serde(default)]
    relative: bool,
}

#[derive(Deserialize)]
struct SuggestLinks {
    source: String,
    query: String,
    #[serde(default = "fifty")]
    limit: usize,
}

#[derive(Deserialize)]
struct GraphArgs {
    #[serde(default)]
    around: Option<String>,
    #[serde(default = "one")]
    depth: usize,
    #[serde(default)]
    missing: bool,
}

fn one() -> usize {
    1
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

#[derive(Deserialize)]
struct NamedValue {
    name: String,
    value: Value,
}

#[derive(Deserialize)]
struct NewPlugin {
    id: String,
    name: String,
    scope: Scope,
}

#[derive(Deserialize)]
struct Toggle {
    id: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct RevisionArg {
    id: i64,
}

impl Backend {
    /// Runs a command. Blocking: hosts call it off their event loop.
    pub fn call(&self, command: &str, arguments: Value) -> CommandResult<Value> {
        match command {
            // App
            "app_info" => ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "platform": std::env::consts::OS,
                "safeMode": self.safe_mode,
                "pluginApi": itztli_plugins::API_VERSION,
                "remoteImages": self.plugins.remote_images(),
            })),
            "state_get" => {
                let a: Named = args(arguments)?;
                Ok(self.state.read(state_name(&a.name)?))
            }
            "state_set" => {
                let a: NamedValue = args(arguments)?;
                let saved = self.state.write(state_name(&a.name)?, &a.value);
                saved.map_err(|e| CommandError::new(ErrorCode::Io, format!("cannot save {}: {e}", a.name)))?;
                ok(())
            }

            // Vaults
            "vault_recents" => ok(self
                .state
                .recents()
                .into_iter()
                .map(|r| {
                    let exists = r.path.is_dir();
                    json!({ "id": r.id, "name": r.name, "path": r.path, "openedAt": r.opened_at, "exists": exists })
                })
                .collect::<Vec<_>>()),
            "vault_open" => ok(self.open_recent(&args::<Id>(arguments)?.id)?),
            "vault_forget" => {
                let forgotten = self.state.forget(&args::<Id>(arguments)?.id);
                forgotten.map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))?;
                ok(())
            }
            "vault_current" => ok(self.current().map(|w| w.info.clone())),
            "vault_close" => {
                self.close_vault();
                ok(())
            }
            "vault_entries" => {
                let workspace = self.workspace()?;
                let index = workspace.index();
                ok(index.entries().collect::<Vec<_>>())
            }
            "index_status" => ok(self.workspace()?.status()),
            "config_get" => ok(self.workspace()?.read_config(&args::<Named>(arguments)?.name)?),
            "config_set" => {
                let a: NamedValue = args(arguments)?;
                ok(self.workspace()?.write_config(&a.name, &a.value)?)
            }

            // Files
            "note_read" => ok(self.workspace()?.read(&args::<PathArg>(arguments)?.path)?),
            "note_write" => {
                let a: Write = args(arguments)?;
                ok(self.workspace()?.write(&a.path, &a.text, a.base.as_deref())?)
            }
            "note_create" => {
                let a: Write = args(arguments)?;
                ok(self.workspace()?.create(&a.path, &a.text)?)
            }
            // Creates a file under a name nothing uses yet, and returns its path.
            "note_create_free" => {
                let a: NewFile = args(arguments)?;
                let workspace = self.workspace()?;
                let p = workspace.free_path(&a.folder, &a.name);
                workspace.create(&p, &a.text)?;
                ok(p)
            }
            // The same for a file that is not text, e.g. a pasted image.
            "attachment_create" => {
                let a: Attachment = args(arguments)?;
                let bytes = STANDARD.decode(a.base64).map_err(|e| CommandError::invalid(e.to_string()))?;
                let workspace = self.workspace()?;
                let p = workspace.free_path(&a.folder, &a.name);
                workspace.create_bytes(&p, &bytes)?;
                ok(p)
            }
            "folder_create" => ok(self.workspace()?.create_folder(&args::<PathArg>(arguments)?.path)?),
            "entry_duplicate" => ok(self.workspace()?.duplicate(&args::<PathArg>(arguments)?.path)?),
            "entry_move_preview" => {
                let a: Move = args(arguments)?;
                ok(self.workspace()?.preview_move(&a.from, &a.to)?)
            }
            "entry_move" => {
                let a: Move = args(arguments)?;
                ok(self.workspace()?.move_entry(&a.from, &a.to, a.relink)?)
            }
            "entry_trash" => ok(self.workspace()?.trash(&args::<PathArg>(arguments)?.path)?),

            // Search
            "find_files" => {
                let a: Find = args(arguments)?;
                ok(self.workspace()?.index().find_files(&a.query, a.scope, a.limit))
            }
            "find_headings" => {
                let a: Find = args(arguments)?;
                ok(self.workspace()?.index().find_headings(&a.query, a.limit))
            }
            "search_text" => ok(self.workspace()?.search_text(&args::<TextQuery>(arguments)?)?),

            // Links and what notes say
            "note_meta" => ok(self.workspace()?.index().note(&args::<PathArg>(arguments)?.path).map(|m| m.as_ref().clone())),
            "link_resolve" => {
                let a: Resolve = args(arguments)?;
                ok(self.workspace()?.index().resolve(&a.source, &a.target, a.relative))
            }
            // Many at once: an editor asks for every link on screen.
            "links_resolve" => {
                let many: Vec<Resolve> = args(arguments.get("links").cloned().unwrap_or_default())?;
                let workspace = self.workspace()?;
                let index = workspace.index();
                ok(many.iter().map(|a| index.resolve(&a.source, &a.target, a.relative)).collect::<Vec<_>>())
            }
            "link_text" => {
                let a: Resolve = args(arguments)?;
                ok(self.workspace()?.index().link_text(&a.source, &a.target))
            }
            "suggest_links" => {
                let a: SuggestLinks = args(arguments)?;
                ok(self.workspace()?.index().suggest_links(&a.source, &a.query, a.limit))
            }
            "excerpt" => {
                let a: Resolve = args(arguments)?;
                ok(self.workspace()?.excerpt(&a.source, &a.target, a.subpath.as_deref(), a.relative)?)
            }
            "usages" => ok(self.workspace()?.usages(&args::<PathArg>(arguments)?.path)),
            "tags" => ok(self.workspace()?.index().tags()),
            "notes_with_tag" => ok(self.workspace()?.index().notes_with_tag(&args::<Named>(arguments)?.name)),
            "tasks" => ok(self.workspace()?.tasks()),
            "problems" => ok(self.workspace()?.index().problems()),
            "problems_in" => ok(self.workspace()?.index().problems_in(&args::<PathArg>(arguments)?.path)),
            "graph" => {
                let a: GraphArgs = args(arguments)?;
                ok(self.workspace()?.index().graph(a.around.as_deref().map(|p| (p, a.depth)), a.missing))
            }

            // Local history
            "history_list" => {
                let a: PathArg = args(arguments)?;
                ok(self.history.list(&self.workspace()?.info.id, &a.path)?)
            }
            "history_text" => {
                let a: RevisionArg = args(arguments)?;
                ok(self.history.text(&self.workspace()?.info.id, a.id)?)
            }

            // Plugins. Enabling and installing are up to the host: see lib.rs.
            "plugins_list" => ok(json!({
                "plugins": self.plugins.list(self.vault_plugins().as_ref()),
                "builtinsOff": self.plugins.builtins_off(),
            })),
            "plugin_load" => {
                if self.safe_mode {
                    return Err(CommandError::new(ErrorCode::Plugin, "plugins do not run in Safe Mode"));
                }
                ok(self.plugins.load(&args::<Id>(arguments)?.id, self.vault_plugins().as_ref())?)
            }
            "plugin_disable" => {
                let a: Id = args(arguments)?;
                self.plugins.revoke(&a.id, self.vault_plugins().as_ref())?;
                self.plugins_changed(&a.id)
            }
            "plugin_builtin_set" => {
                let a: Toggle = args(arguments)?;
                self.plugins.set_builtin(&a.id, a.enabled)?;
                self.plugins_changed(&a.id)
            }
            "plugin_create" => {
                let a: NewPlugin = args(arguments)?;
                let info = self.plugins.create(&a.id, &a.name, a.scope, self.vault_plugins().as_ref())?;
                self.plugins_changed(&a.id)?;
                ok(info)
            }
            "plugin_uninstall" => {
                let a: Id = args(arguments)?;
                self.plugins.uninstall(&a.id)?;
                self.plugins_changed(&a.id)
            }

            _ => Err(CommandError::invalid(format!("unknown command {command}"))),
        }
    }

    fn plugins_changed(&self, id: &str) -> CommandResult<Value> {
        self.events.emit(event::PLUGINS_CHANGED, json!({ "folders": [id] }));
        ok(())
    }

    /// Where a vault path is on disk, for hosts that show or open files.
    pub fn locate(&self, p: &str) -> CommandResult<std::path::PathBuf> {
        let workspace = self.workspace()?;
        if p.is_empty() {
            return Ok(workspace.vault.root().to_owned());
        }
        let full = workspace.vault.locate(p)?;
        if Path::new(&full).exists() {
            Ok(full)
        } else {
            Err(CommandError::new(ErrorCode::NotFound, format!("“{}” does not exist", path::name(p))))
        }
    }
}

/// The app's own state files. `trust`, what plugins may run, is not one.
fn state_name(name: &str) -> CommandResult<&str> {
    let workspace = name.strip_prefix("workspace-");
    if name == "settings" || workspace.is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit())) {
        Ok(name)
    } else {
        Err(CommandError::invalid(format!("“{name}” is not a state file")))
    }
}
