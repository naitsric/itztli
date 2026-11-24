//! Files the page loads by address, and files handed to the system.

use itztli_backend::{CommandError, CommandResult, ErrorCode, net};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder, Url, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::{Shared, blocking};

/// A running plugin's files: `<token>/<file>`.
pub const PLUGIN_SCHEME: &str = "itztli-plugin";
/// A file of the open vault, by its path.
pub const VAULT_SCHEME: &str = "itztli-vault";
/// An image from the web, by its address; only if the user allowed those.
pub const REMOTE_SCHEME: &str = "itztli-remote";

/// Where the window may be: the bundled app, or Vite while developing.
pub fn is_app(url: &Url) -> bool {
    let bundled = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
    bundled || (cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(1420))
}

fn respond(responder: UriSchemeResponder, found: Option<(String, Vec<u8>)>) {
    let response = match found {
        Some((mime, bytes)) => Response::builder()
            .header(header::CONTENT_TYPE, mime)
            // Plugins' modules are loaded from another origin than the page's.
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-store")
            // Never anything but what it is: an SVG opened as a page runs no scripts.
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'; style-src 'unsafe-inline'")
            .body(bytes),
        None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()),
    };
    if let Ok(response) = response {
        responder.respond(response);
    }
}

/// The address's path, decoded: what `convertFileSrc` encoded.
fn path_of(request: &Request<Vec<u8>>) -> String {
    percent_decode(request.uri().path().trim_start_matches('/'))
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn serve_plugin(context: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let backend = context.app_handle().state::<Shared>().inner().clone();
    let found = backend.plugins().file(&path_of(&request)).map(|(mime, bytes)| (mime.to_owned(), bytes));
    respond(responder, found);
}

pub fn serve_vault(context: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let backend = context.app_handle().state::<Shared>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = path_of(&request);
        respond(responder, backend.vault_file(&path).ok().map(|bytes| (mime(&path).to_owned(), bytes)));
    });
}

pub fn serve_remote(context: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let backend = context.app_handle().state::<Shared>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let found = match backend.plugins().remote_images() {
            true => net::image(&path_of(&request)).await.ok(),
            false => None,
        };
        respond(responder, found);
    });
}

/// Only what notes embed; anything else is just bytes.
fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Documents that opening only shows. Anything else could run something:
/// plugins can create files, and must not get them executed that way.
const OPENABLE: [&str; 30] = [
    "md", "txt", "csv", "pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "bmp", "tiff", "mp3", "m4a", "wav", "ogg",
    "mp4", "webm", "mov", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
];

fn opener_error(e: tauri_plugin_opener::Error) -> CommandError {
    CommandError::new(ErrorCode::Io, e.to_string())
}

/// Shows a file in the system's file manager. The empty path is the vault.
#[tauri::command]
pub async fn entry_reveal(app: AppHandle, backend: State<'_, Shared>, path: String) -> CommandResult<()> {
    let backend = backend.inner().clone();
    blocking(move || app.opener().reveal_item_in_dir(backend.locate(&path)?).map_err(opener_error)).await
}

/// Opens a file with its default application, or only shows where it is if
/// its kind could run something.
#[tauri::command]
pub async fn entry_open(app: AppHandle, backend: State<'_, Shared>, path: String) -> CommandResult<()> {
    let backend = backend.inner().clone();
    blocking(move || {
        let full = backend.locate(&path)?;
        let extension = full.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if full.is_file() && OPENABLE.contains(&extension.as_str()) {
            app.opener().open_path(full.to_string_lossy(), None::<&str>).map_err(opener_error)
        } else {
            app.opener().reveal_item_in_dir(full).map_err(opener_error)
        }
    })
    .await
}

#[tauri::command]
pub async fn plugin_reveal(app: AppHandle, backend: State<'_, Shared>, id: String) -> CommandResult<()> {
    let backend = backend.inner().clone();
    blocking(move || app.opener().reveal_item_in_dir(backend.plugin(&id)?.folder).map_err(opener_error)).await
}

/// Opens a web or mail address in the system's browser.
#[tauri::command]
pub async fn url_open(app: AppHandle, url: String) -> CommandResult<()> {
    let parsed = Url::parse(&url).map_err(|e| CommandError::new(ErrorCode::InvalidArgument, e.to_string()))?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err(CommandError::new(ErrorCode::InvalidArgument, format!("“{}:” addresses are not opened", parsed.scheme())));
    }
    blocking(move || app.opener().open_url(parsed.as_str(), None::<&str>).map_err(opener_error)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_stays_in_the_app() {
        let ok = |u: &str| is_app(&Url::parse(u).unwrap());
        assert!(ok("tauri://localhost") && ok("tauri://localhost/index.html") && ok("http://tauri.localhost/"));
        for bad in [
            "https://example.com/",
            "file:///etc/passwd",
            "itztli-vault://localhost/x.svg",
            "https://localhost.evil.io/",
            "data:text/html,x",
        ] {
            assert!(!ok(bad), "{bad}");
        }
    }

    #[test]
    fn addresses_decode() {
        assert_eq!(percent_decode("img%2Fa%20b%C3%B1.png"), "img/a bñ.png");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn nothing_that_runs_is_opened() {
        for bad in [
            "command", "app", "terminal", "sh", "scpt", "workflow", "webloc", "fileloc", "exe", "bat", "html", "svg", "js",
            "jar", "pkg", "dmg",
        ] {
            assert!(!OPENABLE.contains(&bad), "{bad}");
        }
    }
}
