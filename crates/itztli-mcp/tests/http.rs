//! The server over HTTP, end to end: rmcp's own client, and plain HTTP for
//! what no MCP client sends, against a server on a free port over a vault of
//! its own.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http::{HeaderName, HeaderValue};
use itztli_mcp::testing::TestVault;
use itztli_mcp::{
    Access, ApprovalRequest, AuditEntry, Decision, INSTRUCTIONS, MCP_PATH, McpEvent, McpServer, McpSettings, ServerStatus,
    StartError, Transport,
};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HOST, ORIGIN, WWW_AUTHENTICATE};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, Implementation, ProgressNotificationParam,
    ProtocolVersion,
};
use rmcp::service::{NotificationContext, RunningService};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ClientHandler, ClientLifecycleMode, ClientServiceExt, RoleClient, ServiceExt};
use serde_json::{Value as Json, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

/// How a client starts talking to the server.
#[derive(Debug, Clone)]
enum Lifecycle {
    /// 2026-07-28: no `initialize`; each request carries the protocol
    /// version and the client's info and capabilities in `_meta`.
    Modern,
    /// `initialize` at this revision, then a session (`Mcp-Session-Id`).
    Legacy(ProtocolVersion),
}

const LIFECYCLES: [Lifecycle; 3] =
    [Lifecycle::Modern, Lifecycle::Legacy(ProtocolVersion::V_2025_06_18), Lifecycle::Legacy(ProtocolVersion::V_2025_11_25)];

impl Lifecycle {
    fn version(&self) -> ProtocolVersion {
        match self {
            Lifecycle::Modern => ProtocolVersion::V_2026_07_28,
            Lifecycle::Legacy(version) => version.clone(),
        }
    }
}

/// An MCP client that keeps the progress notifications it gets.
#[derive(Clone)]
struct Recorder {
    info: ClientConfig,
    progress: Arc<Mutex<Vec<ProgressNotificationParam>>>,
}

impl ClientHandler for Recorder {
    fn get_info(&self) -> ClientConfig {
        self.info.clone()
    }

    async fn on_progress(&self, params: ProgressNotificationParam, _: NotificationContext<RoleClient>) {
        self.progress.lock().unwrap().push(params);
    }
}

type Client = RunningService<RoleClient, Recorder>;

const NOTE: &str = "a\nb\nc\n";

struct Env {
    test: TestVault,
    server: McpServer,
    addr: SocketAddr,
}

impl Env {
    async fn start() -> Self {
        let test = TestVault::new(&[("t.md", NOTE)]).await;
        let server = test.server.clone();
        let addr = server.start(&on_port(0)).await.unwrap();
        Self { test, server, addr }
    }

    fn url(&self) -> String {
        format!("http://{}{MCP_PATH}", self.addr)
    }

    /// rmcp's client, connected the way Claude Code or Cursor connect.
    async fn client(&self, token: &str, lifecycle: Lifecycle) -> Client {
        self.client_with(token, lifecycle, HashMap::new()).await
    }

    async fn client_with(&self, token: &str, lifecycle: Lifecycle, headers: HashMap<HeaderName, HeaderValue>) -> Client {
        let config = StreamableHttpClientTransportConfig::with_uri(self.url()).auth_header(token);
        let transport = StreamableHttpClientTransport::from_config(config.custom_headers(headers));
        let info = ClientConfig::new(ClientCapabilities::default(), Implementation::new("claude-code", "2.1.0"));
        let (info, mode) = match lifecycle {
            Lifecycle::Modern => {
                (info, ClientLifecycleMode::Discover { preferred_versions: vec![ProtocolVersion::V_2026_07_28] })
            }
            Lifecycle::Legacy(version) => (info.with_protocol_version(version), ClientLifecycleMode::Initialize),
        };
        let recorder = Recorder { info, progress: Arc::default() };
        recorder.serve_with_lifecycle(transport, mode).await.unwrap()
    }

    /// A POST as MCP clients send it, with `token` if any.
    fn post(&self, token: Option<&str>) -> reqwest::RequestBuilder {
        let request = reqwest::Client::new()
            .post(self.url())
            .header(ACCEPT, "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json");
        match token {
            Some(token) => request.header(AUTHORIZATION, format!("Bearer {token}")),
            None => request,
        }
    }

    /// `initialize` at protocol 2025-03-26, which sends no protocol header
    /// afterwards; returns the session id.
    async fn initialize(&self, token: &str) -> String {
        let response = self.post(Some(token)).body(initialize_body()).send().await.unwrap();
        assert_eq!(response.status(), 200);
        let session = response.headers()["mcp-session-id"].to_str().unwrap().to_owned();
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let response = self.post(Some(token)).header("mcp-session-id", &session).body(initialized.to_string()).send().await;
        assert_eq!(response.unwrap().status(), 202);
        session
    }
}

fn on_port(port: u16) -> McpSettings {
    McpSettings { port, ..McpSettings::default() }
}

fn initialize_body() -> String {
    let client = json!({ "name": "curl", "version": "8.7" });
    let params = json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": client });
    json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params }).to_string()
}

/// A `tools/call` request of protocol 2026-07-28, with the headers it
/// needs.
fn modern_call(id: u64, tool: &str, arguments: Json) -> (String, Vec<(&'static str, String)>) {
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { "name": "curl", "version": "8.7" },
        "io.modelcontextprotocol/clientCapabilities": {},
    });
    let params = json!({ "name": tool, "arguments": arguments, "_meta": meta });
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params }).to_string();
    let headers =
        vec![("mcp-protocol-version", "2026-07-28".to_owned()), ("mcp-method", "tools/call".into()), ("mcp-name", tool.into())];
    (body, headers)
}

fn legacy_call(id: u64, tool: &str, arguments: Json) -> String {
    let params = json!({ "name": tool, "arguments": arguments });
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params }).to_string()
}

/// The JSON-RPC messages of an SSE body.
fn sse_messages(body: &str) -> Vec<Json> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty())
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
}

/// An HTTP/1.1 POST written by hand on its own connection, to drop that
/// connection while the server works on it.
async fn raw_post(addr: SocketAddr, token: &str, headers: &[(&str, String)], body: &str) -> TcpStream {
    let mut request = format!(
        "POST {MCP_PATH} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nAccept: application/json, \
         text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    stream
}

fn call(tool: &str, arguments: Json) -> CallToolRequestParams {
    let Json::Object(arguments) = arguments else { panic!("arguments are an object") };
    CallToolRequestParams::new(tool.to_owned()).with_arguments(arguments)
}

fn text(result: &CallToolResult) -> String {
    result.content[0].as_text().expect("text content").text.clone()
}

/// The next event `pick` accepts, within 10 s.
async fn next<T>(events: &mut broadcast::Receiver<McpEvent>, pick: impl Fn(McpEvent) -> Option<T>) -> T {
    let found = async {
        loop {
            if let Some(found) = pick(events.recv().await.unwrap()) {
                return found;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), found).await.expect("the event in time")
}

async fn next_approval(events: &mut broadcast::Receiver<McpEvent>) -> ApprovalRequest {
    next(events, |event| match event {
        McpEvent::ApprovalRequested(request) => Some(request),
        _ => None,
    })
    .await
}

async fn next_audit(events: &mut broadcast::Receiver<McpEvent>) -> AuditEntry {
    next(events, |event| match event {
        McpEvent::Audit(entry) => Some(entry),
        _ => None,
    })
    .await
}

async fn next_status(events: &mut broadcast::Receiver<McpEvent>) -> ServerStatus {
    next(events, |event| match event {
        McpEvent::Status(status) => Some(status),
        _ => None,
    })
    .await
}

const CANCELLED: &str = "The call was cancelled before the user answered";

/// Asserts the audit row of a write withdrawn while it waited, and why.
fn assert_withdrawn(audit: &AuditEntry, why: &str) {
    assert_eq!(audit.decision, Decision::Withdrawn, "{audit:?}");
    assert!(audit.error.as_deref().is_some_and(|error| error.starts_with(why)), "{audit:?}");
}

/// Whether something listens on `addr`.
async fn answers(addr: SocketAddr) -> bool {
    TcpStream::connect(addr).await.is_ok()
}

#[tokio::test]
async fn serves_the_tools_to_clients_of_either_lifecycle() {
    for lifecycle in LIFECYCLES {
        let env = Env::start().await;
        let (_, token) = env.test.client("claude", None);
        let client = env.client(&token, lifecycle.clone()).await;

        let info = client.peer_info().unwrap();
        assert_eq!(info.protocol_version, lifecycle.version(), "{lifecycle:?}");
        let server = info.server_info.clone().unwrap();
        assert_eq!((server.name.as_str(), server.version.as_str()), ("Itztli", env!("CARGO_PKG_VERSION")));
        assert_eq!(info.instructions.as_deref(), Some(INSTRUCTIONS));

        let mut tools = client.list_all_tools().await.unwrap();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let listed: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
        let writes = ["append_to_note", "create_note", "delete_note", "edit_note", "move_note", "replace_note"];
        let reads = [
            "describe_note",
            "list_notes",
            "list_problems",
            "list_tags",
            "list_tasks",
            "list_vaults",
            "read_note",
            "search_notes",
        ];
        let mut expected = [&writes[..], &reads[..]].concat();
        expected.sort();
        assert_eq!(listed, expected);
        for tool in &tools {
            let hints = tool.annotations.as_ref().unwrap();
            // read only, destructive, idempotent, open world
            let expected = match tool.name.as_ref() {
                "append_to_note" | "create_note" => (Some(false), Some(false), Some(false), Some(false)),
                name if writes.contains(&name) => (Some(false), Some(true), Some(false), Some(false)),
                _ => (Some(true), None, Some(true), Some(false)),
            };
            let actual = (hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint, hints.open_world_hint);
            assert_eq!(actual, expected, "{}", tool.name);
            assert!(tool.description.as_ref().is_some_and(|d| d.len() > 50), "{}", tool.name);
            assert!(tool.title.is_some(), "{}", tool.name);
            assert!(tool.output_schema.is_some(), "{}", tool.name);
            // Only formats JSON Schema defines, which ours use none of.
            let schemas = serde_json::to_string(&(&tool.input_schema, &tool.output_schema)).unwrap();
            assert!(!schemas.contains("\"format\""), "{}: {schemas}", tool.name);
        }

        // The schemas are the core's, doc comments included.
        let search = tools.iter().find(|t| t.name == "search_notes").unwrap();
        let input = Json::Object(search.input_schema.as_ref().clone());
        assert_eq!(input["required"], json!(["vault", "query"]), "{input}");
        assert_eq!(input["properties"]["limit"]["maximum"], 1000, "{input}");
        assert!(input["properties"]["query"]["description"].as_str().unwrap().contains("accents"), "{input}");
        let output = Json::Object(search.output_schema.as_deref().unwrap().clone());
        assert!(output["properties"]["truncated"]["description"].is_string(), "{output}");
        let describe = tools.iter().find(|t| t.name == "describe_note").unwrap();
        let output = Json::Object(describe.output_schema.as_deref().unwrap().clone());
        assert!(output["properties"]["type"]["description"].is_string(), "{output}");
        client.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn answers_with_structured_content_and_audits_who_asked() {
    for lifecycle in LIFECYCLES {
        let env = Env::start().await;
        let (caller, token) = env.test.client("claude", Some(Access::Read));
        let client = env.client(&token, lifecycle.clone()).await;

        let read = json!({ "vault": "Notes", "path": "t.md" });
        let result = client.call_tool(call("read_note", read)).await.unwrap();
        assert_eq!(result.is_error, Some(false), "{result:?}");
        let structured = result.structured_content.clone().unwrap();
        assert_eq!(structured["text"], NOTE);
        assert_eq!((structured["totalLines"].clone(), structured["truncated"].clone()), (json!(3), json!(false)));
        // The same JSON as text, for clients that only read text.
        assert_eq!(serde_json::from_str::<Json>(&text(&result)).unwrap(), structured);

        let audit = env.test.events.last_audit();
        assert_eq!((audit.tool.as_str(), audit.decision), ("read_note", Decision::Allowed));
        assert_eq!(audit.client_id, caller.client_id);
        assert_eq!(audit.transport, Transport::Http);
        assert_eq!(audit.client_info_name.as_deref(), Some("claude-code"));
        assert_eq!(audit.client_info_version.as_deref(), Some("2.1.0"));
        assert_eq!(audit.protocol_version.as_deref(), Some(lifecycle.version().as_str()));
        match lifecycle {
            Lifecycle::Modern => assert_eq!(audit.session_key, None),
            // rmcp's session ids are UUIDs.
            Lifecycle::Legacy(_) => assert_eq!(audit.session_key.as_ref().map(String::len), Some(36), "{audit:?}"),
        }

        // A refusal is a result the model reads, and so are arguments that
        // don't fit the schema.
        let refused = client.call_tool(call("delete_note", json!({ "vault": "Notes", "path": "t.md" })));
        let refused = refused.await.unwrap();
        assert_eq!(refused.is_error, Some(true));
        assert!(text(&refused).contains("may only read"), "{refused:?}");
        assert_eq!(refused.structured_content, None);
        let invalid = client.call_tool(call("read_note", json!({ "vault": "Notes" }))).await.unwrap();
        assert_eq!(invalid.is_error, Some(true));
        assert!(text(&invalid).contains("missing field `path`"), "{invalid:?}");
        assert_eq!(env.test.on_disk("t.md").as_deref(), Some(NOTE));
        client.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn an_approved_write_waits_for_the_user_and_reports_progress() {
    for lifecycle in LIFECYCLES {
        let env = Env::start().await;
        let (_, token) = env.test.client("claude", Some(Access::Write));
        let client = env.client(&token, lifecycle.clone()).await;

        // The user takes a moment: long enough for a few progress reports.
        let mut events = env.test.events.subscribe();
        let server = env.server.clone();
        let user = tokio::spawn(async move {
            let request = next_approval(&mut events).await;
            tokio::time::sleep(Duration::from_millis(450)).await;
            assert!(server.answer_approval(request.id, true));
            request
        });
        let arguments =
            json!({ "vault": "Notes", "path": "t.md", "edits": [{ "oldText": "a", "newText": "z" }], "reason": "a test" });
        let result = client.call_tool(call("edit_note", arguments)).await.unwrap();
        let request = user.await.unwrap();
        assert_eq!(request.reason.as_deref(), Some("a test"));
        assert_eq!(request.client_info.as_ref().map(|info| info.name.as_str()), Some("claude-code"));
        assert_eq!(result.is_error, Some(false), "{result:?}");
        assert_eq!(result.structured_content.unwrap()["path"], "t.md");
        assert_eq!(env.test.on_disk("t.md").as_deref(), Some("z\nb\nc\n"));
        assert_eq!(env.test.events.last_audit().decision, Decision::Approved);

        // The client handles notifications on tasks of their own.
        let progress = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let progress = client.service().progress.lock().unwrap().clone();
                if progress.len() >= 2 {
                    return progress;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        let progress = progress.await.expect("progress reports");
        let message = progress[0].message.as_deref().unwrap();
        assert!(message.starts_with("Waiting for the user to approve the change"), "{lifecycle:?}: {message}");
        assert_eq!(progress[0].total, Some(120.0));
        client.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn a_write_of_a_client_the_user_lets_go_without_asking_returns_at_once() {
    for lifecycle in LIFECYCLES {
        let env = Env::start().await;
        let (caller, token) = env.test.client("claude", Some(Access::Write));
        env.server.store().set_approval(&caller.client_id, false).unwrap();
        let client = env.client(&token, lifecycle.clone()).await;

        let arguments = json!({ "vault": "Notes", "path": "t.md", "edits": [{ "oldText": "a", "newText": "z" }] });
        let result = tokio::time::timeout(Duration::from_secs(5), client.call_tool(call("edit_note", arguments)));
        let result = result.await.expect("no wait for anyone").unwrap();
        assert_eq!(result.is_error, Some(false), "{result:?}");
        assert_eq!(env.test.on_disk("t.md").as_deref(), Some("z\nb\nc\n"));
        let audit = env.test.events.last_audit();
        assert_eq!((audit.decision, audit.approval_wait_ms), (Decision::Allowed, None), "{lifecycle:?}");
        assert!(env.server.pending_approvals().is_empty());
        assert!(client.service().progress.lock().unwrap().is_empty(), "nothing to wait for");
        client.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn refuses_requests_without_a_valid_token() {
    let env = Env::start().await;
    let (caller, token) = env.test.client("claude", None);

    async fn refused(response: reqwest::Response, token_sent: bool) {
        assert_eq!(response.status(), 401);
        let challenge = response.headers()[WWW_AUTHENTICATE].to_str().unwrap().to_owned();
        assert!(challenge.starts_with("Bearer "), "{challenge}");
        assert_eq!(challenge.contains(r#"error="invalid_token""#), token_sent, "{challenge}");
        let body: Json = serde_json::from_str(&response.text().await.unwrap()).unwrap();
        assert_eq!((body["jsonrpc"].clone(), body["id"].clone()), (json!("2.0"), Json::Null), "{body}");
        assert_eq!(body["error"]["code"], -32001, "{body}");
        assert!(body["error"]["message"].as_str().unwrap().contains("token"), "{body}");
    }

    refused(env.post(None).body(initialize_body()).send().await.unwrap(), false).await;
    let basic = env.post(None).header(AUTHORIZATION, format!("Basic {token}"));
    refused(basic.body(initialize_body()).send().await.unwrap(), false).await;
    refused(env.post(Some("itztli_wrong")).body(initialize_body()).send().await.unwrap(), true).await;
    let get = reqwest::Client::new().get(env.url()).header(ACCEPT, "text/event-stream");
    refused(get.send().await.unwrap(), false).await;

    let session = env.initialize(&token).await;
    let listed = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }).to_string();
    let response = env.post(Some(&token)).header("mcp-session-id", &session).body(listed.clone()).send().await;
    assert_eq!(response.unwrap().status(), 200);

    // Revoking the client stops its token at once, mid-session too.
    env.server.store().revoke_client(&caller.client_id).unwrap();
    let response = env.post(Some(&token)).header("mcp-session-id", &session).body(listed).send().await;
    refused(response.unwrap(), true).await;
    refused(env.post(Some(&token)).body(initialize_body()).send().await.unwrap(), true).await;
}

#[tokio::test]
async fn refuses_web_pages_foreign_hosts_and_large_bodies() {
    let env = Env::start().await;
    let (_, token) = env.test.client("claude", None);
    let port = env.addr.port();

    // Browsers send Origin; MCP clients don't.
    for origin in ["http://evil.example", &format!("http://127.0.0.1:{port}"), "null"] {
        let response = env.post(Some(&token)).header(ORIGIN, origin).body(initialize_body()).send().await.unwrap();
        assert_eq!(response.status(), 403, "{origin}");
    }
    // DNS rebinding: a name the attacker controls, resolving to 127.0.0.1.
    for host in ["evil.example".to_owned(), format!("evil.example:{port}"), format!("localhost.evil.example:{port}")] {
        let response = env.post(Some(&token)).header(HOST, &host).body(initialize_body()).send().await.unwrap();
        assert_eq!(response.status(), 403, "{host}");
    }
    let loopback = [format!("127.0.0.1:{port}"), "127.0.0.1".into(), format!("localhost:{port}"), "[::1]".into()];
    for host in loopback {
        let response = env.post(Some(&token)).header(HOST, &host).body(initialize_body()).send().await.unwrap();
        assert_eq!(response.status(), 200, "{host}");
    }

    let (body, headers) = modern_call(1, "search_notes", json!({ "vault": "Notes", "query": "x".repeat(1024 * 1024) }));
    let mut request = env.post(Some(&token));
    for (name, value) in headers {
        request = request.header(name, value);
    }
    assert_eq!(request.body(body).send().await.unwrap().status(), 413);
}

#[tokio::test]
async fn a_modern_call_gets_plain_json() {
    let env = Env::start().await;
    let (_, token) = env.test.client("claude", Some(Access::Read));

    let (body, headers) = modern_call(7, "read_note", json!({ "vault": "Notes", "path": "t.md" }));
    let mut request = env.post(Some(&token));
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request.body(body).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()[CONTENT_TYPE], "application/json");
    let message: Json = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(message["id"], 7, "{message}");
    assert_eq!(message["result"]["structuredContent"]["text"], NOTE, "{message}");
    let audit = env.test.events.last_audit();
    assert_eq!((audit.client_info_name.as_deref(), audit.client_info_version.as_deref()), (Some("curl"), Some("8.7")));
    assert_eq!((audit.protocol_version.as_deref(), audit.session_key.as_deref()), (Some("2026-07-28"), None));
}

#[tokio::test]
async fn audits_the_session_key_and_the_bridge() {
    let env = Env::start().await;
    let (_, token) = env.test.client("claude", Some(Access::Read));

    // A 2025-03-26 client: `initialize`, then its session and no protocol
    // header.
    let session = env.initialize(&token).await;
    let body = legacy_call(2, "list_vaults", json!({}));
    let response = env.post(Some(&token)).header("mcp-session-id", &session).body(body).send().await.unwrap();
    assert_eq!(response.headers()[CONTENT_TYPE], "text/event-stream");
    let messages = sse_messages(&response.text().await.unwrap());
    assert_eq!(messages.last().unwrap()["result"]["structuredContent"]["vaults"][0]["name"], "Notes");
    let audit = env.test.events.last_audit();
    assert_eq!(audit.session_key.as_deref(), Some(session.as_str()));
    assert_eq!(audit.protocol_version.as_deref(), Some("2025-03-26"));
    assert_eq!(audit.client_info_name.as_deref(), Some("curl"));
    assert_eq!(audit.transport, Transport::Http);

    // The stdio bridge says so, and names itself.
    let headers = HashMap::from([
        (HeaderName::from_static("x-itztli-transport"), HeaderValue::from_static("bridge")),
        (HeaderName::from_static("x-itztli-bridge-instance"), HeaderValue::from_static("bridge-4b1d")),
    ]);
    let client = env.client_with(&token, Lifecycle::Modern, headers).await;
    client.call_tool(call("list_vaults", json!({}))).await.unwrap();
    let audit = env.test.events.last_audit();
    assert_eq!((audit.transport, audit.session_key.as_deref()), (Transport::Bridge, Some("bridge-4b1d")));
    assert_eq!(audit.client_info_name.as_deref(), Some("claude-code"));
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn stopping_closes_the_port_and_withdraws_pending_writes() {
    for lifecycle in [Lifecycle::Modern, Lifecycle::Legacy(ProtocolVersion::V_2025_06_18)] {
        let env = Env::start().await;
        let (_, token) = env.test.client("claude", Some(Access::Write));
        let client = env.client(&token, lifecycle).await;
        let listening = ServerStatus { running: true, port: Some(env.addr.port()), url: Some(env.url()), error: None };
        assert_eq!(env.server.status(), listening);

        let mut events = env.test.events.subscribe();
        let delete = json!({ "vault": "Notes", "path": "t.md" });
        let call = tokio::spawn(async move { client.call_tool(call("delete_note", delete)).await });
        let request = next_approval(&mut events).await;

        env.server.stop().await;
        assert_withdrawn(&next_audit(&mut events).await, "Itztli's MCP server was stopped");
        let resolved =
            env.test.events.all().into_iter().any(
                |event| matches!(event, McpEvent::ApprovalResolved { id, decision: Decision::Withdrawn } if id == request.id),
            );
        assert!(resolved);
        assert!(env.server.pending_approvals().is_empty());
        assert_eq!(next_status(&mut events).await, ServerStatus::default());
        assert_eq!(env.server.status(), ServerStatus::default());
        assert!(!answers(env.addr).await);
        // The change was never made. (A client in a session may keep trying to
        // resume the stream it was answered on.)
        assert_eq!(env.test.on_disk("t.md").as_deref(), Some(NOTE));
        call.abort();

        // Stopping again is harmless.
        env.server.stop().await;
        assert_eq!(next_status(&mut events).await, ServerStatus::default());
    }
}

#[tokio::test]
async fn restarts_on_another_port_and_reports_a_port_in_use() {
    let env = Env::start().await;
    let (_, token) = env.test.client("claude", None);
    let mut events = env.test.events.subscribe();

    // A port the system just handed out, and nobody holds.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let moved = env.server.start(&on_port(port)).await.unwrap();
    assert_eq!(moved, SocketAddr::from(([127, 0, 0, 1], port)));
    // Only where it ended up.
    let listening =
        ServerStatus { running: true, port: Some(port), url: Some(format!("http://127.0.0.1:{port}/mcp")), error: None };
    assert_eq!(next_status(&mut events).await, listening);
    assert!(!answers(env.addr).await);
    // And again on the same port, as when the user saves other settings.
    assert_eq!(env.server.start(&on_port(port)).await.unwrap(), moved);
    assert_eq!(next_status(&mut events).await, listening);
    let config = StreamableHttpClientTransportConfig::with_uri(listening.url.clone().unwrap()).auth_header(token);
    let client = ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 14);
    client.cancel().await.unwrap();

    // A port another program holds.
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let error = env.server.start(&on_port(port)).await.unwrap_err();
    assert_eq!(error, StartError::PortInUse { port });
    let failed = ServerStatus { error: Some(error.to_string()), ..ServerStatus::default() };
    assert_eq!(next_status(&mut events).await, failed);
    assert_eq!(env.server.status(), failed);
    // Starting stopped the previous listener first.
    assert!(!answers(moved).await);

    let addr = env.server.start(&on_port(0)).await.unwrap();
    assert!(env.server.status().running);
    assert!(answers(addr).await);
    drop(taken);
}

#[tokio::test]
async fn a_dropped_connection_cancels_a_call_outside_a_session() {
    let env = Env::start().await;
    let (_, token) = env.test.client("claude", Some(Access::Write));
    let mut events = env.test.events.subscribe();

    // While nothing was answered yet, and once the answer became an SSE
    // stream of progress reports.
    for progress_token in [None, Some("p1")] {
        let delete = json!({ "vault": "Notes", "path": "t.md" });
        let (mut body, headers) = modern_call(3, "delete_note", delete);
        if let Some(token) = progress_token {
            let mut request: Json = serde_json::from_str(&body).unwrap();
            request["params"]["_meta"]["progressToken"] = json!(token);
            body = request.to_string();
        }
        let mut connection = raw_post(env.addr, &token, &headers, &body).await;
        next_approval(&mut events).await;
        if progress_token.is_some() {
            let mut head = vec![0; 4096];
            let read = tokio::time::timeout(Duration::from_secs(5), connection.read(&mut head)).await;
            let head = String::from_utf8_lossy(&head[..read.unwrap().unwrap()]).into_owned();
            assert!(head.contains("text/event-stream") && head.contains("notifications/progress"), "{head}");
        }
        drop(connection);

        assert_withdrawn(&next_audit(&mut events).await, CANCELLED);
        assert!(env.server.pending_approvals().is_empty());
        assert_eq!(env.test.on_disk("t.md").as_deref(), Some(NOTE));
    }
}

#[tokio::test]
async fn in_a_session_only_the_client_cancels_a_call() {
    // rmcp keeps a session's call running when its stream drops, for the
    // client to resume it; the client cancels with notifications/cancelled.
    let env = Env::start().await;
    let (_, token) = env.test.client("claude", Some(Access::Write));
    let session = env.initialize(&token).await;
    let mut events = env.test.events.subscribe();

    let body = legacy_call(3, "delete_note", json!({ "vault": "Notes", "path": "t.md" }));
    let connection = raw_post(env.addr, &token, &[("mcp-session-id", session.clone())], &body).await;
    next_approval(&mut events).await;
    drop(connection);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(env.server.pending_approvals().len(), 1);

    let cancelled = json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 3 } });
    let response = env.post(Some(&token)).header("mcp-session-id", &session).body(cancelled.to_string()).send().await;
    assert_eq!(response.unwrap().status(), 202);
    assert_withdrawn(&next_audit(&mut events).await, CANCELLED);
    assert!(env.server.pending_approvals().is_empty());
    assert_eq!(env.test.on_disk("t.md").as_deref(), Some(NOTE));
}
