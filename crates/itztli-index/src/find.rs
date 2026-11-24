//! Fuzzy search by name: files, headings and what to offer after `[[`.

use itztli_core::path;
use nucleo_matcher::pattern::{AtomKind, CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::Index;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindScope {
    Notes,
    Files,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    /// The alias or title that matched, when it was not the name or path.
    pub alias: Option<String>,
    /// Whether the positions are in the path rather than the name.
    pub in_path: bool,
    /// UTF-16 positions that matched, in the name, alias or path.
    pub positions: Vec<u32>,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingHit {
    pub path: String,
    pub text: String,
    pub level: u8,
    pub line: u32,
    pub positions: Vec<u32>,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSuggestion {
    /// `None` for a note other notes link to but nobody has written yet.
    pub path: Option<String>,
    /// What to write inside the brackets.
    pub insert: String,
    pub alias: Option<String>,
}

/// A name that matches is worth more than a path that does, and an alias is
/// in between.
const NAME_BONUS: u32 = 60;
const ALIAS_BONUS: u32 = 30;

struct Fuzzy {
    pattern: Pattern,
    matcher: Matcher,
    buffer: Vec<char>,
}

impl Fuzzy {
    fn new(query: &str) -> Self {
        Self {
            pattern: Pattern::new(query, CaseMatching::Ignore, Normalization::Smart, AtomKind::Fuzzy),
            matcher: Matcher::new(Config::DEFAULT.match_paths()),
            buffer: Vec::new(),
        }
    }

    fn score(&mut self, text: &str) -> Option<u32> {
        self.pattern.score(Utf32Str::new(text, &mut self.buffer), &mut self.matcher)
    }

    /// UTF-16 positions of the match.
    fn positions(&mut self, text: &str) -> Vec<u32> {
        let mut chars = Vec::new();
        self.pattern.indices(Utf32Str::new(text, &mut self.buffer), &mut self.matcher, &mut chars);
        chars.sort_unstable();
        chars.dedup();
        if text.is_ascii() {
            return chars;
        }
        // The matcher counts graphemes; positions past an uncommon cluster
        // may drift, which only shifts a highlight.
        let mut units = 0;
        let offsets: Vec<u32> = text
            .chars()
            .map(|c| {
                let at = units;
                units += c.len_utf16() as u32;
                at
            })
            .collect();
        chars.into_iter().filter_map(|c| offsets.get(c as usize).copied()).collect()
    }
}

/// Where a file matched best.
struct Best {
    score: u32,
    alias: Option<usize>,
    in_path: bool,
}

impl Index {
    pub fn find_files(&self, query: &str, scope: FindScope, limit: usize) -> Vec<FileHit> {
        let query = query.trim();
        let candidates: Vec<&str> = self
            .entries()
            .filter(|e| !e.folder && (scope == FindScope::Files || path::is_note(&e.path)))
            .map(|e| e.path.as_str())
            .collect();

        if query.is_empty() {
            return Vec::new();
        }
        let path_only = query.contains('/');
        let mut hits: Vec<(Best, &str)> = candidates
            .into_par_iter()
            .map_init(
                || Fuzzy::new(query),
                |fuzzy, p| {
                    let mut best: Option<Best> = None;
                    let mut consider = |score: Option<u32>, alias, in_path| {
                        if let Some(score) = score
                            && best.as_ref().is_none_or(|b| score > b.score)
                        {
                            best = Some(Best { score, alias, in_path });
                        }
                    };
                    if !path_only {
                        consider(fuzzy.score(path::link_name(p)).map(|s| s + NAME_BONUS), None, false);
                        for (i, name) in self.other_names(p).enumerate() {
                            consider(fuzzy.score(name).map(|s| s + ALIAS_BONUS), Some(i), false);
                        }
                    }
                    consider(fuzzy.score(path::strip_note_extension(p).unwrap_or(p)), None, true);
                    best.map(|b| (b, p))
                },
            )
            .flatten()
            .collect();

        // Best first; among equals the shortest, then by path, so the order is stable.
        hits.sort_by(|(a, p), (b, q)| b.score.cmp(&a.score).then(p.len().cmp(&q.len())).then(p.cmp(q)));
        hits.truncate(limit);

        let mut fuzzy = Fuzzy::new(query);
        hits.into_iter()
            .map(|(best, p)| {
                let alias = best.alias.and_then(|i| self.other_names(p).nth(i)).map(str::to_owned);
                let matched = match &alias {
                    Some(alias) => alias.as_str(),
                    None if best.in_path => path::strip_note_extension(p).unwrap_or(p),
                    None => path::link_name(p),
                };
                let positions = fuzzy.positions(matched);
                FileHit { path: p.to_owned(), in_path: best.in_path, positions, score: best.score, alias }
            })
            .collect()
    }

    /// Aliases, and the title when it differs from the file's name.
    fn other_names<'a>(&'a self, p: &'a str) -> impl Iterator<Item = &'a str> {
        let meta = self.note(p);
        let aliases = meta.into_iter().flat_map(|m| m.aliases.iter().map(String::as_str));
        let title = meta.and_then(|m| m.title.as_deref()).filter(move |t| *t != path::link_name(p));
        aliases.chain(title)
    }

    pub fn find_headings(&self, query: &str, limit: usize) -> Vec<HeadingHit> {
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        let notes: Vec<_> = self.notes().collect();
        let mut hits: Vec<(u32, &str, usize)> = notes
            .into_par_iter()
            .map_init(
                || Fuzzy::new(query),
                |fuzzy, (p, meta)| {
                    let scored = meta.headings.iter().enumerate().filter_map(|(i, h)| Some((fuzzy.score(&h.text)?, p, i)));
                    scored.collect::<Vec<_>>()
                },
            )
            .flatten_iter()
            .collect();
        let length = |p: &str, i: usize| self.note(p).map_or(0, |meta| meta.headings[i].text.len());
        hits.sort_by(|a, b| {
            b.0.cmp(&a.0).then_with(|| length(a.1, a.2).cmp(&length(b.1, b.2))).then(a.1.cmp(b.1)).then(a.2.cmp(&b.2))
        });
        hits.truncate(limit);

        let mut fuzzy = Fuzzy::new(query);
        hits.into_iter()
            .filter_map(|(score, p, i)| {
                let heading = &self.note(p)?.headings[i];
                let positions = fuzzy.positions(&heading.text);
                let (text, level, line) = (heading.text.clone(), heading.level, heading.line);
                Some(HeadingHit { path: p.to_owned(), text, level, line, positions, score })
            })
            .collect()
    }

    /// What `[[query` may mean from a note: files by name or alias, then
    /// names other notes link to that do not exist yet.
    pub fn suggest_links(&self, source: &str, query: &str, limit: usize) -> Vec<LinkSuggestion> {
        let query = query.trim();
        if query.is_empty() {
            // Most recently changed first: what one is likely to link now.
            let mut recent: Vec<_> = self.entries().filter(|e| path::is_note(&e.path) && e.path != source).collect();
            recent.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.path.cmp(&b.path)));
            return recent
                .into_iter()
                .take(limit)
                .map(|e| LinkSuggestion { path: Some(e.path.clone()), insert: self.link_text(source, &e.path), alias: None })
                .collect();
        }

        let mut found: Vec<LinkSuggestion> = self
            .find_files(query, FindScope::Files, limit)
            .into_iter()
            .map(|hit| LinkSuggestion { insert: self.link_text(source, &hit.path), path: Some(hit.path), alias: hit.alias })
            .collect();

        if found.len() < limit {
            let mut fuzzy = Fuzzy::new(query);
            let mut missing: Vec<(u32, String)> = Vec::new();
            for (key, sources) in &self.incoming {
                if self.names.contains_key(key) {
                    continue;
                }
                // As written by someone, not its key.
                let written = sources.iter().find_map(|s| {
                    self.note(s)?.links.iter().map(|l| path::link_name(&l.target)).find(|name| path::key(name) == *key)
                });
                if let Some(name) = written
                    && let Some(score) = fuzzy.score(name)
                {
                    missing.push((score, name.to_owned()));
                }
            }
            missing.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            let room = limit - found.len();
            found.extend(missing.into_iter().take(room).map(|(_, insert)| LinkSuggestion { path: None, insert, alias: None }));
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::index;

    fn paths(hits: Vec<FileHit>) -> Vec<String> {
        hits.into_iter().map(|h| h.path).collect()
    }

    #[test]
    fn names_rank_above_paths() {
        let i = index(&[("plan/misc/zed.md", ""), ("other/Plan.md", ""), ("other/Planning notes.md", ""), ("x.md", "")]);
        let hits = i.find_files("plan", FindScope::Notes, 10);
        assert_eq!(hits[0].path, "other/Plan.md");
        assert_eq!(hits[0].positions, [0, 1, 2, 3]);
        assert_eq!(paths(hits), ["other/Plan.md", "other/Planning notes.md", "plan/misc/zed.md"]);
    }

    #[test]
    fn slashes_search_the_path() {
        let i = index(&[("work/Plan.md", ""), ("home/Plan.md", "")]);
        let hits = i.find_files("wor/pla", FindScope::Notes, 10);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].in_path);
    }

    #[test]
    fn accents_and_case_do_not_matter() {
        let i = index(&[("Canción de otoño.md", ""), ("📚 Ñandú.md", "")]);
        assert_eq!(paths(i.find_files("cancion otono", FindScope::Notes, 10)), ["Canción de otoño.md"]);
        assert_eq!(paths(i.find_files("nandu", FindScope::Notes, 10)), ["📚 Ñandú.md"]);
        assert_eq!(i.find_files("ñandú", FindScope::Notes, 10)[0].positions, [3, 4, 5, 6, 7]);
    }

    #[test]
    fn finds_by_alias_and_title() {
        let i = index(&[("202611.md", "---\naliases: [Weekly review]\n---\n# Something else")]);
        assert_eq!(i.find_files("weekly", FindScope::Notes, 10)[0].alias.as_deref(), Some("Weekly review"));
        assert_eq!(i.find_files("something", FindScope::Notes, 10)[0].alias.as_deref(), Some("Something else"));
    }

    #[test]
    fn notes_scope_leaves_attachments_out() {
        let i = index(&[("plan.png", ""), ("plan.md", "")]);
        assert_eq!(paths(i.find_files("plan", FindScope::Notes, 10)), ["plan.md"]);
        assert_eq!(i.find_files("plan", FindScope::Files, 10).len(), 2);
        assert!(i.find_files(" ", FindScope::Files, 10).is_empty());
    }

    #[test]
    fn finds_headings() {
        let i = index(&[("a.md", "# Intro\n## Setup guide"), ("b.md", "# Set")]);
        let hits = i.find_headings("set", 10);
        assert_eq!((hits[0].path.as_str(), hits[0].text.as_str()), ("b.md", "Set"));
        assert_eq!((hits[1].text.as_str(), hits[1].line), ("Setup guide", 1));
    }

    #[test]
    fn suggests_links_including_unwritten_notes() {
        let i = index(&[("a/Note.md", "[[Nothing yet]]"), ("b/Note.md", "")]);
        let found = i.suggest_links("x.md", "not", 10);
        let inserts: Vec<&str> = found.iter().map(|s| s.insert.as_str()).collect();
        assert_eq!(inserts, ["a/Note", "b/Note", "Nothing yet"]);
        assert_eq!(found[2].path, None);
        assert_eq!(i.suggest_links("a/Note.md", "", 10).len(), 1, "not itself");
    }
}
