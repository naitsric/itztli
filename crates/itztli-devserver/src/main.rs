//! Runs the UI in a browser against a real vault: `pnpm dev:web <folder>`.
//!
//! For development and the end-to-end tests only. It listens on this
//! computer, answers only requests that know its token (the first part of
//! every path) and lets only Vite's page read the answers. Consent is given
//! automatically, as there is no one to ask.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream::{self, Stream};
use itztli_backend::{Backend, CommandError, CommandResult, ErrorCode, Events, net};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;

struct Broadcast(broadcast::Sender<(&'static str, Value)>);

impl Events for Broadcast {
    fn emit(&self, name: &'static str, payload: Value) {
        let _ = self.0.send((name, payload));
    }
}

struct Server {
    backend: Arc<Backend>,
    events: broadcast::Sender<(&'static str, Value)>,
    vault: PathBuf,
    token: String,
    page: HeaderValue,
}

type Shared = Arc<Server>;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(vault), Some(data)) = (args.next(), args.next()) else {
        return Err(
            "usage: itztli-devserver <vault folder> <data folder>; see ITZTLI_DEV_PORT, ITZTLI_DEV_TOKEN, ITZTLI_DEV_PAGE".into(),
        );
    };
    let var = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_owned());
    let port: u16 = var("ITZTLI_DEV_PORT", "7465").parse()?;
    let token = var("ITZTLI_DEV_TOKEN", "");
    if token.len() < 16 || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("set ITZTLI_DEV_TOKEN to at least 16 letters or digits".into());
    }

    let vault = PathBuf::from(vault);
    let data = PathBuf::from(data);
    let (events, _) = broadcast::channel(1024);
    let backend = Arc::new(Backend::new(&data, Arc::new(Broadcast(events.clone())))?.with_trash_folder(data.join("trash")));
    if std::env::var_os("ITZTLI_DEV_OPEN").is_some() {
        backend.open_vault(&vault)?;
    }

    let page = HeaderValue::from_str(&var("ITZTLI_DEV_PAGE", "http://localhost:1420"))?;
    let server = Arc::new(Server { backend, events, vault, token, page });
    let app = Router::new()
        .route("/{token}/call/{command}", post(call))
        .route("/{token}/host/{command}", post(host))
        .route("/{token}/events", get(listen))
        .route("/{token}/plugin/{*path}", get(plugin_file))
        .route("/{token}/vault/{*path}", get(vault_file))
        .layer(middleware::from_fn_with_state(server.clone(), guard))
        .with_state(server);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("itztli-devserver on http://127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn guard(State(server): State<Shared>, request: Request, next: Next) -> Response {
    let token = request.uri().path().split('/').nth(1).unwrap_or("");
    if token != server.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response =
        if request.method() == Method::OPTIONS { StatusCode::NO_CONTENT.into_response() } else { next.run(request).await };
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, server.page.clone());
    headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("content-type"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn blocking(work: impl FnOnce() -> CommandResult<Value> + Send + 'static) -> Response {
    let result = tokio::task::spawn_blocking(work).await;
    answer(result.unwrap_or_else(|e| Err(CommandError::new(ErrorCode::Io, e.to_string()))))
}

fn answer(result: CommandResult<Value>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(e) => (StatusCode::UNPROCESSABLE_ENTITY, Json(e)).into_response(),
    }
}

async fn call(State(server): State<Shared>, Path((_, command)): Path<(String, String)>, Json(args): Json<Value>) -> Response {
    let backend = server.backend.clone();
    blocking(move || backend.call(&command, args)).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct HostArgs {
    id: String,
    development: bool,
    welcome: bool,
    allowed: bool,
    token: String,
    request: Option<net::Request>,
}

/// What the desktop host asks the user about.
async fn host(State(server): State<Shared>, Path((_, command)): Path<(String, String)>, Json(args): Json<HostArgs>) -> Response {
    let backend = server.backend.clone();
    if command == "plugin_fetch" {
        let (Some(request), Some(origins)) = (args.request, backend.plugins().network(&args.token)) else {
            return answer(Err(CommandError::new(ErrorCode::Plugin, "the plugin is not running")));
        };
        return answer(net::fetch(request, &origins).await.map(|r| json!(r)));
    }
    let vault = server.vault.clone();
    blocking(move || match command.as_str() {
        "vault_pick" => {
            if args.welcome {
                backend.write_welcome(&vault)?;
            }
            Ok(json!(backend.open_vault(&vault)?))
        }
        "plugin_enable" => {
            let info = backend.plugin(&args.id)?;
            let fingerprint =
                info.fingerprint.ok_or_else(|| CommandError::new(ErrorCode::Plugin, info.error.unwrap_or_default()))?;
            backend.grant_plugin(&args.id, &fingerprint, args.development)?;
            Ok(json!(true))
        }
        "remote_images_set" => {
            backend.plugins().set_remote_images(args.allowed)?;
            Ok(json!(args.allowed))
        }
        // Nothing to show or quit in a browser.
        _ => Ok(Value::Null),
    })
    .await
}

async fn listen(State(server): State<Shared>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let receiver = server.events.subscribe();
    let events = stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok((name, payload)) => {
                    let event = Event::default().event(name).data(payload.to_string());
                    return Some((Ok(event), receiver));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(events).keep_alive(KeepAlive::default())
}

async fn plugin_file(State(server): State<Shared>, Path((_, path)): Path<(String, String)>) -> Response {
    match server.backend.plugins().file(&path) {
        Some((mime, bytes)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn vault_file(State(server): State<Shared>, Path((_, path)): Path<(String, String)>) -> Response {
    let mime = match path.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    match server.backend.vault_file(&path) {
        Ok(bytes) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
