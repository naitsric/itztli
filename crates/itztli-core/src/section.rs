//! The part of a note a link points at: a heading's section or a block.

use crate::note::{self, NoteMeta};
use crate::path;
use crate::text::Lines;

/// How heading references compare: links cannot hold `#`, `^`, `|` or
/// brackets, so a heading containing them is matched without them.
fn heading_key(text: &str) -> String {
    let clean: String =
        text.chars().map(|c| if matches!(c, '#' | '^' | '|' | '[' | ']' | '\\' | ':') { ' ' } else { c }).collect();
    path::key(&clean.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Index of the heading `Heading` or `Heading#Sub` names.
pub fn find_heading(meta: &NoteMeta, subpath: &str) -> Option<usize> {
    let mut from = 0;
    let mut found = None;
    for part in subpath.split('#').filter(|p| !p.trim().is_empty()) {
        let wanted = heading_key(part);
        let at = from + meta.headings[from..].iter().position(|h| heading_key(&h.text) == wanted)?;
        found = Some(at);
        from = at + 1;
    }
    found
}

/// The line a subpath points at.
pub fn line_of(meta: &NoteMeta, subpath: &str) -> Option<u32> {
    match subpath.strip_prefix('^') {
        Some(id) => meta.blocks.iter().find(|b| b.id.eq_ignore_ascii_case(id)).map(|b| b.line),
        None => find_heading(meta, subpath).map(|at| meta.headings[at].line),
    }
}

/// The text a subpath points at: a heading with everything under it, or the
/// lines of a block. `None` when the note has no such place.
pub fn extract<'a>(text: &'a str, subpath: &str) -> Option<&'a str> {
    let meta = note::parse(text);
    let Some(id) = subpath.strip_prefix('^') else {
        let at = find_heading(&meta, subpath)?;
        let heading = &meta.headings[at];
        let end = meta.headings[at + 1..].iter().find(|h| h.level <= heading.level).map_or(text.len(), |h| h.start);
        return Some(text[heading.start..end].trim_end());
    };

    let block = meta.blocks.iter().find(|b| b.id.eq_ignore_ascii_case(id))?;
    let lines = Lines::new(text);
    let blank = |line: u32| lines.line(line).is_none_or(|l| l.trim().is_empty());
    let starts_item = |line: u32| lines.line(line).is_some_and(|l| is_list_item(l.trim_start()));
    // An id alone on its line names the block before it.
    let mut last = block.line;
    if lines.line(last).is_some_and(|l| l.trim_start().starts_with('^')) {
        while last > 0 && blank(last - 1) {
            last -= 1;
        }
        last = last.checked_sub(1)?;
    }
    let mut first = last;
    while first > 0 && !blank(first - 1) && !starts_item(first) {
        first -= 1;
    }
    let offset = |line: u32| text.len() - remaining_from(text, line).len();
    let start = offset(first);
    Some(text[start..lines.end_of_line(offset(last))].trim_end_matches(|c: char| c.is_whitespace()))
}

fn is_list_item(line: &str) -> bool {
    let after_number = line.trim_start_matches(|c: char| c.is_ascii_digit());
    ["- ", "* ", "+ "].iter().any(|m| line.starts_with(m))
        || (after_number.len() < line.len() && (after_number.starts_with(". ") || after_number.starts_with(") ")))
}

fn remaining_from(text: &str, line: u32) -> &str {
    let mut rest = text;
    for _ in 0..line {
        rest = rest.find('\n').map_or("", |at| &rest[at + 1..]);
    }
    rest
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "# A\n\nintro\n\n## B: one [x]\n\ntext\n\n### C\n\ndeep\n\n## D\n\npara\nstill ^p\n\n- one\n- two ^li\n- three\n\n> quoted\n\n^q\n";

    #[test]
    fn headings_take_everything_under_them() {
        assert_eq!(extract(NOTE, "B one x"), Some("## B: one [x]\n\ntext\n\n### C\n\ndeep"));
        assert_eq!(extract(NOTE, "b: one#c"), None);
        assert_eq!(extract(NOTE, "B one x#c"), Some("### C\n\ndeep"));
        assert!(extract(NOTE, "a").unwrap().ends_with("^q"));
        assert_eq!(extract(NOTE, "nope"), None);
    }

    #[test]
    fn blocks_are_paragraphs_or_single_items() {
        assert_eq!(extract(NOTE, "^p"), Some("para\nstill ^p"));
        assert_eq!(extract(NOTE, "^li"), Some("- two ^li"));
        assert_eq!(extract(NOTE, "^q"), Some("> quoted"));
        assert_eq!(extract(NOTE, "^nope"), None);
    }

    #[test]
    fn lines_of_subpaths() {
        let meta = note::parse(NOTE);
        assert_eq!(line_of(&meta, "D"), Some(12));
        assert_eq!(line_of(&meta, "^P"), Some(15));
        assert_eq!(line_of(&meta, "zzz"), None);
    }
}
