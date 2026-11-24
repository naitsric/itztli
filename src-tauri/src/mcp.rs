//! The MCP server inside the app (crates/itztli-mcp): what it runs on,
//! starting it with the app, and the two commands behind the MCP tool
//! window. `mcp` looks and answers approvals; `mcp_change` is everything
//! else, asked in a dialog of the system's when it gives programs outside
//! Itztli more than they had.
//!
//! Everything the server reports reaches the UI as one event, `mcp`. A change
//! waiting for approval also brings the window to the front.

use std::path::Path;
use std::sync::Arc;

use itztli_backend::{Backend, CommandError, CommandResult, event};
use itztli_mcp::{Change, Host, McpEvent, McpServer, Store};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State, UserAttentionType};
use tauri_plugin_dialog::MessageDialogKind;

use crate::{Shared, blocking, consent};

/// The bundle identifier in tauri.conf.json, which the stdio bridge opens
/// the app by.
pub const BUNDLE_ID: &str = "io.github.naitsric.itztli";

/// The window brought to the front when a change waits for approval.
const MAIN_WINDOW: &str = "main";

/// The app's executable once installed. `tauri build` names it after the
/// Cargo package, since tauri.conf.json sets no `mainBinaryName`.
const INSTALLED_EXECUTABLE: &str = "/Applications/Itztli.app/Contents/MacOS/itztli";

struct App {
    handle: AppHandle,
    backend: Shared,
}

impl Host for App {
    fn backend(&self) -> &Backend {
        &self.backend
    }

    fn notify(&self, event: McpEvent) {
        if matches!(event, McpEvent::ApprovalRequested(_)) {
            bring_to_front(&self.handle);
        }
        let _ = self.handle.emit(event::MCP, event);
    }

    fn bridge_command(&self) -> Option<String> {
        bridge_command(&std::env::current_exe().ok()?)
    }
}

/// Shows the main window, focused, wherever it was (minimized, hidden or
/// behind other apps), and asks for attention (the Dock icon bounces until
/// Itztli is active). Every call only posts to the event loop, so it never
/// blocks the server.
fn bring_to_front(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.request_user_attention(Some(UserAttentionType::Critical));
}

/// What clients that only launch stdio servers run, as `<it> mcp-bridge`: the
/// executable this app runs from, so a dev build names the dev binary. An app
/// macOS translocated (opened from Downloads while quarantined) runs from a
/// random path that goes away: then the installed one.
fn bridge_command(executable: &Path) -> Option<String> {
    let path = executable.to_str()?;
    Some(if path.contains("/AppTranslocation/") { INSTALLED_EXECUTABLE } else { path }.to_owned())
}

/// Creates the server, after the backend, and starts it in the background if
/// the user turned it on. If it fails to start its status says why; the app
/// runs on.
pub fn setup(app: &AppHandle, data: &Path) {
    let backend = app.state::<Shared>().inner().clone();
    let store = Store::open(&data.join("mcp.db")).or_else(|e| {
        // Notes work without it. A store that forgets leaves the server off.
        let _ = app.emit(event::WARNING, json!({ "message": e.to_string() }));
        Store::in_memory()
    });
    let Ok(store) = store else { return };
    let server = McpServer::new(store, Arc::new(App { handle: app.clone(), backend }));
    app.manage(server.clone());
    tauri::async_runtime::spawn(async move { server.start_if_enabled().await });
}

/// Looks, and answers approvals.
#[tauri::command]
pub async fn mcp(server: State<'_, McpServer>, command: String, args: Value) -> CommandResult<Value> {
    let server = server.inner().clone();
    blocking(move || server.command(&command, args)).await
}

/// Changes who may do what. Null when the user says no.
#[tauri::command]
pub async fn mcp_change(app: AppHandle, server: State<'_, McpServer>, change: Value) -> CommandResult<Value> {
    let change: Change = serde_json::from_value(change).map_err(|e| CommandError::invalid(e.to_string()))?;
    let server = server.inner().clone();
    let ask = move |q: itztli_mcp::Question| consent::ask(&app, &q.title, q.message, q.yes, MessageDialogKind::Warning);
    server.change(change, ask).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bridge_is_the_executable_the_app_runs_from() {
        let at = |path: &str| bridge_command(Path::new(path)).unwrap();
        assert_eq!(
            at("/Users/x/Applications/Itztli.app/Contents/MacOS/itztli"),
            "/Users/x/Applications/Itztli.app/Contents/MacOS/itztli"
        );
        assert_eq!(at("/private/var/folders/a/AppTranslocation/b/d/Itztli.app/Contents/MacOS/itztli"), INSTALLED_EXECUTABLE);
    }

    #[test]
    fn the_bundle_id_is_the_apps() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], BUNDLE_ID);
    }
}
