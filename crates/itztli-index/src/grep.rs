//! Find in Files: searching the text of every note.

use std::sync::atomic::{AtomicUsize, Ordering};

use itztli_core::{Lines, path};
use rayon::prelude::*;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextQuery {
    pub text: String,
    pub match_case: bool,
    pub whole_words: bool,
    pub regex: bool,
    /// Only in this folder.
    pub folder: String,
    /// Stop after this many matches.
    pub limit: usize,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct QueryError(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMatch {
    pub line: u32,
    pub col: u32,
    /// UTF-16 length, up to the end of the line for matches that span several.
    pub len: u32,
    /// The line, cut around the match when it is long.
    pub preview: String,
    /// Where the match starts in the preview, in UTF-16 units.
    pub preview_col: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<TextMatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextResults {
    pub files: Vec<FileMatches>,
    pub total: usize,
    /// Whether the search stopped at its limit.
    pub truncated: bool,
}

/// Longest preview, in characters, and how much of it goes before the match.
const PREVIEW: usize = 240;
const PREVIEW_LEAD: usize = 60;
/// Files bigger than this are data, not notes.
const MAX_FILE: usize = 8 * 1024 * 1024;

/// Searches `files` (vault paths) in parallel. Files that name the query
/// come first; the rest keep their order.
pub fn grep(
    files: &[String],
    read: impl Fn(&str) -> Option<Vec<u8>> + Sync,
    query: &TextQuery,
    cancelled: impl Fn() -> bool + Sync,
) -> Result<TextResults, QueryError> {
    if query.text.is_empty() {
        return Ok(TextResults::default());
    }
    let pattern = compile(query)?;
    let limit = if query.limit == 0 { usize::MAX } else { query.limit };
    let count = AtomicUsize::new(0);

    let mut found: Vec<FileMatches> = files
        .par_iter()
        .filter(|p| path::is_within(p, &query.folder))
        .filter_map(|p| {
            if cancelled() || count.load(Ordering::Relaxed) >= limit {
                return None;
            }
            let bytes = read(p).filter(|b| b.len() <= MAX_FILE)?;
            let text = std::str::from_utf8(&bytes).ok()?;
            let matches = matches_in(text, &pattern, limit);
            if matches.is_empty() {
                return None;
            }
            count.fetch_add(matches.len(), Ordering::Relaxed);
            Some(FileMatches { path: p.clone(), matches })
        })
        .collect();

    found.sort_by_key(|f| !pattern.is_match(path::link_name(&f.path)));
    let mut left = limit;
    let mut truncated = count.load(Ordering::Relaxed) >= limit;
    found.retain_mut(|f| {
        if f.matches.len() > left {
            f.matches.truncate(left);
            truncated = true;
        }
        left -= f.matches.len();
        !f.matches.is_empty()
    });
    Ok(TextResults { total: found.iter().map(|f| f.matches.len()).sum(), files: found, truncated })
}

fn compile(query: &TextQuery) -> Result<Regex, QueryError> {
    let mut source = match (query.regex, query.match_case) {
        (true, _) => query.text.clone(),
        (false, true) => regex::escape(&query.text),
        (false, false) => ignoring_accents(&query.text),
    };
    if query.whole_words {
        source = format!(r"\b(?:{source})\b");
    }
    RegexBuilder::new(&source)
        .case_insensitive(!query.match_case)
        .multi_line(true)
        // A pattern that needs more than this would not be fast either.
        .size_limit(4 * 1024 * 1024)
        .build()
        .map_err(|e| QueryError(e.to_string().lines().last().unwrap_or_default().trim_start_matches("error: ").to_owned()))
}

/// A pattern for the text where `cancion` finds `canción`, in either Unicode
/// form. An accent in the query has to match.
fn ignoring_accents(text: &str) -> String {
    const VARIANTS: [(char, &str); 8] = [
        ('a', "aàáâãäåāăą"),
        ('c', "cçćč"),
        ('e', "eèéêëēėę"),
        ('i', "iìíîïīį"),
        ('n', "nñńň"),
        ('o', "oòóôõöøō"),
        ('u', "uùúûüūů"),
        ('y', "yýÿ"),
    ];
    let mut out = String::new();
    for c in text.chars() {
        match VARIANTS.iter().find(|(base, _)| *base == c.to_ascii_lowercase()) {
            Some((_, variants)) => out.push_str(&format!(r"[{variants}][\u{{300}}-\u{{36f}}]*")),
            None => out.push_str(&regex::escape(c.encode_utf8(&mut [0; 4]))),
        }
    }
    out
}

fn matches_in(text: &str, pattern: &Regex, limit: usize) -> Vec<TextMatch> {
    let mut found = pattern.find_iter(text).filter(|m| !m.is_empty()).peekable();
    if found.peek().is_none() {
        return Vec::new();
    }
    let lines = Lines::new(text);
    found
        .take(limit)
        .map(|m| {
            let (line, col) = lines.position(m.start());
            let full = lines.line(line).unwrap_or("");
            let start = m.start() - (lines.end_of_line(m.start()) - full.len());
            let end = (start + m.len()).min(full.len());
            let (preview, lead) = cut(full, start);
            TextMatch {
                line,
                col,
                len: utf16(&full[start.min(full.len())..end.max(start.min(full.len()))]),
                preview_col: utf16(&full[lead..start.min(full.len())]),
                preview,
            }
        })
        .collect()
}

/// The part of a line around byte `at`, and the byte it starts at.
fn cut(line: &str, at: usize) -> (String, usize) {
    let indent = line.len() - line.trim_start().len();
    let from = if line[..at.min(line.len())].chars().count() > PREVIEW_LEAD * 2 {
        line[..at].char_indices().rev().nth(PREVIEW_LEAD).map_or(indent, |(i, _)| i)
    } else {
        indent.min(at)
    };
    (line[from..].chars().take(PREVIEW).collect(), from)
}

fn utf16(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: [(&str, &str); 4] = [
        ("a.md", "Una canción\ny otra CANCIO\u{301}N más\n"),
        ("cancion.md", "nada: cancion"),
        ("sub/b.md", "  indented word, wording\nprecio: $5 (a+b)"),
        ("sub/c.md", "😀 emoji word"),
    ];

    fn search(query: TextQuery) -> TextResults {
        let files: Vec<String> = FILES.iter().map(|(p, _)| p.to_string()).collect();
        let read = |p: &str| FILES.iter().find(|(f, _)| *f == p).map(|(_, t)| t.as_bytes().to_vec());
        grep(&files, read, &query, || false).unwrap()
    }

    fn text(text: &str) -> TextQuery {
        TextQuery { text: text.into(), ..Default::default() }
    }

    fn summary(results: &TextResults) -> Vec<(&str, usize)> {
        results.files.iter().map(|f| (f.path.as_str(), f.matches.len())).collect()
    }

    #[test]
    fn ignores_case_and_accents_unless_asked() {
        assert_eq!(summary(&search(text("cancion"))), [("cancion.md", 1), ("a.md", 2)], "files naming the query first");
        assert_eq!(summary(&search(text("canción"))), [("a.md", 1)], "an accent has to match");
        assert_eq!(summary(&search(TextQuery { match_case: true, ..text("cancion") })), [("cancion.md", 1)]);
    }

    #[test]
    fn text_is_literal_unless_regex() {
        assert_eq!(summary(&search(text("$5 (a+b)"))), [("sub/b.md", 1)]);
        assert_eq!(summary(&search(TextQuery { regex: true, ..text(r"w\w+g\b") })), [("sub/b.md", 1)]);
        let bad = TextQuery { regex: true, ..text("(") };
        assert!(grep(&[], |_| None, &bad, || false).unwrap_err().to_string().contains("unclosed group"));
    }

    #[test]
    fn whole_words_folders_and_limits() {
        assert_eq!(summary(&search(text("word"))), [("sub/b.md", 2), ("sub/c.md", 1)]);
        assert_eq!(summary(&search(TextQuery { whole_words: true, ..text("word") })), [("sub/b.md", 1), ("sub/c.md", 1)]);
        assert_eq!(search(TextQuery { folder: "other".into(), ..text("word") }).total, 0);
        let limited = search(TextQuery { limit: 2, ..text("word") });
        assert!(limited.truncated && limited.total == 2);
        assert!(!search(text("word")).truncated);
        assert_eq!(search(text("")).total, 0);
    }

    #[test]
    fn positions_and_previews() {
        let results = search(TextQuery { whole_words: true, ..text("word") });
        let b = &results.files[0].matches[0];
        assert_eq!((b.line, b.col, b.len), (0, 11, 4));
        assert_eq!((b.preview.as_str(), b.preview_col), ("indented word, wording", 9));
        let c = &results.files[1].matches[0];
        assert_eq!((c.col, c.preview_col), (9, 9));
    }

    #[test]
    fn long_lines_are_cut_around_the_match() {
        let line = format!("{}needle{}", "x ".repeat(500), " y".repeat(500));
        let found = matches_in(&line, &Regex::new("needle").unwrap(), 10);
        assert!(found[0].preview.chars().count() <= PREVIEW);
        let at = found[0].preview_col as usize;
        assert_eq!(&found[0].preview[at..at + 6], "needle");
    }

    #[test]
    fn matches_across_lines_end_at_the_first() {
        let found = matches_in("one\ntwo", &Regex::new(r"ne\s+tw").unwrap(), 10);
        assert_eq!((found[0].line, found[0].col, found[0].len), (0, 1, 2));
    }
}
