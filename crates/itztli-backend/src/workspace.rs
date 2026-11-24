//! An open vault: its files, its index and the watch that keeps them in step.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard, Weak};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use itztli_core::{Entry, Lines, Link, NoteMeta, path, section};
use itztli_history::{History, Reason};
use itztli_index::{Index, RelinkedNote, TextQuery, TextResults};
use itztli_plugins::VaultPlugins;
use itztli_vault::{CONFIG_DIR, FileText, Vault, Watcher, hex};
use rayon::prelude::*;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::{CommandError, CommandResult, ErrorCode};
use crate::{Events, event};

/// How the vault differs from what listeners knew.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Change {
    Put {
        entry: Entry,
    },
    Remove {
        path: String,
    },
    /// A file or folder, with everything inside.
    Move {
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    App,
    Disk,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub ready: bool,
    pub notes: usize,
    /// How long reading and indexing every note took.
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub relinked: Vec<RelinkedNote>,
    /// Notes whose links could not be rewritten, and why.
    pub failed: Vec<(String, String)>,
}

/// A link to the note, with the line it is on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(flatten)]
    pub link: Link,
    pub context: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usages {
    pub path: String,
    pub links: Vec<Usage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    pub path: String,
    pub text: String,
    /// Line of the file the text starts at.
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTask {
    pub path: String,
    pub line: u32,
    pub done: bool,
    pub text: String,
}

/// Files bigger than this are not read to be indexed or shown as notes.
const MAX_NOTE: u64 = 8 * 1024 * 1024;

pub struct Workspace {
    pub info: VaultInfo,
    pub vault: Vault,
    index: RwLock<Index>,
    history: Arc<History>,
    events: Arc<dyn Events>,
    watcher: Mutex<Option<Watcher>>,
    /// Held while files change and the index follows, so a watch report in
    /// between doesn't see half of it.
    changing: Mutex<()>,
    ready: AtomicBool,
    elapsed_ms: AtomicU64,
    /// The running text search; a newer one makes older ones stop.
    search: AtomicU64,
    closed: AtomicBool,
}

impl Workspace {
    /// Opens the vault and lists it. Reading and indexing every note goes on
    /// in the background; `index-ready` tells when it is done.
    pub fn open(vault: Vault, history: Arc<History>, events: Arc<dyn Events>) -> Arc<Self> {
        let root = vault.root().to_owned();
        let id = hex(&Sha256::digest(root.to_string_lossy().as_bytes())[..8]);
        let name = root.file_name().map_or_else(|| root.display().to_string(), |n| n.to_string_lossy().into_owned());
        let workspace = Arc::new(Self {
            info: VaultInfo { id, name, path: root.clone() },
            vault,
            index: RwLock::default(),
            history,
            events,
            watcher: Mutex::new(None),
            changing: Mutex::new(()),
            ready: AtomicBool::new(false),
            elapsed_ms: AtomicU64::new(0),
            search: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        });

        // Watching starts before listing, so nothing falls in between.
        let weak: Weak<Self> = Arc::downgrade(&workspace);
        match Watcher::start(&root, move |places| {
            if let Some(workspace) = weak.upgrade() {
                workspace.reconcile(&places);
            }
        }) {
            Ok(watcher) => *lock(&workspace.watcher) = Some(watcher),
            Err(e) => workspace.events.emit(event::WARNING, json!({ "message": e.to_string() })),
        }

        let started = Instant::now();
        let entries = workspace.vault.entries();
        {
            let mut index = workspace.write_index();
            for entry in &entries {
                index.put(entry.clone(), None);
            }
        }
        let indexing = workspace.clone();
        std::thread::spawn(move || indexing.index_all(entries, started));
        workspace
    }

    fn index_all(&self, entries: Vec<Entry>, started: Instant) {
        let parsed: Vec<(Entry, NoteMeta)> = entries
            .into_par_iter()
            .filter(|_| !self.closed.load(Ordering::Relaxed))
            .filter_map(|entry| self.parse(&entry).map(|meta| (entry, meta)))
            .collect();
        {
            // The vault may have changed meanwhile; what is newer stays.
            let _changing = lock(&self.changing);
            let mut index = self.write_index();
            for (entry, meta) in parsed {
                if index.entry(&entry.path) == Some(&entry) {
                    index.put(entry, Some(meta));
                }
            }
        }
        self.elapsed_ms.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
        self.ready.store(true, Ordering::Release);
        if !self.closed.load(Ordering::Relaxed) {
            self.events.emit(event::INDEX_READY, json!(self.status()));
        }
    }

    pub fn status(&self) -> IndexStatus {
        IndexStatus {
            ready: self.ready.load(Ordering::Acquire),
            notes: self.index().note_count(),
            elapsed_ms: self.elapsed_ms.load(Ordering::Relaxed),
        }
    }

    /// Stops watching and searching. Reads keep working for whoever still
    /// holds the workspace.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.search.fetch_add(1, Ordering::Relaxed);
        lock(&self.watcher).take();
    }

    pub fn index(&self) -> RwLockReadGuard<'_, Index> {
        self.index.read().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_index(&self) -> RwLockWriteGuard<'_, Index> {
        self.index.write().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn plugins(&self) -> VaultPlugins {
        VaultPlugins { vault_id: self.info.id.clone(), folder: self.vault.root().join(CONFIG_DIR).join("plugins") }
    }

    fn parse(&self, entry: &Entry) -> Option<NoteMeta> {
        if entry.folder || !path::is_note(&entry.path) || entry.size > MAX_NOTE {
            return None;
        }
        self.vault.read(&entry.path).ok().map(|file| itztli_core::parse(&file.text))
    }

    fn changed(&self, origin: Origin, changes: Vec<Change>) {
        if !changes.is_empty() && !self.closed.load(Ordering::Relaxed) {
            self.events.emit(event::VAULT_CHANGED, json!({ "origin": origin, "changes": changes }));
        }
    }

    /// Brings the index in line with the disk at the places that may have
    /// changed (everywhere, if empty).
    pub fn reconcile(&self, places: &BTreeSet<PathBuf>) {
        let config = self.vault.root().join(CONFIG_DIR);
        let plugins = config.join("plugins");
        if places.is_empty() || places.iter().any(|p| p.starts_with(&plugins)) {
            self.events.emit(event::PLUGINS_CHANGED, json!({ "folders": self.touched_plugins(&plugins, places) }));
        }
        if places.iter().any(|p| p.parent() == Some(&config) && p.extension().is_some_and(|e| e == "json")) {
            self.events.emit(event::CONFIG_CHANGED, json!({}));
        }

        let _changing = lock(&self.changing);
        let mut changes = Vec::new();
        if places.is_empty() || places.contains(self.vault.root()) {
            self.reconcile_at(None, &mut changes);
        } else {
            let paths: BTreeSet<String> = places.iter().filter_map(|p| self.vault.vault_path(p)).collect();
            for p in &paths {
                // Its folder is being looked at as a whole already.
                if !paths.iter().any(|other| other != p && path::is_within(p, other)) {
                    self.reconcile_at(Some(p), &mut changes);
                }
            }
        }
        drop(_changing);
        self.changed(Origin::Disk, changes);
    }

    fn touched_plugins(&self, plugins: &Path, places: &BTreeSet<PathBuf>) -> BTreeSet<String> {
        places
            .iter()
            .filter_map(|p| p.strip_prefix(plugins).ok()?.components().next()?.as_os_str().to_str().map(str::to_owned))
            .collect()
    }

    fn reconcile_at(&self, place: Option<&str>, changes: &mut Vec<Change>) {
        let now: BTreeMap<String, Entry> = match place {
            None => self.vault.entries(),
            Some(p) => self.vault.entries_at(p),
        }
        .into_iter()
        .map(|e| (e.path.clone(), e))
        .collect();

        let (gone, stale): (Vec<String>, Vec<Entry>) = {
            let index = self.index();
            let known: HashSet<&str> = match place {
                None => index.entries().map(|e| e.path.as_str()).collect(),
                Some(p) => index.inside(p).chain(index.entry(p)).map(|e| e.path.as_str()).collect(),
            };
            let gone = known.iter().filter(|p| !now.contains_key(**p)).map(|p| (*p).to_owned()).collect();
            // A folder's own time changes with every file in it; what matters
            // is that it is there.
            let same = |e: &Entry| index.entry(&e.path).is_some_and(|k| if e.folder { k.folder } else { k == e });
            (gone, now.into_values().filter(|e| !same(e)).collect())
        };
        if gone.is_empty() && stale.is_empty() {
            return;
        }

        let read: Vec<(Entry, Option<NoteMeta>)> = stale.into_par_iter().map(|e| (e.clone(), self.parse(&e))).collect();
        let mut index = self.write_index();
        for p in gone {
            for p in index.remove(&p) {
                changes.push(Change::Remove { path: p });
            }
        }
        for (entry, meta) in read {
            changes.push(Change::Put { entry: entry.clone() });
            index.put(entry, meta);
        }
    }

    /// Puts what was just written in the index and tells everyone.
    fn put_written(&self, p: &str, text: &str) -> CommandResult<()> {
        let mut changes = self.put_parents(p);
        let entry = self.vault.entry(p)?;
        let meta = path::is_note(p).then(|| itztli_core::parse(text));
        self.write_index().put(entry.clone(), meta);
        changes.push(Change::Put { entry });
        self.changed(Origin::App, changes);
        Ok(())
    }

    /// Writing a file may have created the folders holding it.
    fn put_parents(&self, p: &str) -> Vec<Change> {
        let mut missing = Vec::new();
        let mut folder = path::parent(p);
        while !folder.is_empty() && self.index().entry(folder).is_none() {
            missing.push(folder);
            folder = path::parent(folder);
        }
        missing
            .into_iter()
            .rev()
            .filter_map(|folder| {
                let entry = self.vault.entry(folder).ok()?;
                self.write_index().put(entry.clone(), None);
                Some(Change::Put { entry })
            })
            .collect()
    }

    pub fn read(&self, p: &str) -> CommandResult<FileText> {
        Ok(self.vault.read(p)?)
    }

    pub fn write(&self, p: &str, text: &str, base: Option<&str>) -> CommandResult<String> {
        require_visible(p)?;
        let _changing = lock(&self.changing);
        let old = self.vault.read(p).ok();
        let revision = self.vault.write(p, text, base)?;
        if let Some(old) = old {
            self.remember(p, &old.text, Some(text), Reason::Edit);
        }
        self.put_written(p, text)?;
        Ok(revision)
    }

    pub fn create(&self, p: &str, text: &str) -> CommandResult<()> {
        self.create_bytes(p, text.as_bytes())
    }

    pub fn create_bytes(&self, p: &str, bytes: &[u8]) -> CommandResult<()> {
        require_visible(p)?;
        let _changing = lock(&self.changing);
        self.vault.create(p, bytes)?;
        self.put_written(p, &String::from_utf8_lossy(bytes))
    }

    pub fn create_folder(&self, p: &str) -> CommandResult<()> {
        require_visible(p)?;
        let _changing = lock(&self.changing);
        self.vault.create_folder(p)?;
        let mut changes = self.put_parents(p);
        let entry = self.vault.entry(p)?;
        self.write_index().put(entry.clone(), None);
        changes.push(Change::Put { entry });
        self.changed(Origin::App, changes);
        Ok(())
    }

    /// A name in a folder nothing uses yet: `Note.md`, `Note 2.md`…
    pub fn free_path(&self, folder: &str, name: &str) -> String {
        let (stem, extension) = match path::strip_note_extension(name) {
            Some(stem) => (stem, &name[stem.len()..]),
            None => name.rfind('.').filter(|&at| at > 0).map_or((name, ""), |at| name.split_at(at)),
        };
        let taken = |p: &str| self.vault.exists(p);
        let first = path::join(folder, name);
        if !taken(&first) {
            return first;
        }
        (2..).map(|n| path::join(folder, &format!("{stem} {n}{extension}"))).find(|p| !taken(p)).unwrap_or(first)
    }

    pub fn duplicate(&self, p: &str) -> CommandResult<String> {
        let _changing = lock(&self.changing);
        let bytes = self.vault.read_bytes(p)?;
        let copy = self.free_path(path::parent(p), path::name(p));
        self.vault.create(&copy, &bytes)?;
        self.put_written(&copy, &String::from_utf8_lossy(&bytes))?;
        Ok(copy)
    }

    /// What moving would do to other notes, without doing it.
    pub fn preview_move(&self, from: &str, to: &str) -> CommandResult<Vec<RelinkedNote>> {
        path::validate(to)?;
        let mut index = self.index().clone();
        Ok(index.move_entry(from, to).relinked)
    }

    /// Moves or renames, and rewrites the links that would otherwise break.
    pub fn move_entry(&self, from: &str, to: &str, relink: bool) -> CommandResult<Moved> {
        require_visible(from)?;
        require_visible(to)?;
        let _changing = lock(&self.changing);
        self.vault.rename(from, to)?;
        let mut changes = self.put_parents(to);
        let plan = self.write_index().move_entry(from, to);
        if let Err(e) = self.history.moved(&self.info.id, from, to) {
            self.events.emit(event::WARNING, json!({ "message": e.to_string() }));
        }
        changes.push(Change::Move { from: from.to_owned(), to: to.to_owned() });

        let mut moved = Moved { relinked: Vec::new(), failed: Vec::new() };
        for note in if relink { plan.relinked } else { Vec::new() } {
            match self.relink(&note) {
                Ok(Some(entry)) => {
                    changes.push(Change::Put { entry });
                    moved.relinked.push(note);
                }
                Ok(None) => {}
                Err(e) => moved.failed.push((note.path.clone(), e.message)),
            }
        }
        self.changed(Origin::App, changes);
        Ok(moved)
    }

    fn relink(&self, note: &RelinkedNote) -> CommandResult<Option<Entry>> {
        let old = self.vault.read(&note.path)?.text;
        let Some(new) = self.index().relink(note, &old) else { return Ok(None) };
        self.remember(&note.path, &old, Some(&new), Reason::Refactor);
        self.vault.write_bulk(&note.path, &new)?;
        let entry = self.vault.entry(&note.path)?;
        self.write_index().put(entry.clone(), Some(itztli_core::parse(&new)));
        Ok(Some(entry))
    }

    pub fn trash(&self, p: &str) -> CommandResult<()> {
        require_visible(p)?;
        let _changing = lock(&self.changing);
        let notes: Vec<String> = {
            let index = self.index();
            index
                .inside(p)
                .chain(index.entry(p))
                .filter(|e| path::is_note(&e.path) && !e.folder)
                .map(|e| e.path.clone())
                .collect()
        };
        for note in &notes {
            if let Ok(file) = self.vault.read(note) {
                self.remember(note, &file.text, None, Reason::Delete);
            }
        }
        self.vault.trash(p)?;
        self.write_index().remove(p);
        self.changed(Origin::App, vec![Change::Remove { path: p.to_owned() }]);
        Ok(())
    }

    /// Local history is a safety net: failing to keep it must not stop work.
    fn remember(&self, p: &str, old: &str, new: Option<&str>, reason: Reason) {
        if let Err(e) = self.history.replacing(&self.info.id, p, old, new, reason, now_ms()) {
            self.events.emit(event::WARNING, json!({ "message": e.to_string() }));
        }
    }

    /// Find in Files. A newer search makes this one stop early.
    pub fn search_text(&self, query: &TextQuery) -> CommandResult<TextResults> {
        let mine = self.search.fetch_add(1, Ordering::Relaxed) + 1;
        let files: Vec<String> =
            self.index().entries().filter(|e| path::is_note(&e.path) && !e.folder).map(|e| e.path.clone()).collect();
        let read = |p: &str| std::fs::read(self.vault.root().join(p)).ok();
        Ok(itztli_index::grep(&files, read, query, || self.search.load(Ordering::Relaxed) != mine)?)
    }

    /// Where a note, or one not written yet, is linked from.
    pub fn usages(&self, target: &str) -> Vec<Usages> {
        let found = {
            let index = self.index();
            if index.entry(target).is_some() { index.backlinks(target) } else { index.mentions_of_missing(target) }
        };
        found
            .into_par_iter()
            .map(|source| {
                let text = self.vault.read(&source.path).map(|f| f.text).unwrap_or_default();
                let lines = Lines::new(&text);
                let context = |l: &Link| lines.line(l.line).unwrap_or("").trim().chars().take(400).collect();
                let links = source.links.into_iter().map(|link| Usage { context: context(&link), link }).collect();
                Usages { path: source.path, links }
            })
            .collect()
    }

    /// What a link shows when embedded or hovered: the note, or the part of
    /// it that the link points at.
    pub fn excerpt(&self, source: &str, target: &str, subpath: Option<&str>, relative: bool) -> CommandResult<Excerpt> {
        let not_found = || CommandError::new(ErrorCode::NotFound, format!("“{target}” does not exist"));
        let p = self.index().resolve(source, target, relative).map(str::to_owned).ok_or_else(not_found)?;
        let text = self.vault.read(&p)?.text;
        let Some(subpath) = subpath.filter(|s| !s.is_empty()) else { return Ok(Excerpt { path: p, text, line: 0 }) };
        let part = section::extract(&text, subpath)
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, format!("“{p}” has no “{subpath}”")))?;
        let line = Lines::new(&text).position(part.as_ptr() as usize - text.as_ptr() as usize).0;
        Ok(Excerpt { path: p.clone(), text: part.to_owned(), line })
    }

    pub fn tasks(&self) -> Vec<NoteTask> {
        let index = self.index();
        let mut found: Vec<NoteTask> = index
            .notes()
            .flat_map(|(p, meta)| {
                meta.tasks.iter().map(move |t| NoteTask { path: p.to_owned(), line: t.line, done: t.done, text: t.text.clone() })
            })
            .collect();
        found.sort_by(|a, b| (&a.path, a.line).cmp(&(&b.path, b.line)));
        found
    }

    /// A JSON file of Itztli's in the vault, e.g. its bookmarks.
    pub fn read_config(&self, name: &str) -> CommandResult<serde_json::Value> {
        match self.vault.read(&config_path(name)?) {
            Ok(file) => serde_json::from_str(&file.text).map_err(|e| CommandError::invalid(format!("{name}.json: {e}"))),
            Err(itztli_vault::Error::NotFound(_)) => Ok(serde_json::Value::Null),
            Err(e) => Err(e.into()),
        }
    }

    pub fn write_config(&self, name: &str, value: &serde_json::Value) -> CommandResult<()> {
        let json = serde_json::to_string_pretty(value).map_err(|e| CommandError::invalid(e.to_string()))?;
        self.vault.write(&config_path(name)?, &(json + "\n"), None)?;
        Ok(())
    }
}

/// The app's commands work on notes; hidden folders hold the app's own
/// state, plugins' code among it, and are not theirs to change.
fn require_visible(p: &str) -> CommandResult<()> {
    path::validate(p)?;
    if p.split('/').any(|part| part.starts_with('.')) {
        return Err(CommandError::invalid("names starting with a dot are reserved"));
    }
    Ok(())
}

fn config_path(name: &str) -> CommandResult<String> {
    let ok = name.split('/').all(itztli_plugins::is_id) && name.split('/').count() <= 2 && !name.starts_with("plugins/");
    if ok {
        Ok(format!("{CONFIG_DIR}/{name}.json"))
    } else {
        Err(CommandError::invalid(format!("“{name}” is not a valid name")))
    }
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
