//! Renaming and moving without breaking links.
//!
//! The rule is simple to state: every link that led to a file still leads to
//! that file afterwards. So a move looks at each link that could be affected,
//! notes where it leads, applies the move, and rewrites only the links that
//! now lead somewhere else. That covers the obvious case (the moved note's
//! backlinks) and the easy ones to miss: relative links inside a moved note,
//! and links to another note whose short name just became ambiguous.

use std::collections::{BTreeSet, HashMap};

use itztli_core::link::{self, Link, LinkKind};
use itztli_core::{Entry, NoteMeta, path};
use serde::Serialize;

use crate::{Index, link_key};

/// Where a note's links have to lead, by how they are written: whether as a
/// path relative to the note, and the target.
type Destinations = HashMap<(bool, String), String>;

/// What a move does to the rest of the vault.
#[derive(Debug, Clone, Default)]
pub struct MovePlan {
    /// Old and new path of every entry that moves; folders before what they hold.
    pub moves: Vec<(String, String)>,
    /// Notes with links to rewrite, by their path after the move.
    pub relinked: Vec<RelinkedNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkedNote {
    pub path: String,
    pub links: usize,
    /// Where each link has to lead, by how it is written.
    #[serde(skip)]
    destinations: Destinations,
}

impl Index {
    /// Moves an entry (with everything inside, for a folder) and returns
    /// what it takes to keep every link leading where it did. The index is
    /// updated as if it were already done, except for the relinked notes'
    /// text: put them again once rewritten.
    pub fn move_entry(&mut self, from: &str, to: &str) -> MovePlan {
        let mut moves: Vec<(String, String)> = Vec::new();
        if self.entry(from).is_some() {
            moves.push((from.to_owned(), to.to_owned()));
        }
        moves.extend(self.inside(from).map(|e| (e.path.clone(), format!("{to}{}", &e.path[from.len()..]))));
        let moved: HashMap<&str, &str> = moves.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let after = |p: &str| moved.get(p).map_or_else(|| p.to_owned(), |to| (*to).to_owned());

        // Notes whose links may lead elsewhere after the move: those using
        // the old or new name of a moved file, and the moved notes.
        let mut sources: BTreeSet<String> = BTreeSet::new();
        for (old, new) in &moves {
            for key in [link_key(old), link_key(new)] {
                sources.extend(self.incoming.get(&key).into_iter().flatten().cloned());
            }
            if self.note(old).is_some() {
                sources.insert(old.clone());
            }
        }
        let before: Vec<(String, Destinations)> = sources
            .into_iter()
            .filter_map(|source| {
                let destinations: Destinations = self
                    .note(&source)?
                    .links
                    .iter()
                    .filter(|l| !l.target.is_empty() && l.dest.is_some())
                    .filter_map(|l| Some((written(l), after(self.resolve_link(&source, l)?))))
                    .collect();
                Some((after(&source), destinations))
            })
            .collect();

        let taken: Vec<(Entry, Option<NoteMeta>)> = moves
            .iter()
            .filter_map(|(old, new)| {
                let entry = Entry { path: new.clone(), ..self.entry(old)?.clone() };
                Some((entry, self.note(old).map(|meta| NoteMeta::clone(meta))))
            })
            .collect();
        self.remove(from);
        for (entry, meta) in taken {
            self.put(entry, meta);
        }

        let relinked = before
            .into_iter()
            .filter_map(|(path, destinations)| {
                let meta = self.note(&path)?;
                let links = meta.links.iter().filter(|l| self.new_dest(&path, l, &destinations).is_some()).count();
                (links > 0).then_some(RelinkedNote { path, links, destinations })
            })
            .collect();
        MovePlan { moves, relinked }
    }

    /// The note's text with its links rewritten, from its current text.
    /// `None` when there is nothing to change after all.
    pub fn relink(&self, note: &RelinkedNote, text: &str) -> Option<String> {
        let meta = itztli_core::parse(text);
        let edits: Vec<_> = meta
            .links
            .iter()
            .filter_map(|l| Some((l.dest.clone()?, self.new_dest(&note.path, l, &note.destinations)?)))
            .collect();
        (!edits.is_empty()).then(|| link::replace_ranges(text, edits))
    }

    /// What to write as the link's destination, if it no longer leads where
    /// it has to.
    fn new_dest(&self, source: &str, l: &Link, destinations: &Destinations) -> Option<String> {
        l.dest.as_ref()?;
        let wanted = destinations.get(&written(l))?;
        if self.resolve_link(source, l) == Some(wanted) {
            return None;
        }
        let place = l.subpath.as_ref().map(|s| format!("#{s}")).unwrap_or_default();
        Some(match l.kind {
            LinkKind::Markdown | LinkKind::Image => {
                let dest =
                    if l.target.starts_with('/') { format!("/{wanted}") } else { path::relative(path::parent(source), wanted) };
                // A link that left out `.md` keeps doing so.
                let dest = match path::strip_note_extension(&dest) {
                    Some(short) if !path::is_note(&l.target) => short.to_owned(),
                    _ => dest,
                };
                format!("{}{}", link::percent_encode(&dest), place.replace(' ', "%20"))
            }
            LinkKind::Wiki | LinkKind::Embed | LinkKind::Property => {
                let dest = if l.target.contains('/') {
                    path::strip_note_extension(wanted).unwrap_or(wanted).to_owned()
                } else {
                    self.link_text(source, wanted)
                };
                let extension = if path::is_note(&l.target) && path::is_note(wanted) { ".md" } else { "" };
                format!("{dest}{extension}{place}")
            }
        })
    }
}

/// Links written alike in one note lead to the same place.
fn written(l: &Link) -> (bool, String) {
    (l.kind.is_relative(), l.target.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::index;

    /// Moves in a vault given as (path, text) and returns every note's text
    /// afterwards, checking that each link still leads where it did.
    fn moved(files: &[(&str, &str)], from: &str, to: &str) -> HashMap<String, String> {
        let mut i = index(files);
        let before = i.clone();
        let plan = i.move_entry(from, to);
        let renamed: HashMap<&str, &str> = plan.moves.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let now = |p: &str| renamed.get(p).copied().unwrap_or(p).to_owned();

        let mut texts: HashMap<String, String> = files.iter().map(|(p, t)| (now(p), t.to_string())).collect();
        for note in &plan.relinked {
            let text = i.relink(note, &texts[&note.path]).expect("planned changes exist");
            let meta = itztli_core::parse(&text);
            i.put(i.entry(&note.path).unwrap().clone(), Some(meta));
            texts.insert(note.path.clone(), text);
        }
        for (source, meta) in before.notes() {
            let after = i.note(&now(source)).unwrap();
            assert_eq!(meta.links.len(), after.links.len());
            for (old, new) in meta.links.iter().zip(&after.links) {
                if let Some(led) = before.resolve_link(source, old).map(now) {
                    assert_eq!(
                        Some(led.as_str()),
                        i.resolve_link(&now(source), new),
                        "{source}: {} → {}",
                        old.target,
                        new.target
                    );
                }
                assert_eq!(
                    (&old.subpath, &old.display, &old.relation, old.kind),
                    (&new.subpath, &new.display, &new.relation, new.kind)
                );
            }
        }
        texts
    }

    #[test]
    fn renaming_rewrites_backlinks_and_nothing_else() {
        let t = moved(
            &[
                ("Old.md", "[[Old#Me]] [[Old]]"),
                ("a.md", "[[Old]] [[old|alias]] ![[Old#H]] [m](Old.md#x%20y) `[[Old]]` text Old\n\n| [[Old\\|t]] |\n|--|\n"),
                ("b.md", "---\nup: \"[[Old]]\"\n---\n[[Older]]"),
            ],
            "Old.md",
            "New name.md",
        );
        assert_eq!(
            t["a.md"],
            "[[New name]] [[New name|alias]] ![[New name#H]] [m](New%20name.md#x%20y) `[[Old]]` text Old\n\n| [[New name\\|t]] |\n|--|\n"
        );
        assert_eq!(t["b.md"], "---\nup: \"[[New name]]\"\n---\n[[Older]]");
        assert_eq!(t["New name.md"], "[[New name#Me]] [[New name]]");
    }

    #[test]
    fn links_in_properties_follow_at_any_depth() {
        let note = |name: &str| {
            format!(
                "---\nauthor: \"[[{name}]]\"\nattendees:\n  - \"[[{name}|A]]\"\nproject:\n  lead: [\"[[{name}#Bio]]\"]\n---\n"
            )
        };
        let t = moved(&[("Ana.md", "# Bio"), ("m.md", &note("Ana"))], "Ana.md", "People/Ana María.md");
        assert_eq!(t["m.md"], note("Ana María"));
    }

    #[test]
    fn moving_leaves_names_that_still_work() {
        let t = moved(
            &[("a.md", "[[Note]] [m](Note.md) [[x/Note]]"), ("Note.md", "[[a]] [a](a.md) ![](img/p.png)"), ("img/p.png", "")],
            "Note.md",
            "deep/er/Note.md",
        );
        assert_eq!(t["a.md"], "[[Note]] [m](Note.md) [[x/Note]]", "a Markdown link still found by name is left alone");
        assert_eq!(t["deep/er/Note.md"], "[[a]] [a](a.md) ![](img/p.png)");
    }

    #[test]
    fn relative_links_of_a_moved_note_follow() {
        let t = moved(
            &[
                ("a/Note.md", "[s](sib.md) [p](../img/p%20q.png) [[sib]]"),
                ("a/sib.md", ""),
                ("b/sib.md", ""),
                ("img/p q.png", ""),
            ],
            "a/Note.md",
            "b/Note.md",
        );
        assert_eq!(t["b/Note.md"], "[s](../a/sib.md) [p](../img/p%20q.png) [[a/sib]]");
    }

    #[test]
    fn renaming_into_an_existing_name_disambiguates_both() {
        let t = moved(&[("x.md", "[[A]] [[B]]"), ("f/A.md", ""), ("g/B.md", "")], "f/A.md", "f/B.md");
        assert_eq!(t["x.md"], "[[f/B]] [[g/B]]");
        // Closer to the root, the renamed note would steal the other's links.
        let t = moved(&[("x.md", "[[B]]"), ("A.md", ""), ("g/B.md", "")], "A.md", "B.md");
        assert_eq!(t["x.md"], "[[g/B]]");
    }

    #[test]
    fn folders_move_with_everything_inside() {
        let t = moved(
            &[
                ("f/", ""),
                ("f/a.md", "[[f/b]] [b](b.md)"),
                ("f/b.md", "[up](../x.md)"),
                ("f/i.png", ""),
                ("x.md", "[[f/a]] [[a]] ![[f/i.png]] [m](f/b.md)"),
            ],
            "f",
            "g/h",
        );
        assert_eq!(t["x.md"], "[[g/h/a]] [[a]] ![[g/h/i.png]] [m](g/h/b.md)");
        assert_eq!(t["g/h/a.md"], "[[g/h/b]] [b](b.md)");
        assert_eq!(t["g/h/b.md"], "[up](../../x.md)");
    }

    #[test]
    fn changing_only_the_case_keeps_links() {
        let t = moved(&[("note.md", ""), ("x.md", "[[note]]")], "note.md", "Note.md");
        assert_eq!(t["x.md"], "[[note]]");
    }

    #[test]
    fn renaming_an_attachment() {
        let t = moved(&[("p.png", ""), ("x.md", "![[p.png|300]] ![alt](p.png)")], "p.png", "media/new pic.png");
        assert_eq!(t["x.md"], "![[new pic.png|300]] ![alt](media/new%20pic.png)");
    }

    #[test]
    fn links_to_nothing_stay_as_they_are() {
        let t = moved(&[("a.md", ""), ("x.md", "[[gone]] [[a]]")], "a.md", "gone.md");
        assert_eq!(t["x.md"], "[[gone]] [[gone]]");
    }
}
