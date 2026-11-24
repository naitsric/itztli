//! A vault on disk. Every path that comes in is a vault path (see
//! `itztli_core::path`) and nothing here reads or writes outside the root,
//! symlinks included.

mod watch;

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub use itztli_core::Entry;
use itztli_core::path as vpath;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub use watch::{WatchError, Watcher};

/// Itztli's own folder inside a vault: plugins, bookmarks, their data.
pub const CONFIG_DIR: &str = ".itztli";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    InvalidPath(#[from] vpath::InvalidPath),
    #[error("“{0}” is outside the vault")]
    Outside(String),
    #[error("“{0}” does not exist")]
    NotFound(String),
    #[error("“{0}” already exists")]
    Exists(String),
    #[error("“{0}” changed on disk since it was opened")]
    Conflict(String),
    #[error("“{0}” is not a text file in UTF-8")]
    NotText(String),
    #[error("a folder cannot be moved inside itself")]
    MoveIntoItself,
    #[error("“{path}”: {source}")]
    Io { path: String, source: io::Error },
    #[error("cannot move “{path}” to the trash: {message}")]
    Trash { path: String, message: String },
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

fn io_error(path: &str) -> impl FnOnce(io::Error) -> Error + '_ {
    move |source| match source.kind() {
        io::ErrorKind::NotFound => Error::NotFound(path.to_owned()),
        io::ErrorKind::AlreadyExists => Error::Exists(path.to_owned()),
        _ => Error::Io { path: path.to_owned(), source },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    /// Identifies this exact content; see [`Vault::write`].
    pub revision: String,
}

#[derive(Debug, Clone)]
pub struct Vault {
    root: PathBuf,
    /// Where deleted files go instead of the system trash.
    trash_folder: Option<PathBuf>,
}

impl Vault {
    /// `root` must be an existing folder.
    pub fn open(root: &Path) -> Result<Self> {
        let shown = root.display().to_string();
        let root = root.canonicalize().map_err(io_error(&shown))?;
        if !root.is_dir() {
            return Err(Error::NotFound(shown));
        }
        Ok(Self { root, trash_folder: None })
    }

    /// Moves what is deleted to a folder, for tests and the dev server.
    pub fn with_trash_folder(self, folder: PathBuf) -> Self {
        Self { trash_folder: Some(folder), ..self }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The place on disk a vault path names, which may not exist yet. Fails
    /// when a symlink on the way leads outside the vault.
    pub fn locate(&self, path: &str) -> Result<PathBuf> {
        vpath::validate(path)?;
        let full = self.root.join(path);
        // What exists of the path decides where it really is.
        let mut existing = full.as_path();
        loop {
            match existing.canonicalize() {
                Ok(real) if real.starts_with(&self.root) => return Ok(full),
                Ok(_) => return Err(Error::Outside(path.to_owned())),
                Err(_) => {
                    // A dangling symlink: creating through it would land elsewhere.
                    if existing.is_symlink() {
                        return Err(Error::Outside(path.to_owned()));
                    }
                    existing = existing.parent().ok_or_else(|| Error::Outside(path.to_owned()))?;
                }
            }
        }
    }

    /// The vault path of a place on disk, if it is inside.
    pub fn vault_path(&self, full: &Path) -> Option<String> {
        let relative = full.strip_prefix(&self.root).ok()?;
        let parts: Option<Vec<&str>> = relative.components().map(|c| c.as_os_str().to_str()).collect();
        parts.map(|p| p.join("/")).filter(|p| !p.is_empty())
    }

    /// Everything shown in the vault: hidden files and folders (and so `.git`,
    /// `.obsidian` and Itztli's own) are left out, as are symlinks.
    pub fn entries(&self) -> Vec<Entry> {
        self.entries_in(&self.root)
    }

    /// What is at a vault path now: the entry and, for a folder, everything
    /// inside. Empty when there is nothing, or it is hidden.
    pub fn entries_at(&self, path: &str) -> Vec<Entry> {
        if path.split('/').any(is_hidden) {
            return Vec::new();
        }
        match self.locate(path) {
            Ok(full) if !full.is_symlink() && self.spelled_as_on_disk(path, &full) => self.entries_in(&full),
            _ => Vec::new(),
        }
    }

    /// Where the disk ignores case, `note.md` finds `Note.md`; but it is not
    /// what the file is called.
    fn spelled_as_on_disk(&self, path: &str, full: &Path) -> bool {
        full.canonicalize().is_ok_and(|real| self.vault_path(&real).as_deref() == Some(path))
    }

    fn entries_in(&self, from: &Path) -> Vec<Entry> {
        walkdir::WalkDir::new(from)
            .into_iter()
            .filter_entry(|e| e.path() == self.root || !e.file_name().to_str().is_none_or(is_hidden))
            .filter_map(|e| {
                let e = e.ok()?;
                let path = self.vault_path(e.path())?;
                let kind = e.file_type();
                if !kind.is_dir() && !kind.is_file() {
                    return None;
                }
                let meta = e.metadata().ok()?;
                Some(entry_of(path, &meta))
            })
            .collect()
    }

    pub fn entry(&self, path: &str) -> Result<Entry> {
        let meta = fs::metadata(self.locate(path)?).map_err(io_error(path))?;
        Ok(entry_of(path.to_owned(), &meta))
    }

    pub fn exists(&self, path: &str) -> bool {
        self.locate(path).is_ok_and(|full| full.symlink_metadata().is_ok())
    }

    pub fn read_bytes(&self, path: &str) -> Result<Vec<u8>> {
        fs::read(self.locate(path)?).map_err(io_error(path))
    }

    pub fn read(&self, path: &str) -> Result<FileText> {
        let bytes = self.read_bytes(path)?;
        let revision = revision(&bytes);
        let text = String::from_utf8(bytes).map_err(|_| Error::NotText(path.to_owned()))?;
        Ok(FileText { text, revision })
    }

    /// Replaces a file's content in one step: readers see the old content or
    /// the new one, never half. With `base`, fails with a conflict unless the
    /// file still holds that revision, so nobody else's change is lost.
    pub fn write(&self, path: &str, text: &str, base: Option<&str>) -> Result<String> {
        let full = self.locate(path)?;
        if let Some(base) = base {
            match fs::read(&full) {
                Ok(current) if revision(&current) == base => {}
                Ok(_) => return Err(Error::Conflict(path.to_owned())),
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(Error::NotFound(path.to_owned())),
                Err(e) => return Err(io_error(path)(e)),
            }
        }
        self.replace(path, &full, text.as_bytes(), true)?;
        Ok(revision(text.as_bytes()))
    }

    /// [`write`](Self::write) for rewriting many files in one go: still one
    /// step each, but without waiting for every one to reach the disk.
    pub fn write_bulk(&self, path: &str, text: &str) -> Result<()> {
        let full = self.locate(path)?;
        self.replace(path, &full, text.as_bytes(), false)
    }

    fn replace(&self, path: &str, full: &Path, bytes: &[u8], sync: bool) -> Result<()> {
        let folder = full.parent().unwrap_or(&self.root);
        fs::create_dir_all(folder).map_err(io_error(path))?;
        let mut temp = tempfile::Builder::new().prefix(".itztli-").tempfile_in(folder).map_err(io_error(path))?;
        temp.write_all(bytes).map_err(io_error(path))?;
        if sync {
            temp.as_file().sync_data().map_err(io_error(path))?;
        }
        let permissions = match fs::metadata(full) {
            Ok(meta) => meta.permissions(),
            Err(_) => default_permissions(temp.path()).map_err(io_error(path))?,
        };
        fs::set_permissions(temp.path(), permissions).map_err(io_error(path))?;
        temp.persist(full).map_err(|e| io_error(path)(e.error))?;
        Ok(())
    }

    /// Creates a file, and the folders it needs. Never overwrites.
    pub fn create(&self, path: &str, bytes: &[u8]) -> Result<()> {
        let full = self.locate(path)?;
        if let Some(folder) = full.parent() {
            fs::create_dir_all(folder).map_err(io_error(path))?;
        }
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&full).map_err(io_error(path))?;
        file.write_all(bytes).map_err(io_error(path))
    }

    pub fn create_folder(&self, path: &str) -> Result<()> {
        let full = self.locate(path)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(io_error(path))?;
        }
        fs::create_dir(&full).map_err(io_error(path))
    }

    /// Moves or renames a file or folder. Never overwrites, except that a
    /// rename may change only the case of a name.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (source, dest) = (self.locate(from)?, self.locate(to)?);
        if source.symlink_metadata().is_err() {
            return Err(Error::NotFound(from.to_owned()));
        }
        if from != to && vpath::is_within(to, from) {
            return Err(Error::MoveIntoItself);
        }
        if dest.symlink_metadata().is_ok() && !same_file(&source, &dest) {
            return Err(Error::Exists(to.to_owned()));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(io_error(to))?;
        }
        fs::rename(&source, &dest).map_err(io_error(from))
    }

    /// Moves a file or folder to the system trash, so it can be restored.
    pub fn trash(&self, path: &str) -> Result<()> {
        let full = self.locate(path)?;
        if full.symlink_metadata().is_err() {
            return Err(Error::NotFound(path.to_owned()));
        }
        if let Some(folder) = &self.trash_folder {
            fs::create_dir_all(folder).map_err(io_error(path))?;
            let mut to = folder.join(vpath::name(path));
            for n in 2.. {
                if to.symlink_metadata().is_err() {
                    break;
                }
                to = folder.join(format!("{n} {}", vpath::name(path)));
            }
            return fs::rename(&full, to).map_err(io_error(path));
        }
        system_trash().delete(&full).map_err(|e| Error::Trash { path: path.to_owned(), message: e.to_string() })
    }
}

/// On macOS, without going through Finder: that asks for permission to
/// control it, and plays a sound per file.
fn system_trash() -> trash::TrashContext {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context
}

/// `.git`, `.obsidian`, `.itztli`, temporary files… none are part of the notes.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn entry_of(path: String, meta: &fs::Metadata) -> Entry {
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    Entry { path, folder: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, modified }
}

/// Temporary files are private to the user; a new note should get what any
/// other new file gets.
#[cfg(unix)]
fn default_permissions(_temp: &Path) -> io::Result<fs::Permissions> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::Permissions::from_mode(0o644))
}

#[cfg(not(unix))]
fn default_permissions(temp: &Path) -> io::Result<fs::Permissions> {
    Ok(fs::metadata(temp)?.permissions())
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!((a.symlink_metadata(), b.symlink_metadata()), (Ok(a), Ok(b)) if a.dev() == b.dev() && a.ino() == b.ino())
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// Identifies a content: equal bytes, equal revision.
pub fn revision(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes)[..16])
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::open(dir.path()).unwrap();
        (dir, vault)
    }

    #[test]
    fn lists_what_is_visible() {
        let (_dir, v) = vault();
        v.create("a.md", b"x").unwrap();
        v.create("sub/b.md", b"").unwrap();
        v.create("sub/.hidden.md", b"").unwrap();
        v.create(".itztli/x.json", b"").unwrap();
        v.create(".git/HEAD", b"").unwrap();
        let mut paths: Vec<String> = v.entries().into_iter().map(|e| e.path).collect();
        paths.sort();
        assert_eq!(paths, ["a.md", "sub", "sub/b.md"]);
        assert_eq!(v.entries_at("sub").len(), 2);
        assert!(v.entries_at(".git").is_empty() && v.entries_at("sub/.hidden.md").is_empty() && v.entries_at("gone").is_empty());
    }

    #[test]
    fn writes_keep_other_changes() {
        let (dir, v) = vault();
        v.create("a.md", b"one").unwrap();
        let first = v.read("a.md").unwrap();
        let second = v.write("a.md", "two", Some(&first.revision)).unwrap();
        assert!(matches!(v.write("a.md", "three", Some(&first.revision)), Err(Error::Conflict(_))));
        assert_eq!(v.read("a.md").unwrap(), FileText { text: "two".into(), revision: second });
        assert!(matches!(v.write("gone.md", "x", Some("r")), Err(Error::NotFound(_))));
        // No temporary files left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn never_overwrites_when_creating_or_renaming() {
        let (_dir, v) = vault();
        v.create("a.md", b"a").unwrap();
        v.create("b.md", b"b").unwrap();
        assert!(matches!(v.create("a.md", b""), Err(Error::Exists(_))));
        assert!(matches!(v.rename("a.md", "b.md"), Err(Error::Exists(_))));
        assert!(matches!(v.rename("gone.md", "c.md"), Err(Error::NotFound(_))));
        v.rename("a.md", "new/folder/a.md").unwrap();
        assert_eq!(v.read("new/folder/a.md").unwrap().text, "a");
        assert!(matches!(v.rename("new", "new/folder/in"), Err(Error::MoveIntoItself)));
        assert!(matches!(v.create_folder("new"), Err(Error::Exists(_))));
    }

    #[test]
    fn renames_may_change_only_the_case() {
        let (_dir, v) = vault();
        v.create("note.md", b"x").unwrap();
        v.rename("note.md", "Note.md").unwrap();
        assert_eq!(v.entries()[0].path, "Note.md");
        assert!(v.entries_at("note.md").is_empty());
        assert_eq!(v.entries_at("Note.md").len(), 1);
    }

    #[test]
    fn stays_inside_the_vault() {
        let (_dir, v) = vault();
        for bad in ["../x.md", "/etc/hosts", "a/../../x"] {
            assert!(v.read(bad).is_err() && v.create(bad, b"").is_err() && v.write(bad, "", None).is_err(), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_do_not_lead_out() {
        let (dir, v) = vault();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("new.md"), dir.path().join("dangling.md")).unwrap();
        assert!(matches!(v.read("link/secret.md"), Err(Error::Outside(_))));
        assert!(matches!(v.create("link/x.md", b""), Err(Error::Outside(_))));
        assert!(matches!(v.write("dangling.md", "x", None), Err(Error::Outside(_))));
        assert!(!outside.path().join("new.md").exists());
        assert!(v.entries().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn writing_keeps_the_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, v) = vault();
        v.create("a.md", b"a").unwrap();
        fs::set_permissions(dir.path().join("a.md"), fs::Permissions::from_mode(0o600)).unwrap();
        v.write("a.md", "b", None).unwrap();
        v.write("fresh.md", "b", None).unwrap();
        let mode = |name: &str| fs::metadata(dir.path().join(name)).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode("a.md"), mode("fresh.md")), (0o600, 0o644));
    }

    #[test]
    fn trashes_into_its_folder() {
        let (dir, v) = vault();
        let v = v.with_trash_folder(dir.path().join(".trash"));
        for _ in 0..2 {
            v.create("f/a.md", b"x").unwrap();
            v.trash("f").unwrap();
        }
        assert!(v.entries().is_empty());
        assert!(dir.path().join(".trash/f/a.md").exists() && dir.path().join(".trash/2 f/a.md").exists());
        assert!(matches!(v.trash("f"), Err(Error::NotFound(_))));
    }

    #[test]
    fn reports_files_that_are_not_text() {
        let (_dir, v) = vault();
        v.create("bin.md", &[0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(v.read("bin.md"), Err(Error::NotText(_))));
    }
}
