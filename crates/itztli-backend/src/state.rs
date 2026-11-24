//! What the app remembers between launches, as plain JSON files.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub opened_at: i64,
}

const MAX_RECENTS: usize = 20;

pub struct State {
    folder: PathBuf,
}

impl State {
    pub fn open(folder: &Path) -> Self {
        Self { folder: folder.to_owned() }
    }

    /// A file that is missing or damaged reads as nothing: the app starts
    /// with its defaults rather than not at all.
    pub fn read(&self, name: &str) -> Value {
        fs::read(self.file(name)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
    }

    pub fn write(&self, name: &str, value: &Value) -> std::io::Result<()> {
        let file = self.file(name);
        let folder = file.parent().unwrap_or(&self.folder);
        fs::create_dir_all(folder)?;
        let mut temp = tempfile::NamedTempFile::new_in(folder)?;
        serde_json::to_writer_pretty(&mut temp, value)?;
        temp.write_all(b"\n")?;
        temp.persist(&file).map_err(|e| e.error)?;
        Ok(())
    }

    fn file(&self, name: &str) -> PathBuf {
        self.folder.join(format!("{name}.json"))
    }

    pub fn recents(&self) -> Vec<Recent> {
        serde_json::from_value(self.read("recents")).unwrap_or_default()
    }

    pub fn remember(&self, recent: Recent) -> std::io::Result<()> {
        let mut recents = self.recents();
        recents.retain(|r| r.id != recent.id);
        recents.insert(0, recent);
        recents.truncate(MAX_RECENTS);
        self.save_recents(&recents)
    }

    pub fn forget(&self, id: &str) -> std::io::Result<()> {
        let mut recents = self.recents();
        recents.retain(|r| r.id != id);
        self.save_recents(&recents)
    }

    fn save_recents(&self, recents: &[Recent]) -> std::io::Result<()> {
        self.write("recents", &serde_json::to_value(recents)?)
    }
}
