use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::*;

#[derive(Default)]
struct Recorded(Mutex<Vec<(&'static str, Value)>>);

impl Events for Recorded {
    fn emit(&self, name: &'static str, payload: Value) {
        lock(&self.0).push((name, payload));
    }
}

struct Setup {
    root: tempfile::TempDir,
    events: Arc<Recorded>,
    backend: Backend,
}

impl Setup {
    fn new(files: &[(&str, &str)]) -> Self {
        let root = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let file = root.path().join("vault").join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        std::fs::create_dir_all(root.path().join("vault")).unwrap();
        let events = Arc::new(Recorded::default());
        let backend =
            Backend::new(&root.path().join("data"), events.clone()).unwrap().with_trash_folder(root.path().join("trash"));
        let setup = Self { root, events, backend };
        setup.backend.open_vault(&setup.vault()).unwrap();
        setup.until("the index is ready", || setup.ok("index_status", json!({}))["ready"] == json!(true));
        setup
    }

    fn vault(&self) -> PathBuf {
        self.root.path().join("vault")
    }

    fn ok(&self, command: &str, args: Value) -> Value {
        self.backend.call(command, args).unwrap_or_else(|e| panic!("{command}: {e}"))
    }

    fn fails(&self, command: &str, args: Value) -> ErrorCode {
        self.backend.call(command, args).expect_err(command).code
    }

    fn until(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !done() {
            assert!(Instant::now() < deadline, "waiting until {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn on_disk(&self, path: &str) -> String {
        std::fs::read_to_string(self.vault().join(path)).unwrap()
    }

    fn changes(&self, origin: &str) -> Vec<Value> {
        lock(&self.events.0)
            .iter()
            .filter(|(name, payload)| *name == event::VAULT_CHANGED && payload["origin"] == origin)
            .flat_map(|(_, payload)| payload["changes"].as_array().unwrap().clone())
            .collect()
    }
}

#[test]
fn indexes_on_opening_and_remembers_the_vault() {
    let s = Setup::new(&[("a.md", "[[b]]"), ("sub/b.md", "# B")]);
    assert_eq!(s.ok("index_status", json!({}))["notes"], 2);
    assert_eq!(s.ok("usages", json!({ "path": "sub/b.md" }))[0]["links"][0]["context"], "[[b]]");
    let recents = s.ok("vault_recents", json!({}));
    assert_eq!((recents[0]["name"].as_str(), recents[0]["exists"].as_bool()), (Some("vault"), Some(true)));
    let id = recents[0]["id"].clone();
    s.ok("vault_close", json!({}));
    assert_eq!(s.fails("vault_entries", json!({})), ErrorCode::NoVault);
    s.ok("vault_open", json!({ "id": id }));
    assert_eq!(s.ok("vault_entries", json!({})).as_array().unwrap().len(), 3);
}

#[test]
fn commands_cannot_open_other_folders() {
    let s = Setup::new(&[]);
    assert_eq!(s.fails("vault_open", json!({ "id": "/etc" })), ErrorCode::NotFound);
}

#[test]
fn writing_updates_links_and_keeps_history() {
    let s = Setup::new(&[("a.md", "nothing"), ("b.md", "")]);
    let read = s.ok("note_read", json!({ "path": "a.md" }));
    let revision = s.ok("note_write", json!({ "path": "a.md", "text": "now [[b]]", "base": read["revision"] }));
    assert_eq!(s.ok("usages", json!({ "path": "b.md" }))[0]["path"], "a.md");
    assert_eq!(s.fails("note_write", json!({ "path": "a.md", "text": "x", "base": "stale" })), ErrorCode::Conflict);
    s.ok("note_write", json!({ "path": "a.md", "text": "", "base": revision }));

    let history = s.ok("history_list", json!({ "path": "a.md" }));
    let oldest = history.as_array().unwrap().last().unwrap();
    assert_eq!(s.ok("history_text", json!({ "id": oldest["id"] })), json!("nothing"));
}

#[test]
fn creating_makes_the_folders_known() {
    let s = Setup::new(&[]);
    s.ok("note_create", json!({ "path": "x/y/n.md", "text": "" }));
    let put: Vec<String> = s.changes("app").iter().map(|c| c["entry"]["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(put, ["x", "x/y", "x/y/n.md"]);
    assert_eq!(s.ok("note_create_free", json!({ "folder": "x/y", "name": "n.md" })), json!("x/y/n 2.md"));
    assert_eq!(s.ok("entry_duplicate", json!({ "path": "x/y/n.md" })), json!("x/y/n 3.md"));
    assert_eq!(s.fails("note_create", json!({ "path": "x/y/n.md", "text": "" })), ErrorCode::Exists);
}

#[test]
fn attachments_are_bytes_under_a_free_name() {
    let s = Setup::new(&[]);
    let add = || s.ok("attachment_create", json!({ "folder": "img", "name": "a.png", "base64": "iVBORw==" }));
    assert_eq!((add(), add()), (json!("img/a.png"), json!("img/a 2.png")));
    assert_eq!(std::fs::read(s.vault().join("img/a.png")).unwrap(), [0x89, 0x50, 0x4e, 0x47]);
    assert_eq!(
        s.fails("attachment_create", json!({ "folder": ".itztli", "name": "x", "base64": "" })),
        ErrorCode::InvalidArgument
    );
    assert_eq!(s.fails("attachment_create", json!({ "folder": "", "name": "x", "base64": "?" })), ErrorCode::InvalidArgument);
}

#[test]
fn renaming_rewrites_links_on_disk() {
    let s = Setup::new(&[("Old.md", "# Old"), ("a.md", "[[Old]] and [m](Old.md)"), ("f/b.md", "![[Old#x]]"), ("c.md", "Old")]);
    let preview = s.ok("entry_move_preview", json!({ "from": "Old.md", "to": "f/New.md" }));
    assert_eq!(preview, json!([{ "path": "a.md", "links": 2 }, { "path": "f/b.md", "links": 1 }]));
    assert_eq!(s.on_disk("a.md"), "[[Old]] and [m](Old.md)", "a preview changes nothing");

    let moved = s.ok("entry_move", json!({ "from": "Old.md", "to": "f/New.md" }));
    assert_eq!((moved["relinked"].as_array().unwrap().len(), &moved["failed"]), (2, &json!([])));
    assert_eq!(s.on_disk("a.md"), "[[New]] and [m](f/New.md)");
    assert_eq!(s.on_disk("f/b.md"), "![[New#x]]");
    assert_eq!(s.ok("usages", json!({ "path": "f/New.md" })).as_array().unwrap().len(), 2);
    assert_eq!(s.ok("history_list", json!({ "path": "a.md" }))[0]["reason"], "refactor");
    assert_eq!(s.fails("entry_move", json!({ "from": "a.md", "to": "c.md" })), ErrorCode::Exists);
}

#[test]
fn trashing_keeps_the_text() {
    let s = Setup::new(&[("f/a.md", "precious")]);
    s.ok("entry_trash", json!({ "path": "f" }));
    assert!(s.root.path().join("trash/f/a.md").exists());
    assert_eq!(s.ok("vault_entries", json!({})), json!([]));
    assert_eq!(s.ok("history_list", json!({ "path": "f/a.md" }))[0]["reason"], "delete");
}

#[test]
fn notices_changes_made_elsewhere() {
    let s = Setup::new(&[("a.md", ""), ("gone.md", "")]);
    std::fs::write(s.vault().join("new.md"), "[[a]]").unwrap();
    std::fs::remove_file(s.vault().join("gone.md")).unwrap();
    s.until("the new note is indexed", || s.ok("usages", json!({ "path": "a.md" })).as_array().unwrap().len() == 1);
    s.until("the removed one is gone", || s.ok("vault_entries", json!({})).as_array().unwrap().len() == 2);
    let kinds: Vec<Value> = s.changes("disk").into_iter().map(|c| c["kind"].clone()).collect();
    assert!(kinds.contains(&json!("put")) && kinds.contains(&json!("remove")));
}

#[test]
fn its_own_changes_are_not_reported_as_others() {
    let s = Setup::new(&[("a.md", "")]);
    s.ok("note_write", json!({ "path": "a.md", "text": "mine" }));
    s.ok("entry_move", json!({ "from": "a.md", "to": "b.md" }));
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(s.changes("disk"), Vec::<Value>::new());
}

#[test]
fn hidden_folders_are_not_for_commands() {
    let s = Setup::new(&[("a.md", "")]);
    for path in [".itztli/plugins/x/main.js", ".git/hooks/post-commit", "x/.hidden.md"] {
        assert_eq!(s.fails("note_write", json!({ "path": path, "text": "x" })), ErrorCode::InvalidArgument);
        assert_eq!(s.fails("note_create", json!({ "path": path, "text": "x" })), ErrorCode::InvalidArgument);
        assert_eq!(s.fails("entry_move", json!({ "from": "a.md", "to": path })), ErrorCode::InvalidArgument);
    }
    for name in ["plugins/x", "../x", "a/b/c", "X"] {
        assert_eq!(s.fails("config_set", json!({ "name": name, "value": 1 })), ErrorCode::InvalidArgument);
    }
    for name in ["trust", "recents", "../x", "workspace-../x"] {
        assert_eq!(s.fails("state_set", json!({ "name": name, "value": {} })), ErrorCode::InvalidArgument, "{name}");
    }
}

#[test]
fn configs_and_state_round_trip() {
    let s = Setup::new(&[]);
    assert_eq!(s.ok("config_get", json!({ "name": "bookmarks" })), Value::Null);
    s.ok("config_set", json!({ "name": "plugin-data/demo", "value": { "n": 1 } }));
    assert_eq!(s.ok("config_get", json!({ "name": "plugin-data/demo" })), json!({ "n": 1 }));
    s.ok("state_set", json!({ "name": "settings", "value": { "theme": "dark" } }));
    assert_eq!(s.ok("state_get", json!({ "name": "settings" })), json!({ "theme": "dark" }));
    assert_eq!(s.ok("state_get", json!({ "name": "workspace-0a1b" })), Value::Null);
}

#[test]
fn excerpts_follow_links() {
    let s = Setup::new(&[("sub/a.md", "# A\n\n## B\n\ntext\n"), ("x.md", "")]);
    let whole = s.ok("excerpt", json!({ "source": "x.md", "target": "a" }));
    assert_eq!((whole["path"].as_str(), whole["line"].as_u64()), (Some("sub/a.md"), Some(0)));
    let part = s.ok("excerpt", json!({ "source": "x.md", "target": "a", "subpath": "B" }));
    assert_eq!((part["text"].as_str(), part["line"].as_u64()), (Some("## B\n\ntext"), Some(2)));
    assert_eq!(s.fails("excerpt", json!({ "source": "x.md", "target": "zzz" })), ErrorCode::NotFound);
    assert_eq!(s.fails("excerpt", json!({ "source": "x.md", "target": "a", "subpath": "Z" })), ErrorCode::NotFound);
}

#[test]
fn searches_text_on_disk() {
    let s = Setup::new(&[("a.md", "una canción"), ("b/c.md", "cancion cancion"), ("i.png", "cancion")]);
    let found = s.ok("search_text", json!({ "text": "cancion", "limit": 100 }));
    assert_eq!((found["total"].as_u64(), found["files"].as_array().unwrap().len()), (Some(3), 2));
    assert_eq!(s.ok("search_text", json!({ "text": "cancion", "folder": "b" }))["total"], 2);
    assert_eq!(s.fails("search_text", json!({ "text": "(", "regex": true })), ErrorCode::InvalidArgument);
}

#[test]
fn plugins_need_consent_and_respect_safe_mode() {
    let s = Setup::new(&[]);
    s.ok("plugin_create", json!({ "id": "demo", "name": "Demo", "scope": "vault" }));
    assert_eq!(s.fails("plugin_load", json!({ "id": "demo" })), ErrorCode::Plugin);
    let info = s.backend.plugin("demo").unwrap();
    s.backend.grant_plugin("demo", &info.fingerprint.unwrap(), false).unwrap();
    let loaded = s.ok("plugin_load", json!({ "id": "demo" }));
    let file = format!("{}/main.js", loaded["token"].as_str().unwrap());
    assert!(s.backend.plugins().file(&file).is_some());
    s.ok("vault_close", json!({}));
    assert!(s.backend.plugins().file(&file).is_none(), "closing the vault stops its plugins");

    let safe = Backend::new(&s.root.path().join("data"), s.events.clone()).unwrap().with_safe_mode(true);
    safe.open_vault(&s.vault()).unwrap();
    assert_eq!(safe.call("plugin_load", json!({ "id": "demo" })).unwrap_err().code, ErrorCode::Plugin);
}

#[test]
fn editing_a_plugin_is_noticed() {
    let s = Setup::new(&[]);
    s.ok("plugin_create", json!({ "id": "demo", "name": "Demo", "scope": "vault" }));
    let main = s.vault().join(".itztli/plugins/demo/main.js");
    let noticed = || {
        std::fs::write(&main, format!("// {:?}", Instant::now())).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let events = lock(&s.events.0);
        events.iter().filter(|(n, p)| *n == event::PLUGINS_CHANGED && p["folders"] == json!(["demo"])).count() > 1
    };
    s.until("the edit is noticed", noticed);
}

#[test]
fn the_welcome_vault_has_no_broken_links_but_one_on_purpose() {
    let s = Setup::new(&[]);
    s.backend.write_welcome(&s.vault()).unwrap();
    s.backend.write_welcome(&s.vault()).unwrap();
    s.ok("vault_close", json!({}));
    s.backend.open_vault(&s.vault()).unwrap();
    s.until("the index is ready", || s.ok("index_status", json!({}))["ready"] == json!(true));
    let problems = s.ok("problems", json!({}));
    let missing: Vec<&str> = problems.as_array().unwrap().iter().map(|p| p["target"].as_str().unwrap()).collect();
    assert_eq!(missing, ["My first note"]);
}

#[test]
fn names_cannot_add_lines_to_a_dialog() {
    assert_eq!(printable("Nice\n\nIt is safe\u{7}"), "NiceIt is safe");
    assert_eq!(printable(&"x".repeat(500)).len(), 80);
}
