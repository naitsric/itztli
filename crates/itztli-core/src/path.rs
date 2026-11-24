//! Vault paths: relative to the vault root, `/`-separated, with no leading
//! slash and no `.` or `..`. The empty path is the root itself.

use unicode_normalization::{UnicodeNormalization, is_nfc};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("“{0}” is not a valid path inside the vault")]
pub struct InvalidPath(pub String);

/// Rejects anything that could name a place outside the vault, or that some
/// platform would read as a separator or a drive.
pub fn validate(path: &str) -> Result<(), InvalidPath> {
    let ok = !path.is_empty()
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.contains(['\\', '\0'])
                && !(cfg!(windows) && part.contains(':'))
        });
    if ok { Ok(()) } else { Err(InvalidPath(path.to_owned())) }
}

/// The last component, extension included.
pub fn name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

/// The folder holding the path; empty at the root.
pub fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

pub fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() { name.to_owned() } else { format!("{folder}/{name}") }
}

pub fn is_note(path: &str) -> bool {
    strip_note_extension(path).is_some_and(|stem| !stem.is_empty() && !stem.ends_with('/'))
}

/// The path without `.md`, or `None` when it has another extension.
pub fn strip_note_extension(path: &str) -> Option<&str> {
    let at = path.len().checked_sub(3)?;
    (path.is_char_boundary(at) && path[at..].eq_ignore_ascii_case(".md")).then(|| &path[..at])
}

/// What a link calls this file: a note goes without its extension, anything
/// else (an image, a PDF) by its full name.
pub fn link_name(path: &str) -> &str {
    let name = name(path);
    strip_note_extension(name).unwrap_or(name)
}

/// How names compare: Unicode-normalized (macOS may hand out decomposed
/// names) and ignoring case.
pub fn key(text: &str) -> String {
    if text.is_ascii() {
        text.to_ascii_lowercase()
    } else if is_nfc(text) {
        text.to_lowercase()
    } else {
        text.nfc().collect::<String>().to_lowercase()
    }
}

/// `path` is `folder` itself or something inside it. The root holds everything.
pub fn is_within(path: &str, folder: &str) -> bool {
    folder.is_empty() || path.strip_prefix(folder).is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// Follows a relative reference (`../img/a.png`, `/from/root.md`) from a
/// folder. `None` when it leaves the vault.
pub fn resolve(folder: &str, reference: &str) -> Option<String> {
    let mut parts: Vec<&str> = match reference.strip_prefix('/') {
        Some(_) => Vec::new(),
        None => folder.split('/').filter(|p| !p.is_empty()).collect(),
    };
    for part in reference.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The reference that leads from a folder to a path, the inverse of [`resolve`].
pub fn relative(folder: &str, path: &str) -> String {
    let from: Vec<&str> = folder.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = path.split('/').collect();
    let shared = from.iter().zip(&to[..to.len() - 1]).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - shared];
    parts.extend(&to[shared..]);
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_that_leave_the_vault() {
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a\\b", "a/", "nul\0"] {
            assert!(validate(bad).is_err(), "{bad:?}");
        }
        for good in ["a", "a/b.md", "Diario/2026-11-24.md", ".itztli/x", "a..b/c...md"] {
            assert!(validate(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn names_and_parents() {
        assert_eq!((name("a/b/c.md"), parent("a/b/c.md")), ("c.md", "a/b"));
        assert_eq!((name("c.md"), parent("c.md")), ("c.md", ""));
        assert_eq!(link_name("a/Note.MD"), "Note");
        assert_eq!(link_name("a/v1.2 plan.md"), "v1.2 plan");
        assert_eq!(link_name("a/photo.png"), "photo.png");
        assert!(is_note("x.md") && !is_note(".md") && !is_note("a/.md") && !is_note("x.txt") && !is_note("ñ"));
    }

    #[test]
    fn keys_ignore_case_and_composition() {
        assert_eq!(key("Canción"), key("CANCIO\u{301}N"));
        assert_ne!(key("cancion"), key("canción"));
    }

    #[test]
    fn containment_respects_component_boundaries() {
        assert!(is_within("a/b", "a") && is_within("a", "a") && is_within("a", ""));
        assert!(!is_within("ab", "a"));
    }

    #[test]
    fn references_resolve_and_relativize() {
        assert_eq!(resolve("a/b", "../c.md").as_deref(), Some("a/c.md"));
        assert_eq!(resolve("a/b", "/c.md").as_deref(), Some("c.md"));
        assert_eq!(resolve("a", "./c d.md").as_deref(), Some("a/c d.md"));
        assert_eq!(resolve("a", "../../c.md"), None);
        for (folder, path) in [("", "x.md"), ("a/b", "a/c/x.md"), ("a", "a/x.md"), ("a/b/c", "x.md")] {
            assert_eq!(resolve(folder, &relative(folder, path)).as_deref(), Some(path));
        }
        assert_eq!(relative("a/b", "a/c/x.md"), "../c/x.md");
    }
}
