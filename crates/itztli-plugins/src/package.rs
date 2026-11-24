//! A plugin's folder, read whole.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::manifest::{MANIFEST_FILE, Manifest};

/// Everything the app will ever load of a plugin: its manifest, code, styles
/// and `assets/`. The rest of the folder (sources, `node_modules`) is ignored.
#[derive(Debug, Clone)]
pub struct Package {
    pub manifest: Manifest,
    pub files: BTreeMap<String, Vec<u8>>,
    /// Identifies these exact files. Consent is given to a fingerprint.
    pub fingerprint: String,
}

const MAX_TOTAL: usize = 32 * 1024 * 1024;

impl Package {
    pub fn read(dir: &Path) -> Result<Self, String> {
        let folder = dir.file_name().and_then(|n| n.to_str()).ok_or("the folder's name is not valid")?;
        let mut total = 0;
        let json = read_file(dir, MANIFEST_FILE, &mut total)?;
        let manifest = Manifest::parse(&json, folder)?;

        let mut files = BTreeMap::from([(MANIFEST_FILE.to_owned(), json)]);
        for name in [Some(&manifest.main), manifest.styles.as_ref()].into_iter().flatten() {
            files.insert(name.clone(), read_file(dir, name, &mut total)?);
        }
        let assets = dir.join("assets");
        if assets.is_dir() {
            // Links are not followed: what they lead to could change unseen.
            for entry in walkdir::WalkDir::new(&assets).sort_by_file_name() {
                let entry = entry.map_err(|e| format!("assets: {e}"))?;
                if !entry.file_type().is_file() {
                    continue;
                }
                let relative = entry.path().strip_prefix(dir).map_err(|e| e.to_string())?;
                let name = relative.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/");
                let bytes = read_file(dir, &name, &mut total)?;
                files.insert(name, bytes);
            }
        }
        let fingerprint = fingerprint(&files);
        Ok(Self { manifest, files, fingerprint })
    }
}

fn read_file(dir: &Path, name: &str, total: &mut usize) -> Result<Vec<u8>, String> {
    let path = dir.join(name);
    let meta = fs::symlink_metadata(&path).map_err(|_| format!("“{name}” is missing"))?;
    if !meta.is_file() {
        return Err(format!("“{name}” is not a regular file"));
    }
    *total += meta.len() as usize;
    if *total > MAX_TOTAL {
        return Err(format!("bigger than {} MB", MAX_TOTAL / 1024 / 1024));
    }
    fs::read(&path).map_err(|e| format!("cannot read “{name}”: {e}"))
}

/// Names and lengths go in too, so no two sets of files look the same.
fn fingerprint(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut hash = Sha256::new();
    for (name, bytes) in files {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, text: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn plugin() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("demo");
        write(&dir, "plugin.json", r#"{"id":"demo","name":"Demo","version":"1","api":1}"#);
        write(&dir, "main.js", "export default {}");
        (root, dir)
    }

    #[test]
    fn every_loaded_byte_counts_and_nothing_else() {
        let (_root, dir) = plugin();
        let first = Package::read(&dir).unwrap().fingerprint;
        write(&dir, "node_modules/x/index.js", "ignored");
        write(&dir, "src/main.ts", "ignored");
        assert_eq!(Package::read(&dir).unwrap().fingerprint, first);
        write(&dir, "assets/a.svg", "<svg/>");
        let second = Package::read(&dir).unwrap();
        assert_ne!(second.fingerprint, first);
        assert!(second.files.contains_key("assets/a.svg"));
        write(&dir, "main.js", "export default {} ");
        assert_ne!(Package::read(&dir).unwrap().fingerprint, second.fingerprint);
    }

    #[test]
    fn reports_missing_files() {
        let (_root, dir) = plugin();
        fs::remove_file(dir.join("main.js")).unwrap();
        assert_eq!(Package::read(&dir).unwrap_err(), "“main.js” is missing");
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_followed() {
        let (root, dir) = plugin();
        fs::write(root.path().join("outside.js"), "x").unwrap();
        fs::remove_file(dir.join("main.js")).unwrap();
        std::os::unix::fs::symlink(root.path().join("outside.js"), dir.join("main.js")).unwrap();
        assert!(Package::read(&dir).unwrap_err().contains("not a regular file"));
    }
}
