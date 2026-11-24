//! Plugins on disk, and which of them may run.
//!
//! A plugin runs inside the app with the app's own powers, so running one is
//! the user's decision and nobody else's:
//!
//! - A plugin that arrives with a vault (synced, cloned, sent by someone)
//!   stays off until the user enables it on this computer.
//! - Consent is for the exact files the user saw. If one changes, the plugin
//!   stops until it is reviewed again.
//! - What runs is what was checked: files are read once, fingerprinted and
//!   served from memory.
//! - A plugin under development can be trusted by its folder instead, so
//!   editing it doesn't ask every time. That is a separate, explicit choice.

mod manifest;
mod package;
mod scaffold;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

pub use manifest::{API_VERSION, MANIFEST_FILE, Manifest, Setting, SettingKind, SettingOption, is_id};
pub use package::Package;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("there is no plugin “{0}”")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("“{0}” is not enabled")]
    NotEnabled(String),
    #[error("“{0}” changed while it was being reviewed; look at it again")]
    Changed(String),
    #[error("there is already a plugin “{0}”")]
    Exists(String),
    #[error("{0}: {1}")]
    Io(String, std::io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    /// In the app's data folder: available in every vault.
    User,
    /// In the vault's `.itztli/plugins`: travels with it.
    Vault,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Disabled,
    Enabled,
    /// Was enabled, and its files changed since.
    NeedsReview,
    /// Can't be loaded; see `error`.
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub scope: Scope,
    pub status: Status,
    /// Trusted by its folder; reloads as its files change.
    pub development: bool,
    pub manifest: Option<Manifest>,
    pub error: Option<String>,
    pub fingerprint: Option<String>,
    /// For showing it in the file manager.
    pub folder: PathBuf,
}

/// What the app needs to run a plugin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub manifest: Manifest,
    /// Where its files are served: `<token>/main.js`. Unguessable, and new
    /// on every load, so a reload never gets a cached module.
    pub token: String,
    pub development: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    fingerprint: String,
    #[serde(default)]
    development: bool,
}

/// `trust.json` in the app's data folder; never in a vault.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Trust {
    grants: BTreeMap<String, Grant>,
    /// Built-in plugins the user turned off.
    builtin_off: BTreeSet<String>,
    remote_images: bool,
}

struct Served {
    key: String,
    files: BTreeMap<String, Vec<u8>>,
    network: Vec<String>,
}

/// The open vault, as far as plugins are concerned.
#[derive(Debug, Clone)]
pub struct VaultPlugins {
    pub vault_id: String,
    /// The vault's `.itztli/plugins`.
    pub folder: PathBuf,
}

pub struct Plugins {
    user_folder: PathBuf,
    trust_file: PathBuf,
    trust: Mutex<Trust>,
    served: Mutex<HashMap<String, Served>>,
}

impl Plugins {
    /// `data` is the app's data folder.
    pub fn open(data: &Path) -> Self {
        let trust_file = data.join("trust.json");
        // Unreadable trust means no trust.
        let trust = fs::read(&trust_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { user_folder: data.join("plugins"), trust_file, trust: Mutex::new(trust), served: Mutex::default() }
    }

    fn trust(&self) -> MutexGuard<'_, Trust> {
        self.trust.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn served(&self) -> MutexGuard<'_, HashMap<String, Served>> {
        self.served.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn change_trust(&self, change: impl FnOnce(&mut Trust)) -> Result<()> {
        let mut trust = self.trust();
        let mut next = trust.clone();
        change(&mut next);
        let json = serde_json::to_vec_pretty(&next).map_err(|e| Error::Invalid(e.to_string()))?;
        write_atomic(&self.trust_file, &json).map_err(|e| Error::Io("cannot save the plugin settings".into(), e))?;
        *trust = next;
        Ok(())
    }

    pub fn user_folder(&self) -> &Path {
        &self.user_folder
    }

    fn folder(&self, scope: Scope, vault: Option<&VaultPlugins>) -> Option<PathBuf> {
        match scope {
            Scope::User => Some(self.user_folder.clone()),
            Scope::Vault => vault.map(|v| v.folder.clone()),
        }
    }

    /// Consent for a vault's plugin is for that vault on this computer.
    fn key(scope: Scope, vault: Option<&VaultPlugins>, id: &str) -> Option<String> {
        match scope {
            Scope::User => Some(format!("user/{id}")),
            Scope::Vault => vault.map(|v| format!("{}/{id}", v.vault_id)),
        }
    }

    /// Where a plugin is. One in the app's folder hides a vault's with the
    /// same id, so a vault can't take over a plugin the user already has.
    fn find(&self, id: &str, vault: Option<&VaultPlugins>) -> Result<(Scope, PathBuf)> {
        if !is_id(id) {
            return Err(Error::NotFound(id.to_owned()));
        }
        [Scope::User, Scope::Vault]
            .into_iter()
            .filter_map(|scope| Some((scope, self.folder(scope, vault)?.join(id))))
            .find(|(_, dir)| dir.join(MANIFEST_FILE).is_file())
            .ok_or_else(|| Error::NotFound(id.to_owned()))
    }

    pub fn list(&self, vault: Option<&VaultPlugins>) -> Vec<PluginInfo> {
        let mut found: BTreeMap<String, PluginInfo> = BTreeMap::new();
        for scope in [Scope::User, Scope::Vault] {
            let Some(folder) = self.folder(scope, vault) else { continue };
            let Ok(children) = fs::read_dir(&folder) else { continue };
            for child in children.flatten() {
                let dir = child.path();
                let Some(id) = child.file_name().to_str().map(str::to_owned) else { continue };
                if dir.join(MANIFEST_FILE).is_file() && !found.contains_key(&id) {
                    let info = self.info(&id, scope, vault, dir);
                    found.insert(id, info);
                }
            }
        }
        found.into_values().collect()
    }

    fn info(&self, id: &str, scope: Scope, vault: Option<&VaultPlugins>, folder: PathBuf) -> PluginInfo {
        let grant = Self::key(scope, vault, id).and_then(|key| self.trust().grants.get(&key).cloned());
        let development = grant.as_ref().is_some_and(|g| g.development);
        match Package::read(&folder) {
            Ok(package) => {
                let status = match &grant {
                    None => Status::Disabled,
                    Some(g) if g.development || g.fingerprint == package.fingerprint => Status::Enabled,
                    Some(_) => Status::NeedsReview,
                };
                PluginInfo {
                    id: id.to_owned(),
                    scope,
                    status,
                    development,
                    manifest: Some(package.manifest),
                    error: None,
                    fingerprint: Some(package.fingerprint),
                    folder,
                }
            }
            Err(error) => PluginInfo {
                id: id.to_owned(),
                scope,
                status: Status::Invalid,
                development,
                manifest: None,
                error: Some(error),
                fingerprint: None,
                folder,
            },
        }
    }

    pub fn get(&self, id: &str, vault: Option<&VaultPlugins>) -> Result<PluginInfo> {
        let (scope, dir) = self.find(id, vault)?;
        Ok(self.info(id, scope, vault, dir))
    }

    /// Enables a plugin as the user saw it. Only call this after asking the
    /// user, in a dialog the plugins themselves can't reach.
    pub fn grant(&self, id: &str, vault: Option<&VaultPlugins>, fingerprint: &str, development: bool) -> Result<()> {
        let (scope, dir) = self.find(id, vault)?;
        let package = Package::read(&dir).map_err(Error::Invalid)?;
        if package.fingerprint != fingerprint {
            return Err(Error::Changed(package.manifest.name));
        }
        let key = Self::key(scope, vault, id).ok_or_else(|| Error::NotFound(id.to_owned()))?;
        self.change_trust(|trust| {
            trust.grants.insert(key, Grant { fingerprint: fingerprint.to_owned(), development });
        })
    }

    pub fn revoke(&self, id: &str, vault: Option<&VaultPlugins>) -> Result<()> {
        let (scope, _) = self.find(id, vault)?;
        let key = Self::key(scope, vault, id).ok_or_else(|| Error::NotFound(id.to_owned()))?;
        self.served().retain(|_, s| s.key != key);
        self.change_trust(|trust| {
            trust.grants.remove(&key);
        })
    }

    /// Reads an enabled plugin and starts serving its files.
    pub fn load(&self, id: &str, vault: Option<&VaultPlugins>) -> Result<Loaded> {
        let (scope, dir) = self.find(id, vault)?;
        let key = Self::key(scope, vault, id).ok_or_else(|| Error::NotFound(id.to_owned()))?;
        let grant = self.trust().grants.get(&key).cloned().ok_or_else(|| Error::NotEnabled(id.to_owned()))?;
        let package = Package::read(&dir).map_err(Error::Invalid)?;
        if !grant.development && grant.fingerprint != package.fingerprint {
            return Err(Error::NotEnabled(package.manifest.name));
        }
        let token = random_token();
        let network = package.manifest.network.clone();
        let mut served = self.served();
        served.retain(|_, s| s.key != key);
        served.insert(token.clone(), Served { key, files: package.files, network });
        Ok(Loaded { manifest: package.manifest, token, development: grant.development })
    }

    /// Stops serving every plugin, e.g. when the vault closes.
    pub fn unload_all(&self) {
        self.served().clear();
    }

    /// A loaded plugin's file, by `<token>/<file>`.
    pub fn file(&self, path: &str) -> Option<(&'static str, Vec<u8>)> {
        let (token, name) = path.trim_start_matches('/').split_once('/')?;
        let bytes = self.served().get(token)?.files.get(name)?.clone();
        Some((mime(name), bytes))
    }

    /// The origins a loaded plugin may reach.
    pub fn network(&self, token: &str) -> Option<Vec<String>> {
        self.served().get(token).map(|s| s.network.clone())
    }

    /// Copies a plugin's folder into the app's, where it stays disabled.
    /// Only what the app loads is copied.
    pub fn install(&self, from: &Path) -> Result<PluginInfo> {
        let package = Package::read(from).map_err(Error::Invalid)?;
        let id = package.manifest.id.clone();
        let to = self.user_folder.join(&id);
        let failed = |e| Error::Io(format!("cannot install “{id}”"), e);
        fs::create_dir_all(&self.user_folder).map_err(failed)?;
        // Written aside and swapped in, so an update never leaves half of each.
        let staging = tempfile::Builder::new().prefix(".installing-").tempdir_in(&self.user_folder).map_err(failed)?;
        for (name, bytes) in &package.files {
            let file = staging.path().join(name);
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).map_err(failed)?;
            }
            fs::write(file, bytes).map_err(failed)?;
        }
        if to.exists() {
            fs::remove_dir_all(&to).map_err(failed)?;
        }
        fs::rename(staging.keep(), &to).map_err(failed)?;
        Ok(self.info(&id, Scope::User, None, to))
    }

    /// Creates a plugin to start from, in the vault or the app's folder.
    pub fn create(&self, id: &str, name: &str, scope: Scope, vault: Option<&VaultPlugins>) -> Result<PluginInfo> {
        if !is_id(id) {
            return Err(Error::Invalid(format!("“{id}” is not a valid id: use lowercase letters, digits and single dashes")));
        }
        if self.find(id, vault).is_ok() {
            return Err(Error::Exists(id.to_owned()));
        }
        let folder = self.folder(scope, vault).ok_or_else(|| Error::Invalid("open a vault first".into()))?.join(id);
        if folder.exists() {
            return Err(Error::Exists(id.to_owned()));
        }
        scaffold::write(&folder, id, name).map_err(|e| Error::Io(format!("cannot create “{id}”"), e))?;
        Ok(self.info(id, scope, vault, folder))
    }

    /// Deletes a plugin's folder (the app's, not a vault's: those are the
    /// vault's files) and forgets its consent.
    pub fn uninstall(&self, id: &str) -> Result<()> {
        let dir = self.user_folder.join(id);
        if !is_id(id) || !dir.is_dir() {
            return Err(Error::NotFound(id.to_owned()));
        }
        self.revoke(id, None)?;
        fs::remove_dir_all(&dir).map_err(|e| Error::Io(format!("cannot uninstall “{id}”"), e))
    }

    pub fn builtins_off(&self) -> Vec<String> {
        self.trust().builtin_off.iter().cloned().collect()
    }

    pub fn set_builtin(&self, id: &str, enabled: bool) -> Result<()> {
        self.change_trust(|trust| {
            if enabled {
                trust.builtin_off.remove(id);
            } else {
                trust.builtin_off.insert(id.to_owned());
            }
        })
    }

    /// Whether notes may load images from the web. Off until the user allows
    /// it: an address can carry data out, and tells its server who is reading.
    pub fn remote_images(&self) -> bool {
        self.trust().remote_images
    }

    pub fn set_remote_images(&self, allowed: bool) -> Result<()> {
        self.change_trust(|trust| trust.remote_images = allowed)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let folder = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(folder)?;
    let mut temp = tempfile::NamedTempFile::new_in(folder)?;
    temp.write_all(bytes)?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the system provides randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Setup {
        _root: tempfile::TempDir,
        data: PathBuf,
        vault: VaultPlugins,
        plugins: Plugins,
    }

    fn setup() -> Setup {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let vault = VaultPlugins { vault_id: "v1".into(), folder: root.path().join("vault/.itztli/plugins") };
        let plugins = Plugins::open(&data);
        Setup { data, vault, plugins, _root: root }
    }

    fn add(folder: &Path, id: &str, code: &str) -> PathBuf {
        let dir = folder.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            format!(r#"{{"id":"{id}","name":"{id}","version":"1","api":1,"network":["https://x.y"]}}"#),
        )
        .unwrap();
        fs::write(dir.join("main.js"), code).unwrap();
        dir
    }

    fn enable(s: &Setup, id: &str, development: bool) {
        let info = s.plugins.get(id, Some(&s.vault)).unwrap();
        s.plugins.grant(id, Some(&s.vault), &info.fingerprint.unwrap(), development).unwrap();
    }

    #[test]
    fn a_vaults_plugin_never_runs_on_its_own() {
        let s = setup();
        add(&s.vault.folder, "demo", "1");
        assert_eq!(s.plugins.list(Some(&s.vault))[0].status, Status::Disabled);
        assert!(matches!(s.plugins.load("demo", Some(&s.vault)), Err(Error::NotEnabled(_))));
    }

    #[test]
    fn runs_exactly_what_was_allowed() {
        let s = setup();
        let dir = add(&s.vault.folder, "demo", "good");
        enable(&s, "demo", false);
        let loaded = s.plugins.load("demo", Some(&s.vault)).unwrap();
        fs::write(dir.join("main.js"), "evil").unwrap();

        let (mime, bytes) = s.plugins.file(&format!("{}/main.js", loaded.token)).unwrap();
        assert_eq!((mime, bytes.as_slice()), ("text/javascript", b"good".as_slice()), "what was checked is what is served");
        assert_eq!(s.plugins.get("demo", Some(&s.vault)).unwrap().status, Status::NeedsReview);
        assert!(matches!(s.plugins.load("demo", Some(&s.vault)), Err(Error::NotEnabled(_))));
    }

    #[test]
    fn consent_is_for_what_the_user_saw() {
        let s = setup();
        let dir = add(&s.vault.folder, "demo", "good");
        let seen = s.plugins.get("demo", Some(&s.vault)).unwrap().fingerprint.unwrap();
        fs::write(dir.join("main.js"), "swapped").unwrap();
        assert!(matches!(s.plugins.grant("demo", Some(&s.vault), &seen, false), Err(Error::Changed(_))));
    }

    #[test]
    fn consent_stays_in_its_vault() {
        let s = setup();
        add(&s.vault.folder, "demo", "1");
        enable(&s, "demo", false);
        let other = VaultPlugins { vault_id: "v2".into(), ..s.vault.clone() };
        assert_eq!(s.plugins.get("demo", Some(&other)).unwrap().status, Status::Disabled);
        // And survives restarting the app.
        let again = Plugins::open(&s.data);
        assert_eq!(again.get("demo", Some(&s.vault)).unwrap().status, Status::Enabled);
    }

    #[test]
    fn development_plugins_reload_without_asking() {
        let s = setup();
        let dir = add(&s.vault.folder, "demo", "one");
        enable(&s, "demo", true);
        let first = s.plugins.load("demo", Some(&s.vault)).unwrap();
        fs::write(dir.join("main.js"), "two").unwrap();
        let second = s.plugins.load("demo", Some(&s.vault)).unwrap();
        assert!(first.development && first.token != second.token);
        assert_eq!(s.plugins.file(&format!("{}/main.js", second.token)).unwrap().1, b"two");
        assert_eq!(s.plugins.file(&format!("{}/main.js", first.token)), None, "the old code is gone");
    }

    #[test]
    fn a_vault_cannot_replace_an_installed_plugin() {
        let s = setup();
        add(s.plugins.user_folder(), "demo", "mine");
        add(&s.vault.folder, "demo", "theirs");
        enable(&s, "demo", false);
        let list = s.plugins.list(Some(&s.vault));
        assert_eq!((list.len(), list[0].scope), (1, Scope::User));
        let loaded = s.plugins.load("demo", Some(&s.vault)).unwrap();
        assert_eq!(s.plugins.file(&format!("{}/main.js", loaded.token)).unwrap().1, b"mine");
    }

    #[test]
    fn disabling_stops_serving() {
        let s = setup();
        add(&s.vault.folder, "demo", "1");
        enable(&s, "demo", false);
        let loaded = s.plugins.load("demo", Some(&s.vault)).unwrap();
        assert_eq!(s.plugins.network(&loaded.token), Some(vec!["https://x.y".to_owned()]));
        s.plugins.revoke("demo", Some(&s.vault)).unwrap();
        assert_eq!(s.plugins.file(&format!("{}/main.js", loaded.token)), None);
        assert_eq!(s.plugins.network(&loaded.token), None);
    }

    #[test]
    fn installing_copies_what_is_loaded_and_enables_nothing() {
        let s = setup();
        let from = add(&s._root.path().join("downloads"), "demo", "v1");
        fs::write(from.join("README.md"), "not loaded").unwrap();
        let info = s.plugins.install(&from).unwrap();
        assert_eq!((info.status, info.scope), (Status::Disabled, Scope::User));
        assert!(!info.folder.join("README.md").exists());
        enable(&s, "demo", false);
        fs::write(from.join("main.js"), "v2").unwrap();
        assert_eq!(s.plugins.install(&from).unwrap().status, Status::NeedsReview, "an update is reviewed");
        s.plugins.uninstall("demo").unwrap();
        assert!(s.plugins.list(Some(&s.vault)).is_empty());
        assert!(fs::read_dir(s.plugins.user_folder()).unwrap().next().is_none(), "nothing left behind");
    }

    #[test]
    fn created_plugins_are_valid() {
        let s = setup();
        let info = s.plugins.create("my-plugin", "My \"Plugin\"", Scope::Vault, Some(&s.vault)).unwrap();
        assert_eq!((info.status, info.error), (Status::Disabled, None));
        assert_eq!(info.manifest.unwrap().name, "My \"Plugin\"");
        assert!(matches!(s.plugins.create("my-plugin", "x", Scope::User, Some(&s.vault)), Err(Error::Exists(_))));
        assert!(matches!(s.plugins.create("../x", "x", Scope::User, None), Err(Error::Invalid(_))));
        assert!(matches!(s.plugins.create("x", "x", Scope::Vault, None), Err(Error::Invalid(_))));
    }

    #[test]
    fn broken_plugins_are_listed_with_the_reason() {
        let s = setup();
        let dir = add(&s.vault.folder, "demo", "1");
        fs::write(dir.join("plugin.json"), "{").unwrap();
        let info = &s.plugins.list(Some(&s.vault))[0];
        assert_eq!(info.status, Status::Invalid);
        assert!(info.error.as_ref().unwrap().contains("plugin.json"));
    }

    #[test]
    fn served_paths_cannot_climb() {
        let s = setup();
        add(&s.vault.folder, "demo", "1");
        enable(&s, "demo", false);
        let token = s.plugins.load("demo", Some(&s.vault)).unwrap().token;
        for bad in ["../main.js", "assets/../main.js", "", "/etc/passwd"] {
            assert_eq!(s.plugins.file(&format!("{token}/{bad}")), None, "{bad}");
        }
        assert_eq!(s.plugins.file("nope/main.js"), None);
    }

    #[test]
    fn settings_are_kept() {
        let s = setup();
        s.plugins.set_builtin("tasks", false).unwrap();
        s.plugins.set_remote_images(true).unwrap();
        let again = Plugins::open(&s.data);
        assert_eq!(again.builtins_off(), ["tasks"]);
        assert!(again.remote_images());
    }
}
