//! Links as written in a note, and the text to write for one.

use std::ops::Range;

use serde::Serialize;

use crate::text::utf16_len;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkKind {
    /// `[[Note]]`
    Wiki,
    /// `![[Note]]`
    Embed,
    /// `[text](note.md)`
    Markdown,
    /// `![alt](image.png)`
    Image,
    /// `[[Note]]` inside the frontmatter.
    Property,
}

impl LinkKind {
    /// Whether the target is a path relative to the note, as in standard
    /// Markdown, instead of a name looked up across the vault.
    pub fn is_relative(self) -> bool {
        matches!(self, Self::Markdown | Self::Image)
    }
}

/// A link to somewhere in the vault. Web links are not kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub kind: LinkKind,
    /// The file part, decoded: `Note`, `folder/Note`, `../img/a b.png`.
    /// Empty when the link points inside its own note (`[[#Heading]]`).
    pub target: String,
    /// `Heading`, `Heading#Sub` or `^block`, without the leading `#`.
    pub subpath: Option<String>,
    /// The text shown instead of the target, when the link sets one.
    pub display: Option<String>,
    /// For a property link, the property it is the value of: `author` in
    /// `author: "[[Ana]]"`, and the top-level key for one nested deeper.
    pub relation: Option<String>,
    pub line: u32,
    pub col: u32,
    /// UTF-16 length up to the end of the link or of its first line.
    pub len: u32,
    /// Bytes of the destination as written, for rewriting it. `None` for
    /// reference-style links, whose destination is elsewhere.
    #[serde(skip)]
    pub dest: Option<Range<usize>>,
}

/// Splits `Note#Heading` into the file and the place inside it.
pub fn split_target(raw: &str) -> (&str, Option<&str>) {
    match raw.split_once('#') {
        Some((target, subpath)) => (target.trim(), Some(subpath.trim()).filter(|s| !s.is_empty())),
        None => (raw.trim(), None),
    }
}

/// The inside of `[[…]]`: destination (as written), and what follows the
/// pipe. Tables need the pipe escaped, so a backslash before it is not part
/// of the destination.
pub fn split_wiki(inner: &str) -> (&str, Option<&str>) {
    match inner.split_once('|') {
        Some((dest, display)) => (dest.strip_suffix('\\').unwrap_or(dest), Some(display.trim())),
        None => (inner, None),
    }
}

/// `https:`, `mailto:`, `obsidian:`… anything with a scheme leads outside.
pub fn is_external(dest: &str) -> bool {
    dest.starts_with("//")
        || dest.split_once(':').is_some_and(|(scheme, _)| {
            scheme.len() > 1
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
}

/// Decodes `%20` and friends. Anything that is not valid UTF-8 once decoded
/// stays as written.
pub fn percent_decode(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
        if bytes[i] == b'%'
            && let (Some(Some(hi)), Some(Some(lo))) = (bytes.get(i + 1).map(|&b| hex(b)), bytes.get(i + 2).map(|&b| hex(b)))
        {
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

/// Encodes what a Markdown destination cannot hold bare: spaces, parentheses
/// and the characters that would end or split it.
pub fn percent_encode(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        if c.is_ascii_control() || matches!(c, ' ' | '(' | ')' | '<' | '>' | '%' | '#' | '?' | '"' | '\\') {
            out.push_str(&format!("%{:02X}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

/// The byte range of the destination inside `[text](dest "title")`, given
/// the whole link.
pub(crate) fn inline_dest(link: &str) -> Option<Range<usize>> {
    let open = link.rfind("](")? + 2;
    let inner = link[open..].strip_suffix(')')?;
    let lead = inner.len() - inner.trim_start().len();
    let start = open + lead;
    let inner = inner.trim_start();
    if let Some(bracketed) = inner.strip_prefix('<') {
        return Some(start + 1..start + 1 + bracketed.find('>')?);
    }
    let len = inner.find(char::is_whitespace).unwrap_or(inner.len());
    (len > 0).then(|| start..start + len)
}

/// Applies replacements to a text. They may come in any order but must not
/// overlap.
pub fn replace_ranges(text: &str, mut edits: Vec<(Range<usize>, String)>) -> String {
    edits.sort_by_key(|(range, _)| range.start);
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    for (range, replacement) in edits {
        out.push_str(&text[from..range.start]);
        out.push_str(&replacement);
        from = range.end;
    }
    out.push_str(&text[from..]);
    out
}

pub(crate) fn first_line_len(link: &str) -> u32 {
    utf16_len(link.lines().next().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_split_at_the_first_hash() {
        assert_eq!(split_target("Note"), ("Note", None));
        assert_eq!(split_target("Note#Head#Sub"), ("Note", Some("Head#Sub")));
        assert_eq!(split_target("#^b1"), ("", Some("^b1")));
        assert_eq!(split_target("Note#"), ("Note", None));
    }

    #[test]
    fn wiki_pipes_may_be_escaped() {
        assert_eq!(split_wiki("A|b"), ("A", Some("b")));
        assert_eq!(split_wiki("A\\|b"), ("A", Some("b")));
        assert_eq!(split_wiki("A"), ("A", None));
    }

    #[test]
    fn schemes_are_external_but_windows_drives_and_titles_are_not() {
        for yes in ["https://x.y", "mailto:a@b", "obsidian://open", "//cdn/x"] {
            assert!(is_external(yes), "{yes}");
        }
        for no in ["note.md", "a/b.md", "Meeting 10:30.md", "C:x", "./a:b.md"] {
            assert!(!is_external(no), "{no}");
        }
    }

    #[test]
    fn destinations_encode_and_decode() {
        assert_eq!(percent_decode("a%20b%C3%B1.md"), "a bñ.md");
        assert_eq!(percent_decode("100%.md"), "100%.md");
        assert_eq!(percent_decode("%FF"), "%FF");
        for path in ["a b (1).md", "50% off?.md", "ñandú.md"] {
            assert_eq!(percent_decode(&percent_encode(path)), path);
        }
    }

    #[test]
    fn finds_inline_destinations() {
        let dest = |s: &str| inline_dest(s).map(|r| s[r].to_owned());
        assert_eq!(dest("[a](b.md)").as_deref(), Some("b.md"));
        assert_eq!(dest("[a]( b.md \"t\")").as_deref(), Some("b.md"));
        assert_eq!(dest("![a](<b c.png>)").as_deref(), Some("b c.png"));
        assert_eq!(dest("[![i](x.png)](y.md)").as_deref(), Some("y.md"));
        assert_eq!(dest("[a](b(1).md)").as_deref(), Some("b(1).md"));
        assert_eq!(dest("[a]()"), None);
        assert_eq!(dest("[a][ref]"), None);
    }

    #[test]
    fn replaces_in_any_order() {
        let edits = vec![(6..7, "XX".to_owned()), (0..1, String::new())];
        assert_eq!(replace_ranges("abcdefg", edits), "bcdefXX");
    }
}
