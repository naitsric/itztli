//! What a note's text says: frontmatter, headings, links, tags and tasks.

use std::ops::Range;

use pulldown_cmark::{CowStr, Event, LinkType, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::link::{self, Link, LinkKind};
use crate::text::Lines;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    /// `title` in the frontmatter, else the first level-1 heading.
    pub title: Option<String>,
    /// `None` when there is no frontmatter or it is not a valid YAML mapping.
    pub frontmatter: Option<Map<String, Value>>,
    /// Whether the note opens a frontmatter block that does not parse.
    pub invalid_frontmatter: bool,
    pub aliases: Vec<String>,
    pub tags: Vec<TagRef>,
    pub headings: Vec<Heading>,
    pub links: Vec<Link>,
    pub tasks: Vec<Task>,
    /// Ids of the blocks other notes can link to (`text ^id`).
    pub blocks: Vec<BlockId>,
    pub words: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: u32,
    #[serde(skip)]
    pub start: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    /// Without the `#`.
    pub name: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub done: bool,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockId {
    pub id: String,
    pub line: u32,
}

pub(crate) fn markdown_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_WIKILINKS
}

/// The YAML between the opening and closing `---`, and where the body starts.
/// Only at the very top of the note, as everywhere else `---` is a rule.
pub fn split_frontmatter(text: &str) -> (Option<Range<usize>>, usize) {
    let Some(start) = ["---\n", "---\r\n"].iter().find(|open| text.starts_with(**open)).map(|open| open.len()) else {
        return (None, 0);
    };
    let mut at = start;
    for line in text[start..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            return (Some(start..at), at + line.len());
        }
        at += line.len();
    }
    (None, 0)
}

pub fn parse(text: &str) -> NoteMeta {
    let lines = Lines::new(text);
    let mut meta = NoteMeta::default();

    let (front, body) = split_frontmatter(text);
    if let Some(range) = front {
        read_frontmatter(text, range, &lines, &mut meta);
    }
    read_body(text, body, &lines, &mut meta);
    if meta.title.is_none() {
        meta.title = meta.headings.iter().find(|h| h.level == 1).map(|h| h.text.clone());
    }
    meta
}

fn read_frontmatter(text: &str, range: Range<usize>, lines: &Lines, meta: &mut NoteMeta) {
    let yaml = &text[range.clone()];
    match serde_saphyr::from_str::<Value>(yaml) {
        Ok(Value::Object(map)) => {
            meta.title = map.get("title").and_then(scalar).filter(|t| !t.is_empty());
            for key in ["aliases", "alias"] {
                meta.aliases.extend(map.get(key).map(|v| list(v, ',')).unwrap_or_default());
            }
            let line = lines.position(range.start).0;
            for key in ["tags", "tag"] {
                let names = map.get(key).map(|v| list(v, ' ')).unwrap_or_default();
                let at = yaml.lines().position(|l| l.split(':').next().is_some_and(|k| k.trim() == key)).unwrap_or(0);
                meta.tags.extend(names.into_iter().filter_map(|name| {
                    let name = name.trim_start_matches('#').trim_end_matches('/').to_owned();
                    is_tag(&name).then_some(TagRef { name, line: line + at as u32, col: 0 })
                }));
            }
            meta.frontmatter = Some(map);
        }
        // Empty frontmatter is fine; it just says nothing.
        Ok(Value::Null) => {}
        _ => meta.invalid_frontmatter = !yaml.trim().is_empty(),
    }

    let mut from = range.start;
    while let Some(open) = text[from..range.end].find("[[").map(|at| from + at) {
        let inner = open + 2;
        let end_of_line = lines.end_of_line(inner).min(range.end);
        let Some(close) = text[inner..end_of_line].find("]]").map(|at| inner + at) else {
            from = inner;
            continue;
        };
        meta.links.extend(wiki_link(text, open..close + 2, inner..close, LinkKind::Property, lines));
        from = close + 2;
    }
}

/// A YAML scalar as text. Numbers and dates count: `title: 2026` is a title.
fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A YAML list of scalars, or one string listing several.
fn list(value: &Value, separator: char) -> Vec<String> {
    let items: Vec<String> = match value {
        Value::Array(items) => items.iter().filter_map(scalar).collect(),
        Value::String(s) => s.split([',', separator]).map(|s| s.trim().to_owned()).collect(),
        other => scalar(other).into_iter().collect(),
    };
    items.into_iter().filter(|s| !s.is_empty()).collect()
}

/// Letters, digits, `_`, `-`, `/` and emoji, with something other than digits.
fn is_tag(name: &str) -> bool {
    !name.is_empty() && name.chars().all(is_tag_char) && name.chars().any(|c| !c.is_numeric() && c != '/')
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric()
        || matches!(c, '_' | '-' | '/' | '\u{200d}' | '\u{fe0f}')
        // Emoji and other symbols beyond the punctuation blocks.
        || (c as u32 >= 0x2190 && !c.is_whitespace() && !('\u{2e00}'..='\u{303f}').contains(&c) && !('\u{ff00}'..='\u{ff0f}').contains(&c))
}

fn read_body(text: &str, body: usize, lines: &Lines, meta: &mut NoteMeta) {
    /// A heading or a task being read: what it says so far.
    enum Collecting {
        Heading(u8, usize),
        Task(bool, usize),
    }
    let mut collecting: Option<(Collecting, String)> = None;
    let mut in_code = false;
    let mut in_link = 0usize;
    // Contiguous text: the parser splits it at every character that could
    // have started some markup.
    let mut run: Option<Range<usize>> = None;

    let finish_task = |collecting: &mut Option<(Collecting, String)>, meta: &mut NoteMeta| {
        if let Some((Collecting::Task(done, at), said)) = collecting.take_if(|c| matches!(c.0, Collecting::Task(..))) {
            meta.tasks.push(Task { done, text: said.trim().to_owned(), line: lines.position(at).0 });
        }
    };

    for (event, range) in Parser::new_ext(&text[body..], markdown_options()).into_offset_iter() {
        let range = range.start + body..range.end + body;

        if let Event::Text(said) = &event
            && !in_code
        {
            if let Some((_, buffer)) = &mut collecting {
                buffer.push_str(said);
            }
            if in_link == 0 {
                match &mut run {
                    Some(current) if current.end == range.start => current.end = range.end,
                    _ => {
                        if let Some(done) = run.replace(range) {
                            read_text(text, done, lines, meta);
                        }
                    }
                }
                continue;
            }
        }
        if let Some(done) = run.take() {
            read_text(text, done, lines, meta);
        }

        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code = true,
            Event::End(TagEnd::CodeBlock) => in_code = false,
            Event::Start(Tag::Heading { level, .. }) => {
                collecting = Some((Collecting::Heading(level as u8, range.start), String::new()));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((Collecting::Heading(level, start), said)) = collecting.take() {
                    let heading = strip_block_id(said.trim()).to_owned();
                    meta.headings.push(Heading { level, text: heading, line: lines.position(start).0, start });
                }
            }
            Event::TaskListMarker(done) => {
                finish_task(&mut collecting, meta);
                collecting = Some((Collecting::Task(done, range.start), String::new()));
            }
            // A task says what is on its first line; nested items are their own.
            Event::SoftBreak | Event::HardBreak | Event::Start(Tag::List(_)) | Event::End(TagEnd::Item) => {
                finish_task(&mut collecting, meta);
            }
            Event::Code(said) => {
                if let Some((_, buffer)) = &mut collecting {
                    buffer.push_str(&said);
                }
            }
            Event::Start(Tag::Link { link_type, dest_url, .. }) => {
                in_link += 1;
                meta.links.extend(read_link(text, range, link_type, &dest_url, false, lines));
            }
            Event::Start(Tag::Image { link_type, dest_url, .. }) => {
                in_link += 1;
                meta.links.extend(read_link(text, range, link_type, &dest_url, true, lines));
            }
            Event::End(TagEnd::Link | TagEnd::Image) => in_link = in_link.saturating_sub(1),
            _ => {}
        }
    }
    if let Some(done) = run {
        read_text(text, done, lines, meta);
    }
}

fn read_link(text: &str, range: Range<usize>, link_type: LinkType, url: &CowStr, image: bool, lines: &Lines) -> Option<Link> {
    let source = &text[range.clone()];
    if let LinkType::WikiLink { .. } = link_type {
        let inner = range.start + if image { 3 } else { 2 }..range.end - 2;
        let kind = if image { LinkKind::Embed } else { LinkKind::Wiki };
        return wiki_link(text, range, inner, kind, lines);
    }
    // Autolinks (`<https://…>`) only ever lead outside.
    if matches!(link_type, LinkType::Autolink | LinkType::Email) || link::is_external(url) {
        return None;
    }
    let dest = match link_type {
        LinkType::Inline => link::inline_dest(source).map(|r| range.start + r.start..range.start + r.end),
        _ => None,
    };
    let (target, subpath) = link::split_target(url);
    if target.is_empty() && subpath.is_none() {
        return None;
    }
    let display = source.strip_prefix(if image { "![" } else { "[" }).and_then(|rest| {
        let close = if image || dest.is_some() { rest.rfind("](") } else { rest.find(']') }?;
        Some(rest[..close].to_owned()).filter(|d| !d.is_empty())
    });
    let (line, col) = lines.position(range.start);
    Some(Link {
        kind: if image { LinkKind::Image } else { LinkKind::Markdown },
        target: link::percent_decode(target),
        subpath: subpath.map(link::percent_decode),
        display,
        line,
        col,
        len: link::first_line_len(source),
        dest,
    })
}

fn wiki_link(text: &str, range: Range<usize>, inner: Range<usize>, kind: LinkKind, lines: &Lines) -> Option<Link> {
    let (dest, display) = link::split_wiki(text.get(inner.clone())?);
    let (target, subpath) = link::split_target(dest);
    if target.is_empty() && subpath.is_none() {
        return None;
    }
    let (line, col) = lines.position(range.start);
    Some(Link {
        kind,
        target: target.to_owned(),
        subpath: subpath.map(str::to_owned),
        display: display.filter(|d| !d.is_empty()).map(str::to_owned),
        line,
        col,
        len: link::first_line_len(&text[range]),
        dest: Some(inner.start..inner.start + dest.len()),
    })
}

/// Tags, block ids and words in a run of plain text.
fn read_text(text: &str, range: Range<usize>, lines: &Lines, meta: &mut NoteMeta) {
    let run = &text[range.clone()];
    meta.words += run.split_whitespace().filter(|w| w.contains(char::is_alphanumeric)).count() as u32;

    for at in memchr::memchr_iter(b'#', run.as_bytes()) {
        let offset = range.start + at;
        if !text[..offset].chars().next_back().is_none_or(char::is_whitespace) {
            continue;
        }
        let rest = &run[at + 1..];
        let len = rest.find(|c| !is_tag_char(c)).unwrap_or(rest.len());
        let name = rest[..len].trim_end_matches('/');
        if is_tag(name) {
            let (line, col) = lines.position(offset);
            meta.tags.push(TagRef { name: name.to_owned(), line, col });
        }
    }

    if let Some(id) = block_id(run)
        && lines.end_of_line(range.start) == range.end
    {
        meta.blocks.push(BlockId { id: id.to_owned(), line: lines.position(range.start).0 });
    }
}

/// The id in `some text ^id`, or in a line that is only `^id`.
fn block_id(run: &str) -> Option<&str> {
    let (before, id) = run.rsplit_once('^')?;
    let ok = (before.is_empty() || before.ends_with(char::is_whitespace))
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then_some(id)
}

fn strip_block_id(text: &str) -> &str {
    block_id(text).map_or(text, |id| text[..text.len() - id.len() - 1].trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(text: &str) -> Vec<String> {
        parse(text).tags.into_iter().map(|t| t.name).collect()
    }

    fn links(text: &str) -> Vec<(LinkKind, String, Option<String>, Option<String>)> {
        parse(text).links.into_iter().map(|l| (l.kind, l.target, l.subpath, l.display)).collect()
    }

    #[test]
    fn reads_frontmatter() {
        let meta = parse(
            "---\ntitle: Plan\naliases: [The plan, P]\ntags:\n  - work/q4\n  - '#idea'\nup: \"[[Home|h]]\"\n---\n# Other\n",
        );
        assert_eq!(meta.title.as_deref(), Some("Plan"));
        assert_eq!(meta.aliases, ["The plan", "P"]);
        assert_eq!(meta.tags.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["work/q4", "idea"]);
        assert_eq!(meta.tags[0].line, 3);
        assert_eq!(meta.links[0].kind, LinkKind::Property);
        assert_eq!((meta.links[0].target.as_str(), meta.links[0].line), ("Home", 6));
        assert_eq!(meta.headings[0].line, 8);
        assert!(!meta.invalid_frontmatter);
    }

    #[test]
    fn broken_frontmatter_is_reported_and_the_body_still_reads() {
        let meta = parse("---\na: [1\n---\n# T\n#tag");
        assert!(meta.invalid_frontmatter && meta.frontmatter.is_none());
        assert_eq!(meta.title.as_deref(), Some("T"));
        assert_eq!(meta.tags.len(), 1);
        // Not closed: not frontmatter at all.
        assert!(!parse("---\ntext").invalid_frontmatter);
        assert!(!parse("---\n---\ntext").invalid_frontmatter);
    }

    #[test]
    fn tags_as_strings_and_singular_keys() {
        assert_eq!(tags("---\ntags: a, b c\n---\n"), ["a", "b", "c"]);
        assert_eq!(tags("---\ntag: solo\n---\n"), ["solo"]);
        assert_eq!(parse("---\naliases: One name, Other\n---\n").aliases, ["One name", "Other"]);
    }

    #[test]
    fn finds_tags_in_text_only() {
        assert_eq!(tags("#one and #two/three, #año_2 #🚀 #2026 #y2026"), ["one", "two/three", "año_2", "🚀", "y2026"]);
        assert_eq!(tags("`#code` a#b \\#escaped [#x](y.md) <!-- #no -->"), Vec::<String>::new());
        assert_eq!(tags("```\n#no\n```\n\n- #list\n\n> #quote\n\n## Heading #in"), ["list", "quote", "in"]);
        assert_eq!(tags("#with_under_scores and #kebab-case/"), ["with_under_scores", "kebab-case"]);
        assert_eq!(tags("#[[x]] # #"), Vec::<String>::new());
    }

    #[test]
    fn finds_links_of_every_kind() {
        use LinkKind::*;
        let own = |s: &str| Some(s.to_owned());
        assert_eq!(
            links("[[A]] ![[b.png|300]] [[C#H|see]] [t](d%20e.md#x) ![i](../f.png) [w](https://x.y) <https://z>"),
            [
                (Wiki, "A".into(), None, None),
                (Embed, "b.png".into(), None, own("300")),
                (Wiki, "C".into(), own("H"), own("see")),
                (Markdown, "d e.md".into(), own("x"), own("t")),
                (Image, "../f.png".into(), None, own("i")),
            ]
        );
        assert_eq!(links("`[[no]]`\n\n```\n[[no]]\n```\n\n[[Project: X]]"), [(Wiki, "Project: X".into(), None, None)]);
        assert_eq!(links("[[#Here]] [[^bad]] [[]]")[0], (Wiki, String::new(), own("Here"), None));
        assert_eq!(links("[r][ref]\n\n[ref]: note.md")[0].1, "note.md");
    }

    #[test]
    fn links_know_where_their_destination_is() {
        let text = "x [[A#H|b]] [t](<c d.md>)\n| [[T\\|t]] |\n|---|\n| ![[i.png]] |";
        let dests: Vec<&str> = parse(text).links.iter().map(|l| &text[l.dest.clone().unwrap()]).collect();
        assert_eq!(dests, ["A#H", "c d.md", "T", "i.png"]);
    }

    #[test]
    fn positions_are_editor_positions() {
        let meta = parse("# Uno\r\n\r\nñ😀 [[Dos]] #tag\r\n");
        assert_eq!((meta.links[0].line, meta.links[0].col, meta.links[0].len), (2, 4, 7));
        assert_eq!((meta.tags[0].line, meta.tags[0].col), (2, 12));
    }

    #[test]
    fn reads_headings_and_blocks() {
        let meta = parse("# A *b* `c`\n\nSetext\n===\n\n## Sub ^h1\n\ntext ^p-1\n\n- item ^i\n\n^alone\n");
        let headings: Vec<(u8, &str, u32)> = meta.headings.iter().map(|h| (h.level, h.text.as_str(), h.line)).collect();
        assert_eq!(headings, [(1, "A b c", 0), (1, "Setext", 2), (2, "Sub", 5)]);
        let blocks: Vec<(&str, u32)> = meta.blocks.iter().map(|b| (b.id.as_str(), b.line)).collect();
        assert_eq!(blocks, [("h1", 5), ("p-1", 7), ("i", 9), ("alone", 11)]);
    }

    #[test]
    fn reads_tasks() {
        let meta = parse("- [ ] one **bold** `x`\n  - [x] nested\n- [X] three\n  more\n- plain\n");
        let tasks: Vec<(bool, &str, u32)> = meta.tasks.iter().map(|t| (t.done, t.text.as_str(), t.line)).collect();
        assert_eq!(tasks, [(false, "one bold x", 0), (true, "nested", 1), (true, "three", 2)]);
    }

    #[test]
    fn counts_words() {
        assert_eq!(parse("# One two\n\nthree *four* — `code`\n").words, 4);
    }

    #[test]
    fn never_panics_on_odd_input() {
        for text in [
            "",
            "---",
            "---\n",
            "[[",
            "![[",
            "[[|]]",
            "![[]]",
            "#",
            "^",
            "- [ ]",
            "[a](",
            "\u{feff}# x",
            "---\n[[a\n---\n",
            "[[a\nb]]",
        ] {
            parse(text);
        }
    }
}
