//! The server's settings, stored as JSON in the MCP store: not in the app's
//! settings, which the UI, and so a plugin, may write as it likes.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::store::{self, Store};

/// Most results a client may ask a search or a listing for.
pub const MAX_RESULTS: u32 = 1000;

/// The port the server listens on unless the user picks another.
pub const DEFAULT_PORT: u16 = 7413;

/// Shortest and longest approval wait the settings accept. Less than the
/// shortest could not be answered.
const APPROVAL_SECS: std::ops::RangeInclusive<u64> = 10..=3600;

/// The longest a tool call can take: the longest wait for approval.
pub(crate) const LONGEST_CALL: Duration = Duration::from_secs(*APPROVAL_SECS.end());

const KEY: &str = "settings";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpSettings {
    /// Whether the server listens. Off until the user turns it on.
    pub enabled: bool,
    /// The loopback port it listens on.
    pub port: u16,
    /// Results a search or a listing returns unless the client asks for
    /// another number (up to [`MAX_RESULTS`]).
    pub max_results: u32,
    /// A change nobody approves or rejects within this long is refused.
    pub approval_timeout_secs: u64,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, max_results: 100, approval_timeout_secs: 120 }
    }
}

impl McpSettings {
    /// What is wrong with the settings, for the settings form.
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("the port must be between 1 and 65535".into());
        }
        if !(1..=MAX_RESULTS).contains(&self.max_results) {
            return Err(format!("the number of results must be between 1 and {MAX_RESULTS}"));
        }
        if !APPROVAL_SECS.contains(&self.approval_timeout_secs) {
            let (min, max) = APPROVAL_SECS.into_inner();
            return Err(format!("the approval timeout must be between {min} and {max} seconds"));
        }
        Ok(())
    }

    pub fn approval_timeout(&self) -> Duration {
        Duration::from_secs(self.approval_timeout_secs)
    }

    /// Brings stored values that `validate` would refuse into range.
    fn clamped(self) -> Self {
        let (min, max) = APPROVAL_SECS.into_inner();
        Self {
            max_results: self.max_results.clamp(1, MAX_RESULTS),
            approval_timeout_secs: self.approval_timeout_secs.clamp(min, max),
            ..self
        }
    }
}

/// Defaults when nothing is stored. A value that no longer parses also
/// reads as the defaults, which leave the server off.
pub(crate) fn load(store: &Store) -> Result<McpSettings, store::Error> {
    let stored = store.setting(KEY)?;
    let settings = stored.and_then(|json| serde_json::from_str::<McpSettings>(&json).ok()).unwrap_or_default();
    Ok(settings.clamped())
}

pub(crate) fn save(store: &Store, settings: &McpSettings) -> Result<(), Error> {
    settings.validate().map_err(Error::InvalidSettings)?;
    let json = serde_json::to_string(settings).expect("settings serialize");
    Ok(store.set_setting(KEY, &json)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_absent_partial_or_corrupt() {
        let store = Store::in_memory().unwrap();
        assert_eq!(load(&store).unwrap(), McpSettings::default());
        store.set_setting(KEY, r#"{"enabled":true,"maxResults":50}"#).unwrap();
        assert_eq!(load(&store).unwrap(), McpSettings { enabled: true, max_results: 50, ..McpSettings::default() });
        store.set_setting(KEY, "not json").unwrap();
        assert_eq!(load(&store).unwrap(), McpSettings::default());
        // Out of range values read back in range.
        store.set_setting(KEY, r#"{"maxResults":5000,"approvalTimeoutSecs":0}"#).unwrap();
        let clamped = load(&store).unwrap();
        assert_eq!((clamped.max_results, clamped.approval_timeout_secs), (MAX_RESULTS, 10));
    }

    #[test]
    fn saves_valid_settings_in_camel_case() {
        let store = Store::in_memory().unwrap();
        let settings = McpSettings { enabled: true, port: 7500, ..McpSettings::default() };
        save(&store, &settings).unwrap();
        assert_eq!(load(&store).unwrap(), settings);
        let json: serde_json::Value = serde_json::from_str(&store.setting(KEY).unwrap().unwrap()).unwrap();
        assert_eq!(json["maxResults"], 100);
        assert_eq!(json["approvalTimeoutSecs"], 120);

        for invalid in [
            McpSettings { port: 0, ..McpSettings::default() },
            McpSettings { max_results: 0, ..McpSettings::default() },
            McpSettings { approval_timeout_secs: 3601, ..McpSettings::default() },
        ] {
            assert!(matches!(save(&store, &invalid), Err(Error::InvalidSettings(_))), "{invalid:?}");
        }
        assert_eq!(load(&store).unwrap(), settings);
    }
}
