//! A server over a vault of its own, for tests. Built with the `testing`
//! feature.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use itztli_backend::{Backend, VaultInfo};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::{
    Access, AuditEntry, Caller, Grant, Host, McpEvent, McpServer, McpSettings, Store, Transport, lock, new_token, settings,
};

/// What the server reported, oldest first.
pub struct Events {
    all: Mutex<Vec<McpEvent>>,
    sender: broadcast::Sender<McpEvent>,
}

impl Default for Events {
    fn default() -> Self {
        Self { all: Mutex::default(), sender: broadcast::channel(1024).0 }
    }
}

impl Events {
    pub fn add(&self, event: McpEvent) {
        lock(&self.all).push(event.clone());
        let _ = self.sender.send(event);
    }

    pub fn all(&self) -> Vec<McpEvent> {
        lock(&self.all).clone()
    }

    pub fn clear(&self) {
        lock(&self.all).clear();
    }

    /// Events from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<McpEvent> {
        self.sender.subscribe()
    }

    /// The audit rows reported so far.
    pub fn audit(&self) -> Vec<AuditEntry> {
        let audit = |event| match event {
            McpEvent::Audit(entry) => Some(entry),
            _ => None,
        };
        self.all().into_iter().filter_map(audit).collect()
    }

    pub fn last_audit(&self) -> AuditEntry {
        self.audit().pop().expect("an audit row")
    }
}

struct TestHost {
    backend: Backend,
    events: Arc<Events>,
}

impl Host for TestHost {
    fn backend(&self) -> &Backend {
        &self.backend
    }

    fn notify(&self, event: McpEvent) {
        self.events.add(event);
    }

    fn bridge_command(&self) -> Option<String> {
        Some("/bin/itztli".into())
    }
}

struct Silent;

impl itztli_backend::Events for Silent {
    fn emit(&self, _: &'static str, _: Value) {}
}

pub struct TestVault {
    pub server: McpServer,
    pub events: Arc<Events>,
    host: Arc<TestHost>,
    root: tempfile::TempDir,
}

impl TestVault {
    /// With the vault open, holding these files.
    pub async fn new(files: &[(&str, &str)]) -> Self {
        let root = tempfile::tempdir().expect("a folder");
        let backend = Backend::new(&root.path().join("data"), Arc::new(Silent)).expect("a backend");
        let backend = backend.with_trash_folder(root.path().join("trash"));
        let events = Arc::new(Events::default());
        let host = Arc::new(TestHost { backend, events: events.clone() });
        let store = Store::in_memory().expect("an in-memory store");
        // Often enough for a test to see a change's progress reports.
        let server = McpServer::with_progress_every(store, host.clone(), Duration::from_millis(100));
        let test = Self { server, events, host, root };
        test.write(files);
        test.open("Notes").await;
        test
    }

    pub fn backend(&self) -> &Backend {
        &self.host.backend
    }

    /// Opens a vault, making its folder if it is not there.
    pub async fn open(&self, name: &str) -> VaultInfo {
        let folder = self.root.path().join(name);
        std::fs::create_dir_all(&folder).expect("the vault's folder");
        let info = self.backend().open_vault(&folder).expect("the vault opens");
        self.until(|| self.backend().workspace().is_ok_and(|w| w.status().ready)).await;
        info
    }

    pub fn info(&self) -> VaultInfo {
        self.backend().workspace().expect("a vault is open").info.clone()
    }

    pub fn folder(&self) -> PathBuf {
        self.root.path().join("Notes")
    }

    pub fn write(&self, files: &[(&str, &str)]) {
        std::fs::create_dir_all(self.folder()).expect("the vault's folder");
        for (path, text) in files {
            let file = self.folder().join(path);
            std::fs::create_dir_all(file.parent().expect("a folder")).expect("the note's folder");
            std::fs::write(file, text).expect("the note is written");
        }
    }

    /// What a note says on disk; None when it is not there.
    pub fn on_disk(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.folder().join(path)).ok()
    }

    pub async fn until(&self, done: impl Fn() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("waited 10 s in vain");
    }

    /// Registers a client with access to the open vault; returns it as a
    /// caller over HTTP, and its token.
    pub fn client(&self, name: &str, access: Option<Access>) -> (Caller, String) {
        let (token, hash, prefix) = new_token();
        let store = self.server.store();
        let client = store.create_client(name, &hash, &prefix, None).expect("create the client");
        if let Some(access) = access {
            self.grant(&client.id, access);
        }
        let caller = Caller {
            client_id: client.id,
            client_name: client.name,
            client_info: None,
            protocol_version: None,
            transport: Transport::Http,
            session_key: None,
        };
        (caller, token)
    }

    /// Sets what the client may do in the open vault.
    pub fn grant(&self, client_id: &str, access: Access) {
        let info = self.info();
        let vault_path = info.path.display().to_string();
        let grant = Grant { vault_id: info.id, vault_name: info.name, vault_path, access };
        self.server.store().set_grant(client_id, &grant).expect("grant").expect("the client exists");
    }

    /// Saves settings as they are, without starting or stopping anything.
    pub fn save(&self, settings: &McpSettings) {
        settings::save(self.server.store(), settings).expect("save the settings");
    }

    /// Puts a port nothing uses in the settings.
    pub fn free_port(&self) -> McpSettings {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
        let port = listener.local_addr().expect("its address").port();
        let settings = McpSettings { port, ..McpSettings::default() };
        self.save(&settings);
        settings
    }
}
