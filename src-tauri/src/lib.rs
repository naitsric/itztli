//! The desktop host: a window over `itztli_backend`, and the things only the
//! user may decide, each asked in a native dialog.

mod consent;
mod files;
mod menu;
mod safe_mode;

use std::sync::Arc;

use itztli_backend::{Backend, CommandError, CommandResult, ErrorCode, Events, net};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) type Shared = Arc<Backend>;

struct WindowEvents(AppHandle);

impl Events for WindowEvents {
    fn emit(&self, name: &'static str, payload: Value) {
        let _ = self.0.emit(name, payload);
    }
}

/// Every command of the backend; see `itztli_backend::commands`.
#[tauri::command]
async fn call(backend: State<'_, Shared>, command: String, args: Value) -> CommandResult<Value> {
    let backend = backend.inner().clone();
    blocking(move || backend.call(&command, args)).await
}

/// Runs something that may take a while off the event loop.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CommandResult<T> + Send + 'static) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work).await.unwrap_or_else(|e| Err(CommandError::new(ErrorCode::Io, e.to_string())))
}

/// The network for a plugin, limited to the origins in its manifest.
#[tauri::command]
async fn plugin_fetch(backend: State<'_, Shared>, token: String, request: net::Request) -> CommandResult<net::Response> {
    let origins = backend.plugins().network(&token);
    let origins = origins.ok_or_else(|| CommandError::new(ErrorCode::Plugin, "the plugin is not running"))?;
    net::fetch(request, &origins).await
}

/// Ends the app. The UI calls it once every note is saved.
#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Reopens the window at its last size and position.
        .plugin(tauri_plugin_window_state::Builder::new().build())
        // The window shows the app and nothing else: a page it wandered off
        // to would inherit the app's commands.
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("stay").on_navigation(|_, url| files::is_app(url)).build())
        .register_asynchronous_uri_scheme_protocol(files::PLUGIN_SCHEME, files::serve_plugin)
        .register_asynchronous_uri_scheme_protocol(files::VAULT_SCHEME, files::serve_vault)
        .register_asynchronous_uri_scheme_protocol(files::REMOTE_SCHEME, files::serve_remote)
        .on_menu_event(menu::on_menu_event)
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let events = Arc::new(WindowEvents(app.handle().clone()));
            let backend = Backend::new(&data, events)?.with_safe_mode(safe_mode::requested(&data));
            app.manage::<Shared>(Arc::new(backend));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            call,
            plugin_fetch,
            app_quit,
            consent::vault_pick,
            consent::plugin_enable,
            consent::plugin_install,
            consent::remote_images_set,
            files::entry_reveal,
            files::entry_open,
            files::plugin_reveal,
            files::url_open,
            menu::menu_set,
            safe_mode::app_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the application");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            app.state::<Shared>().close_vault();
        }
    });
}
