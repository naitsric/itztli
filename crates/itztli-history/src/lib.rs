//! Local history: what notes said before, like IntelliJ's. It lives outside
//! the vault, so it is neither synced nor seen by other tools.
//!
//! A revision is a content that was about to be replaced. The current
//! content is the file itself and is never in here.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
#[error("local history: {0}")]
pub struct Error(#[from] rusqlite::Error);

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Why the content was replaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Edit,
    /// Links rewritten because another file was renamed or moved.
    Refactor,
    Delete,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Refactor => "refactor",
            Self::Delete => "delete",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "refactor" => Self::Refactor,
            "delete" => Self::Delete,
            _ => Self::Edit,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: i64,
    /// When the content was replaced, in milliseconds since the epoch.
    pub at: i64,
    pub reason: Reason,
    pub size: u32,
}

/// Saves come every few keystrokes; one revision in this long is enough…
const EDIT_INTERVAL_MS: i64 = 20_000;
/// …unless the save removes this much, which may be what one wants back.
const LARGE_LOSS: usize = 200;

const KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Older than a day, one revision an hour.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;

/// Applied in order; `PRAGMA user_version` records how many ran. Only ever append.
const MIGRATIONS: &[&str] = &["create table revision (
        id integer primary key,
        vault text not null,
        path text not null,
        at integer not null,
        reason text not null,
        text text not null
    );
    create index revision_by_path on revision (vault, path, at)"];

pub struct History {
    db: Mutex<Connection>,
}

impl History {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut db: Connection) -> Result<Self> {
        // Losing the last revision to a power cut is fine; waiting for the
        // disk on every save is not.
        db.pragma_update(None, "journal_mode", "wal")?;
        db.pragma_update(None, "synchronous", "normal")?;
        let done: usize = db.query_row("pragma user_version", [], |r| r.get::<_, i64>(0))? as usize;
        for (i, migration) in MIGRATIONS.iter().enumerate().skip(done) {
            let tx = db.transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", i as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Self { db: Mutex::new(db) })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keeps `old`, which is about to become `new` (`None`: to disappear).
    /// Returns whether it was worth keeping.
    pub fn replacing(&self, vault: &str, path: &str, old: &str, new: Option<&str>, reason: Reason, now: i64) -> Result<bool> {
        if old.is_empty() || new == Some(old) {
            return Ok(false);
        }
        let db = self.db();
        let last: Option<(i64, String)> = db
            .query_row(
                "select at, text from revision where vault = ? and path = ? order by at desc, id desc limit 1",
                params![vault, path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((at, text)) = &last {
            let lost = old.len().saturating_sub(new.map_or(0, str::len));
            if text == old || (reason == Reason::Edit && now - at < EDIT_INTERVAL_MS && lost < LARGE_LOSS) {
                return Ok(false);
            }
        }
        db.execute(
            "insert into revision (vault, path, at, reason, text) values (?, ?, ?, ?, ?)",
            params![vault, path, now, reason.as_str(), old],
        )?;
        Ok(true)
    }

    /// Newest first.
    pub fn list(&self, vault: &str, path: &str) -> Result<Vec<Revision>> {
        let db = self.db();
        let mut query = db.prepare_cached(
            "select id, at, reason, length(cast(text as blob)) from revision where vault = ? and path = ? order by at desc, id desc",
        )?;
        let rows = query.query_map(params![vault, path], |r| {
            Ok(Revision { id: r.get(0)?, at: r.get(1)?, reason: Reason::from_str(&r.get::<_, String>(2)?), size: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn text(&self, vault: &str, id: i64) -> Result<Option<String>> {
        let db = self.db();
        Ok(db.query_row("select text from revision where id = ? and vault = ?", params![id, vault], |r| r.get(0)).optional()?)
    }

    /// A file or folder moved: its past goes along.
    pub fn moved(&self, vault: &str, from: &str, to: &str) -> Result<()> {
        self.db().execute(
            "update revision set path = ?3 || substr(path, length(?2) + 1)
             where vault = ?1 and (path = ?2 or substr(path, 1, length(?2) + 1) = ?2 || '/')",
            params![vault, from, to],
        )?;
        Ok(())
    }

    /// Forgets what is too old, and thins out what is old.
    pub fn prune(&self, now: i64) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute("delete from revision where at < ?", params![now - KEEP_MS])?;
        tx.execute(
            "delete from revision where reason = 'edit' and at < ?1 and id not in (
                 select max(id) from revision where reason = 'edit' and at < ?1 group by vault, path, at / ?2
             )",
            params![now - DAY_MS, HOUR_MS],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000_000;

    fn texts(h: &History, path: &str) -> Vec<String> {
        h.list("v", path).unwrap().into_iter().map(|r| h.text("v", r.id).unwrap().unwrap()).collect()
    }

    #[test]
    fn keeps_one_edit_per_interval_and_every_large_loss() {
        let h = History::in_memory().unwrap();
        let edit = |old: &str, new: &str, at| h.replacing("v", "a.md", old, Some(new), Reason::Edit, T + at).unwrap();
        assert!(edit("one", "one two", 0));
        assert!(!edit("one two", "one two three", 1_000));
        assert!(edit("one two three", "x", EDIT_INTERVAL_MS));
        let long = "word ".repeat(100);
        assert!(!edit("x", &long, EDIT_INTERVAL_MS + 1));
        assert!(edit(&long, "gone", EDIT_INTERVAL_MS + 2), "losing that much is kept right away");
        assert!(!edit("same", "same", EDIT_INTERVAL_MS * 9));
        assert!(!edit("", "new", EDIT_INTERVAL_MS * 9));
        assert_eq!(texts(&h, "a.md"), [long.as_str(), "one two three", "one"]);
    }

    #[test]
    fn refactors_and_deletions_always_count() {
        let h = History::in_memory().unwrap();
        assert!(h.replacing("v", "a.md", "a", Some("b"), Reason::Edit, T).unwrap());
        assert!(h.replacing("v", "a.md", "b", Some("c"), Reason::Refactor, T + 1).unwrap());
        assert!(h.replacing("v", "a.md", "c", None, Reason::Delete, T + 2).unwrap());
        let reasons: Vec<Reason> = h.list("v", "a.md").unwrap().into_iter().map(|r| r.reason).collect();
        assert_eq!(reasons, [Reason::Delete, Reason::Refactor, Reason::Edit]);
    }

    #[test]
    fn follows_moves_and_keeps_vaults_apart() {
        let h = History::in_memory().unwrap();
        for path in ["f/a.md", "f/g/b.md", "fx.md"] {
            h.replacing("v", path, path, None, Reason::Delete, T).unwrap();
        }
        h.moved("v", "f", "n/m").unwrap();
        assert_eq!(texts(&h, "n/m/a.md"), ["f/a.md"]);
        assert_eq!(texts(&h, "n/m/g/b.md"), ["f/g/b.md"]);
        assert_eq!(texts(&h, "fx.md"), ["fx.md"]);
        let id = h.list("v", "fx.md").unwrap()[0].id;
        assert_eq!(h.text("other", id).unwrap(), None);
        assert!(h.list("other", "fx.md").unwrap().is_empty());
    }

    #[test]
    fn thins_out_with_age() {
        let h = History::in_memory().unwrap();
        let add = |text: &str, at| h.replacing("v", "a.md", text, None, Reason::Edit, at).unwrap();
        let hour = (T - 3 * DAY_MS) / HOUR_MS * HOUR_MS;
        add("ancient", T - KEEP_MS - 1);
        add("old 1", hour);
        add("old 2", hour + 60_000);
        add("recent 1", T - 120_000);
        add("recent 2", T - 60_000);
        h.prune(T).unwrap();
        assert_eq!(texts(&h, "a.md"), ["recent 2", "recent 1", "old 2"]);
    }

    #[test]
    fn survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("history.db");
        History::open(&file).unwrap().replacing("v", "a.md", "x", None, Reason::Delete, T).unwrap();
        assert_eq!(texts(&History::open(&file).unwrap(), "a.md"), ["x"]);
    }
}
