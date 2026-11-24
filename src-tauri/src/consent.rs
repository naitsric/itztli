//! What only the user may decide. Plugins run in the same page as the UI, so
//! a dialog drawn there could be answered by one; these are the system's.

use std::path::PathBuf;

use itztli_backend::{CommandError, CommandResult, ErrorCode, VaultInfo};
use itztli_plugins::{PluginInfo, Scope};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{Shared, blocking};

fn pick_folder(app: &AppHandle, title: &str) -> CommandResult<Option<PathBuf>> {
    let picked = app.dialog().file().set_title(title).set_can_create_directories(true).blocking_pick_folder();
    let path = picked.map(|p| p.into_path()).transpose();
    path.map_err(|e| CommandError::new(ErrorCode::InvalidArgument, e.to_string()))
}

fn ask(app: &AppHandle, title: &str, message: String, yes: &str, kind: MessageDialogKind) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(kind)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), "Cancel".into()))
        .blocking_show()
}

/// Opens a folder as a vault, writing the welcome notes first if asked.
/// `None` when the user cancels.
#[tauri::command]
pub async fn vault_pick(app: AppHandle, backend: State<'_, Shared>, welcome: bool) -> CommandResult<Option<VaultInfo>> {
    let backend = backend.inner().clone();
    blocking(move || {
        let title = if welcome { "Choose a folder for the new vault" } else { "Open a folder as a vault" };
        let Some(folder) = pick_folder(&app, title)? else { return Ok(None) };
        if welcome {
            backend.write_welcome(&folder)?;
        }
        backend.open_vault(&folder).map(Some)
    })
    .await
}

/// Enables a plugin once the user agrees. Returns whether they did.
#[tauri::command]
pub async fn plugin_enable(app: AppHandle, backend: State<'_, Shared>, id: String, development: bool) -> CommandResult<bool> {
    let backend = backend.inner().clone();
    blocking(move || {
        let info = backend.plugin(&id)?;
        let (Some(manifest), Some(fingerprint)) = (&info.manifest, &info.fingerprint) else {
            return Err(CommandError::new(ErrorCode::Plugin, info.error.unwrap_or_else(|| "the plugin cannot be read".into())));
        };
        let title = format!("Enable “{}” {}?", printable(&manifest.name), printable(&manifest.version));
        if !ask(&app, &title, describe(&info, development), "Enable", MessageDialogKind::Warning) {
            return Ok(false);
        }
        backend.grant_plugin(&id, fingerprint, development)?;
        Ok(true)
    })
    .await
}

fn describe(info: &PluginInfo, development: bool) -> String {
    let mut lines = vec![
        match info.scope {
            Scope::Vault => "It came with this vault.".to_owned(),
            Scope::User => "It is installed for every vault.".to_owned(),
        },
        "It will be able to read and change the notes in the open vault.".to_owned(),
    ];
    if let Some(manifest) = &info.manifest {
        lines.push(if manifest.network.is_empty() {
            "It does not ask for network access.".to_owned()
        } else {
            format!("It asks to connect to: {}.", manifest.network.join(", "))
        });
    }
    lines.push(if development {
        "For development: it will keep running when its files change, without asking again. Only do this with code you are writing.".to_owned()
    } else {
        "If its files change, it stops until you review it again.".to_owned()
    });
    lines.push(format!("\n{}", info.folder.display()));
    lines.join("\n")
}

/// A plugin names itself; its name must not be able to imitate the dialog.
fn printable(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(80).collect()
}

/// Installs a plugin from a folder. `None` when the user cancels.
#[tauri::command]
pub async fn plugin_install(app: AppHandle, backend: State<'_, Shared>) -> CommandResult<Option<PluginInfo>> {
    let backend = backend.inner().clone();
    blocking(move || {
        let Some(folder) = pick_folder(&app, "Choose the plugin's folder")? else { return Ok(None) };
        backend.install_plugin(&folder).map(Some)
    })
    .await
}

/// Allows images from the web once the user agrees; stopping needs no
/// question. Returns whether they are allowed now.
#[tauri::command]
pub async fn remote_images_set(app: AppHandle, backend: State<'_, Shared>, allowed: bool) -> CommandResult<bool> {
    let backend = backend.inner().clone();
    blocking(move || {
        let message = "Notes will load images from the web. Whoever hosts an image can tell when it is opened, and from where. \
                       Plugins could also use it to send data out.";
        if allowed && !ask(&app, "Load images from the web?", message.into(), "Allow", MessageDialogKind::Warning) {
            return Ok(backend.plugins().remote_images());
        }
        backend.plugins().set_remote_images(allowed)?;
        Ok(allowed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_add_lines_to_the_dialog() {
        assert_eq!(printable("Nice\n\nIt is safe\u{7}"), "NiceIt is safe");
        assert_eq!(printable(&"x".repeat(500)).len(), 80);
    }
}
