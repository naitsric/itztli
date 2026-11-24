//! The vault's index, in memory: what every note says and how notes link.
//!
//! There is no database behind it. Parsing a vault takes less than opening
//! one would (see benches/vault.rs), and what is never stored is never stale.

mod find;
mod graph;
mod grep;
mod refactor;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use itztli_core::{Entry, Link, NoteMeta, path, section};
use serde::Serialize;

pub use find::{FileHit, FindScope, HeadingHit, LinkSuggestion};
pub use graph::Graph;
pub use grep::{FileMatches, QueryError, TextMatch, TextQuery, TextResults, grep};
pub use refactor::{MovePlan, RelinkedNote};

#[derive(Debug, Clone, Default)]
pub struct Index {
    entries: BTreeMap<String, Entry>,
    notes: HashMap<String, Arc<NoteMeta>>,
    /// Files by the key of the name links call them, best match first.
    names: HashMap<String, Vec<String>>,
    /// Notes by the key of each name they link to, resolved or not.
    incoming: HashMap<String, BTreeSet<String>>,
}

/// A note that links somewhere, and the places where it does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub path: String,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProblemKind {
    /// The link's file does not exist.
    MissingNote,
    /// The file exists, but not the heading or block.
    MissingPlace,
    InvalidFrontmatter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub kind: ProblemKind,
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub len: u32,
    /// What is missing: the link's target, with its subpath if that is it.
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub name: String,
    /// Notes carrying the tag or one nested under it.
    pub notes: u32,
}

/// The key a link is looked up by: the name at the end of its target.
fn link_key(target: &str) -> String {
    path::key(path::link_name(target))
}

/// How whole paths compare when looking one up: a note may go without `.md`.
fn path_key(p: &str) -> String {
    path::key(path::strip_note_extension(p).unwrap_or(p))
}

impl Index {
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values()
    }

    pub fn entry(&self, path: &str) -> Option<&Entry> {
        self.entries.get(path)
    }

    pub fn note(&self, path: &str) -> Option<&Arc<NoteMeta>> {
        self.notes.get(path)
    }

    pub fn notes(&self) -> impl Iterator<Item = (&str, &Arc<NoteMeta>)> {
        self.notes.iter().map(|(path, meta)| (path.as_str(), meta))
    }

    pub fn note_count(&self) -> usize {
        self.notes.len()
    }

    /// Entries inside a folder, at any depth.
    pub fn inside<'a>(&'a self, folder: &'a str) -> impl Iterator<Item = &'a Entry> {
        let from = if folder.is_empty() { String::new() } else { format!("{folder}/") };
        self.entries.range(from.clone()..).map(|(_, e)| e).take_while(move |e| e.path.starts_with(&from))
    }

    /// Adds or replaces an entry. `meta` is what a note says, `None` for
    /// anything else (a folder, an image, a note that could not be read).
    pub fn put(&mut self, entry: Entry, meta: Option<NoteMeta>) {
        let p = entry.path.clone();
        self.forget_note(&p);
        if !entry.folder && !self.entries.contains_key(&p) {
            let named = self.names.entry(link_key(&p)).or_default();
            named.push(p.clone());
            // Notes before attachments, then nearest to the root.
            named.sort_by_key(|p| (!path::is_note(p), p.matches('/').count(), p.len(), p.clone()));
        }
        if let Some(meta) = meta {
            for link in &meta.links {
                if !link.target.is_empty() {
                    self.incoming.entry(link_key(&link.target)).or_default().insert(p.clone());
                }
            }
            self.notes.insert(p.clone(), Arc::new(meta));
        }
        self.entries.insert(p, entry);
    }

    /// Removes an entry and, for a folder, everything inside.
    pub fn remove(&mut self, path: &str) -> Vec<String> {
        let mut gone: Vec<String> = self.inside(path).map(|e| e.path.clone()).collect();
        if self.entries.contains_key(path) {
            gone.push(path.to_owned());
        }
        for p in &gone {
            self.forget_note(p);
            self.entries.remove(p);
            let key = link_key(p);
            if let Some(named) = self.names.get_mut(&key) {
                named.retain(|n| n != p);
                if named.is_empty() {
                    self.names.remove(&key);
                }
            }
        }
        gone
    }

    fn forget_note(&mut self, p: &str) {
        let Some(meta) = self.notes.remove(p) else { return };
        for link in &meta.links {
            let key = link_key(&link.target);
            if let Some(sources) = self.incoming.get_mut(&key) {
                sources.remove(p);
                if sources.is_empty() {
                    self.incoming.remove(&key);
                }
            }
        }
    }

    /// The file a link leads to. `relative` for Markdown links, whose target
    /// is a path from the note; others are names looked up across the vault.
    pub fn resolve(&self, source: &str, target: &str, relative: bool) -> Option<&str> {
        if target.is_empty() {
            return self.entries.get_key_value(source).map(|(p, _)| p.as_str());
        }
        let folder = path::parent(source);
        let explicit = target.starts_with("./") || target.starts_with("../");
        let from_note = || path::resolve(folder, target).and_then(|p| self.exact(&p));
        let from_root = || path::resolve("", target).and_then(|p| self.exact(&p));

        if explicit {
            return from_note();
        }
        if let Some(rooted) = target.strip_prefix('/') {
            return self.exact(rooted);
        }
        if relative && let Some(found) = from_note().or_else(from_root) {
            return Some(found);
        }
        if target.contains('/') {
            if let Some(found) = from_root().or_else(from_note) {
                return Some(found);
            }
            let suffix = format!("/{}", path_key(target));
            return self.best(target, folder, |p| path_key(p).ends_with(&suffix));
        }
        self.best(target, folder, |_| true)
    }

    pub fn resolve_link(&self, source: &str, link: &Link) -> Option<&str> {
        self.resolve(source, &link.target, link.kind.is_relative())
    }

    fn exact(&self, target: &str) -> Option<&str> {
        // The exact spelling first: two files may differ only in case.
        if let Some((found, entry)) = self.entries.get_key_value(target)
            && !entry.folder
        {
            return Some(found);
        }
        let wanted = path_key(target);
        self.best(target, "", |p| path_key(p) == wanted)
    }

    /// Among the files with the target's name: one next to the note, else
    /// the first (a note before an attachment, nearest to the root).
    fn best(&self, target: &str, folder: &str, accepts: impl Fn(&str) -> bool) -> Option<&str> {
        // `Note.md` can only be a note; `Note` may be either.
        let notes_only = path::is_note(target);
        let mut fits = self
            .names
            .get(&link_key(target))?
            .iter()
            .map(String::as_str)
            .filter(|p| (!notes_only || path::is_note(p)) && accepts(p));
        let first = fits.next()?;
        if path::parent(first) == folder {
            return Some(first);
        }
        let sibling = fits.find(|p| path::parent(p) == folder && path::is_note(p) == path::is_note(first));
        Some(sibling.unwrap_or(first))
    }

    /// What a wiki link in `source` writes to reach `to`: its name, or its
    /// path from the root when another file goes by that name too.
    pub fn link_text(&self, source: &str, to: &str) -> String {
        let name = path::link_name(to);
        let only_one = self.names.get(&link_key(to)).is_some_and(|named| named.len() == 1);
        if only_one && self.resolve(source, name, false) == Some(to) {
            return name.to_owned();
        }
        path::strip_note_extension(to).unwrap_or(to).to_owned()
    }

    /// Notes linking to a file, by path.
    pub fn backlinks(&self, to: &str) -> Vec<Backlink> {
        let Some(sources) = self.incoming.get(&link_key(to)) else { return Vec::new() };
        sources
            .iter()
            .filter(|source| *source != to)
            .filter_map(|source| {
                let meta = self.notes.get(source)?;
                let links: Vec<Link> = meta.links.iter().filter(|l| self.resolve_link(source, l) == Some(to)).cloned().collect();
                (!links.is_empty()).then(|| Backlink { path: source.clone(), links })
            })
            .collect()
    }

    /// The same for a name nothing has yet: who is waiting for that note.
    pub fn mentions_of_missing(&self, target: &str) -> Vec<Backlink> {
        let wanted = link_key(target);
        let Some(sources) = self.incoming.get(&wanted) else { return Vec::new() };
        sources
            .iter()
            .filter_map(|source| {
                let meta = self.notes.get(source)?;
                let links: Vec<Link> = meta
                    .links
                    .iter()
                    .filter(|l| !l.target.is_empty() && link_key(&l.target) == wanted && self.resolve_link(source, l).is_none())
                    .cloned()
                    .collect();
                (!links.is_empty()).then(|| Backlink { path: source.clone(), links })
            })
            .collect()
    }

    /// Every tag and its parents (`a/b` counts for `a` too), by name.
    pub fn tags(&self) -> Vec<TagCount> {
        // Keyed ignoring case; shown as first seen.
        let mut counts: BTreeMap<String, (String, BTreeSet<&str>)> = BTreeMap::new();
        for (p, meta) in &self.notes {
            for tag in &meta.tags {
                let ends = tag.name.match_indices('/').map(|(at, _)| at).chain([tag.name.len()]);
                for end in ends.filter(|&end| end > 0) {
                    let name = &tag.name[..end];
                    counts.entry(path::key(name)).or_insert_with(|| (name.to_owned(), BTreeSet::new())).1.insert(p);
                }
            }
        }
        counts.into_values().map(|(name, notes)| TagCount { name, notes: notes.len() as u32 }).collect()
    }

    /// Notes carrying a tag or one nested under it, by path.
    pub fn notes_with_tag(&self, tag: &str) -> Vec<String> {
        let wanted = path::key(tag.trim_start_matches('#'));
        let mut found: Vec<String> = self
            .notes
            .iter()
            .filter(|(_, meta)| meta.tags.iter().any(|t| path::is_within(&path::key(&t.name), &wanted)))
            .map(|(p, _)| p.clone())
            .collect();
        found.sort();
        found
    }

    /// Links that lead nowhere, by path and line.
    pub fn problems(&self) -> Vec<Problem> {
        let mut found: Vec<Problem> = self.notes.keys().flat_map(|p| self.problems_in(p)).collect();
        found.sort_by(|a, b| (&a.path, a.line, a.col).cmp(&(&b.path, b.line, b.col)));
        found
    }

    pub fn problems_in(&self, p: &str) -> Vec<Problem> {
        let Some(meta) = self.notes.get(p) else { return Vec::new() };
        let mut found = Vec::new();
        if meta.invalid_frontmatter {
            let kind = ProblemKind::InvalidFrontmatter;
            found.push(Problem { kind, path: p.to_owned(), line: 0, col: 0, len: 3, target: String::new() });
        }
        for link in &meta.links {
            let missing = match self.resolve_link(p, link) {
                None => Some((ProblemKind::MissingNote, link.target.clone())),
                Some(to) => link.subpath.as_deref().and_then(|subpath| {
                    let there = self.notes.get(to).is_none_or(|meta| section::line_of(meta, subpath).is_some());
                    (!there).then(|| (ProblemKind::MissingPlace, format!("{}#{subpath}", link.target)))
                }),
            };
            if let Some((kind, target)) = missing {
                found.push(Problem { kind, path: p.to_owned(), line: link.line, col: link.col, len: link.len, target });
            }
        }
        found
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    pub fn entry(path: &str) -> Entry {
        Entry { path: path.to_owned(), folder: false, size: 0, modified: 0 }
    }

    /// An index of notes given as (path, text). A path ending in `/` is a folder.
    pub fn index(files: &[(&str, &str)]) -> Index {
        let mut index = Index::default();
        for (p, text) in files {
            match p.strip_suffix('/') {
                Some(folder) => index.put(Entry { folder: true, ..entry(folder) }, None),
                None => index.put(entry(p), path::is_note(p).then(|| itztli_core::parse(text))),
            }
        }
        index
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{entry, index};
    use super::*;

    #[test]
    fn names_resolve_across_the_vault() {
        let i = index(&[("a/Note.md", ""), ("Note.md", ""), ("b/Other.md", ""), ("img/Pic.png", ""), ("b/Deep.md", "")]);
        let wiki = |source, target| i.resolve(source, target, false);
        assert_eq!(wiki("x.md", "note"), Some("Note.md"));
        assert_eq!(wiki("a/x.md", "Note"), Some("a/Note.md"), "the one next to the note wins");
        assert_eq!(wiki("x.md", "a/note"), Some("a/Note.md"));
        assert_eq!(wiki("x.md", "Note.md"), Some("Note.md"));
        assert_eq!(wiki("x.md", "pic.png"), Some("img/Pic.png"));
        assert_eq!(wiki("x.md", "Pic"), None);
        assert_eq!(wiki("b/x.md", "./Other"), Some("b/Other.md"));
        assert_eq!(wiki("b/x.md", "../Note"), Some("Note.md"));
        assert_eq!(wiki("x.md", "/Note"), Some("Note.md"));
        assert_eq!(wiki("x.md", "zzz/Note"), None);
        assert_eq!(wiki("b/Deep.md", ""), Some("b/Deep.md"));
    }

    #[test]
    fn partial_paths_match_from_the_end() {
        let i = index(&[("work/2026/q4/Plan.md", ""), ("home/Plan.md", "")]);
        assert_eq!(i.resolve("x.md", "q4/Plan", false), Some("work/2026/q4/Plan.md"));
        assert_eq!(i.resolve("x.md", "Plan", false), Some("home/Plan.md"));
        assert_eq!(i.resolve("x.md", "4/Plan", false), None);
    }

    #[test]
    fn notes_win_over_files_without_extension() {
        let i = index(&[("Note", ""), ("sub/Note.md", "")]);
        assert_eq!(i.resolve("x.md", "Note", false), Some("sub/Note.md"));
    }

    #[test]
    fn markdown_links_are_relative_first() {
        let i = index(&[("a/b.md", ""), ("b.md", ""), ("c/only.md", "")]);
        assert_eq!(i.resolve("a/x.md", "b.md", true), Some("a/b.md"));
        assert_eq!(i.resolve("a/x.md", "../b.md", true), Some("b.md"));
        assert_eq!(i.resolve("a/x.md", "/b.md", true), Some("b.md"));
        assert_eq!(i.resolve("a/x.md", "c/only.md", true), Some("c/only.md"), "then from the root");
        assert_eq!(i.resolve("a/x.md", "only.md", true), Some("c/only.md"), "then by name");
    }

    #[test]
    fn exact_spelling_wins_over_case() {
        let i = index(&[("A.md", ""), ("a.md", "")]);
        assert_eq!(i.resolve("x.md", "/a.md", false), Some("a.md"));
        assert_eq!(i.resolve("x.md", "/A.md", false), Some("A.md"));
    }

    #[test]
    fn backlinks_follow_changes() {
        let mut i = index(&[("a.md", "[[b]] and [[B|again]]\n[x](b.md)"), ("b.md", "[[b]]"), ("c.md", "[[zzz]]")]);
        let back = i.backlinks("b.md");
        assert_eq!(back.len(), 1, "a note's links to itself are not backlinks");
        assert_eq!((back[0].path.as_str(), back[0].links.len()), ("a.md", 3));

        i.put(entry("a.md"), Some(itztli_core::parse("nothing")));
        assert!(i.backlinks("b.md").is_empty());

        assert_eq!(i.mentions_of_missing("ZZZ")[0].path, "c.md");
        i.put(entry("zzz.md"), Some(itztli_core::parse("")));
        assert_eq!(i.backlinks("zzz.md")[0].path, "c.md");
        assert!(i.mentions_of_missing("zzz").is_empty());
    }

    #[test]
    fn removing_a_folder_removes_what_it_holds() {
        let mut i = index(&[("f/", ""), ("f/a.md", "[[t]]"), ("f/g/", ""), ("f/g/b.md", "[[t]]"), ("fx.md", ""), ("t.md", "")]);
        assert_eq!(i.backlinks("t.md").len(), 2);
        let mut gone = i.remove("f");
        gone.sort();
        assert_eq!(gone, ["f", "f/a.md", "f/g", "f/g/b.md"]);
        assert!(i.backlinks("t.md").is_empty());
        assert_eq!(i.entries().count(), 2);
        assert_eq!(i.resolve("x.md", "a", false), None);
    }

    #[test]
    fn link_text_is_the_name_unless_it_is_ambiguous() {
        let i = index(&[("a/Note.md", ""), ("b/Note.md", ""), ("b/Only.md", ""), ("b/p.png", "")]);
        assert_eq!(i.link_text("x.md", "b/Only.md"), "Only");
        assert_eq!(i.link_text("x.md", "b/Note.md"), "b/Note");
        assert_eq!(i.link_text("b/x.md", "b/Note.md"), "b/Note");
        assert_eq!(i.link_text("x.md", "b/p.png"), "p.png");
    }

    #[test]
    fn tags_count_their_parents() {
        let i = index(&[("a.md", "#work/q4 #Work"), ("b.md", "#work/q3"), ("c.md", "#home")]);
        let tags: Vec<(String, u32)> = i.tags().into_iter().map(|t| (path::key(&t.name), t.notes)).collect();
        assert_eq!(tags, [("home".into(), 1), ("work".into(), 2), ("work/q3".into(), 1), ("work/q4".into(), 1)]);
        assert_eq!(i.notes_with_tag("#WORK"), ["a.md", "b.md"]);
        assert_eq!(i.notes_with_tag("wor"), Vec::<String>::new());
    }

    #[test]
    fn problems_name_what_is_missing() {
        let i = index(&[
            ("a.md", "[[gone]]\n[[b#Nope]] [[b#Yes]] [[#Here]] ![[p.png]]\n"),
            ("b.md", "# Yes"),
            ("c.md", "---\n[\n---\n"),
        ]);
        let found: Vec<(ProblemKind, u32, String)> = i.problems().into_iter().map(|p| (p.kind, p.line, p.target)).collect();
        assert_eq!(
            found,
            [
                (ProblemKind::MissingNote, 0, "gone".into()),
                (ProblemKind::MissingPlace, 1, "b#Nope".into()),
                (ProblemKind::MissingPlace, 1, "#Here".into()),
                (ProblemKind::MissingNote, 1, "p.png".into()),
                (ProblemKind::InvalidFrontmatter, 0, String::new()),
            ]
        );
    }
}
