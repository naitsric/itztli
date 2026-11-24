use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The plugin API this app implements. A plugin states the one it was
/// written for in its manifest.
pub const API_VERSION: u32 = 1;

pub const MANIFEST_FILE: &str = "plugin.json";

/// `plugin.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Also the name of the plugin's folder: `word-count`.
    pub id: String,
    pub name: String,
    pub version: String,
    pub api: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub styles: Option<String>,
    /// Origins the plugin may reach through `ctx.net`; none by default.
    #[serde(default)]
    pub network: Vec<String>,
    /// Shown as a page in Settings, read with `ctx.settings`.
    #[serde(default)]
    pub settings: Vec<Setting>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "type")]
    pub kind: SettingKind,
    #[serde(default)]
    pub default: Value,
    /// For `select`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SettingOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingKind {
    Boolean,
    String,
    Text,
    Number,
    Select,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
}

fn default_main() -> String {
    "main.js".into()
}

impl Manifest {
    /// Parses and checks a manifest. `folder` is the name of the plugin's
    /// folder, which must be its id: two folders can't claim one id.
    pub fn parse(json: &[u8], folder: &str) -> Result<Self, String> {
        let manifest: Manifest = serde_json::from_slice(json).map_err(|e| format!("{MANIFEST_FILE}: {e}"))?;
        manifest.check()?;
        if manifest.id != folder {
            return Err(format!("the folder is named “{folder}” but the plugin's id is “{}”; they must match", manifest.id));
        }
        Ok(manifest)
    }

    fn check(&self) -> Result<(), String> {
        if !is_id(&self.id) {
            return Err(format!("“{}” is not a valid id: use lowercase letters, digits and single dashes", self.id));
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("the name must have between 1 and 80 characters".into());
        }
        if self.version.trim().is_empty() {
            return Err("the version is empty".into());
        }
        if self.api == 0 || self.api > API_VERSION {
            return Err(format!("written for plugin API {}; this version of Itztli implements {API_VERSION}", self.api));
        }
        for (what, file) in [("main", Some(&self.main)), ("styles", self.styles.as_ref())] {
            if let Some(file) = file
                && !is_plain_file(file)
            {
                return Err(format!("“{what}” must name a file in the plugin's folder"));
            }
        }
        if let Some(bad) = self.network.iter().find(|origin| !is_origin(origin)) {
            return Err(format!("“{bad}” is not an origin; write https://host, or http:// for localhost"));
        }
        if let Some(home) = &self.homepage
            && !home.starts_with("https://")
        {
            return Err("the homepage must be an https:// address".into());
        }
        Ok(())
    }
}

pub fn is_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

fn is_plain_file(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', ':', '\0'])
}

/// `https://host`, with an optional port and nothing else. Plain http only
/// reaches this computer.
fn is_origin(origin: &str) -> bool {
    let (host, local_only) = match (origin.strip_prefix("https://"), origin.strip_prefix("http://")) {
        (Some(host), _) => (host, false),
        (_, Some(host)) => (host, true),
        _ => return false,
    };
    let (name, port) = host.split_once(':').unwrap_or((host, "443"));
    let name_ok = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'));
    let port_ok = port.parse::<u16>().is_ok_and(|p| p > 0);
    name_ok && port_ok && (!local_only || matches!(name, "localhost" | "127.0.0.1"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<Manifest, String> {
        Manifest::parse(json.as_bytes(), "word-count")
    }

    #[test]
    fn minimal_manifest() {
        let m = parse(r#"{"id":"word-count","name":"Word Count","version":"1.0.0","api":1}"#).unwrap();
        assert_eq!((m.main.as_str(), m.styles, m.network.len()), ("main.js", None, 0));
    }

    #[test]
    fn says_what_is_wrong() {
        let with = |extra: &str| parse(&format!(r#"{{"id":"word-count","name":"W","version":"1","api":1{extra}}}"#)).unwrap_err();
        assert!(parse("{").unwrap_err().starts_with("plugin.json:"));
        assert!(parse(r#"{"id":"other","name":"W","version":"1","api":1}"#).unwrap_err().contains("must match"));
        assert!(parse(r#"{"id":"word-count","name":"W","version":"1","api":2}"#).unwrap_err().contains("plugin API 2"));
        assert!(with(r#","main":"../x.js""#).contains("main"));
        assert!(with(r#","styles":"a/b.css""#).contains("styles"));
        assert!(with(r#","network":["https://x.y/path"]"#).contains("not an origin"));
        assert!(with(r#","homepage":"http://x""#).contains("https"));
    }

    #[test]
    fn ids_and_origins() {
        for ok in ["a", "word-count", "q4-2026"] {
            assert!(is_id(ok), "{ok}");
        }
        for bad in ["", "-a", "a-", "a--b", "A", "a_b", "a/b", "..", "ñ"] {
            assert!(!is_id(bad), "{bad}");
        }
        for ok in ["https://api.x.com", "https://x:8443", "http://localhost:11434", "http://127.0.0.1:80"] {
            assert!(is_origin(ok), "{ok}");
        }
        for bad in ["http://x.com", "https://", "ftp://x", "https://x/", "https://*.x", "https://u@x", "https://x:0", "x.com"] {
            assert!(!is_origin(bad), "{bad}");
        }
    }
}
