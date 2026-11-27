//! The tools that only read. Doc comments of arguments and results become
//! the schemas' descriptions, which the model reads.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use chrono::DateTime;
use itztli_core::{Lines, NoteMeta, path, section};
use itztli_index::{FileMatches, FindScope, Index, ProblemKind, TextQuery, TextResults};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Found, ReadTool, Reading, clean, folder_at, no_note, note_at, timestamp};

/// Most text `read_note` returns at once, in bytes: what fits well in a
/// model's context.
const MAX_TEXT: usize = 64 * 1024;
/// Most links and backlinks `describe_note` lists.
const MAX_LINKS: usize = 200;
/// Most words a search takes apart.
const MAX_WORDS: usize = 8;

/// The note a path, or a name as links call it, leads to.
fn find_note(index: &Index, p: &str) -> Result<String, String> {
    note_at(index, p)
        .or_else(|| index.resolve("", clean(p), false).filter(|p| path::is_note(p)).map(str::to_owned))
        .ok_or_else(|| no_note(index, p))
}

fn modified(ms: u64) -> Option<String> {
    DateTime::from_timestamp_millis(i64::try_from(ms).ok()?).map(timestamp)
}

fn tags_of(meta: &NoteMeta) -> Vec<String> {
    let mut seen = HashSet::new();
    meta.tags.iter().filter(|t| seen.insert(path::key(&t.name))).map(|t| t.name.clone()).collect()
}

/// `folder: Ideas, tag: work`, what is there of it.
fn filters(parts: &[(&str, Option<&str>)]) -> Option<String> {
    let given: Vec<String> =
        parts.iter().filter_map(|(name, value)| value.filter(|v| !v.is_empty()).map(|v| format!("{name}: {v}"))).collect();
    (!given.is_empty()).then(|| given.join(", "))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    /// The query as it is.
    #[default]
    Text,
    /// Notes that contain every word of the query, anywhere in the note.
    Words,
    /// The query is a regular expression.
    Regex,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchNotes {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// What to look for. Case and accents are ignored unless `matchCase` is true.
    pub query: String,
    /// How the query matches; `text` unless given.
    #[serde(default)]
    pub mode: SearchMode,
    #[serde(default)]
    pub match_case: bool,
    /// Match only whole words.
    #[serde(default)]
    pub whole_words: bool,
    /// Only in this folder and the ones inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Most matching lines to return; 100 unless the user changed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1000))]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutput {
    /// Notes named after the query come first.
    pub notes: Vec<NoteMatches>,
    /// There are more matches than were returned: narrow the search.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NoteMatches {
    pub path: String,
    pub lines: Vec<MatchingLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MatchingLine {
    pub line: u32,
    /// The line, cut around the match when it is long.
    pub text: String,
}

impl ReadTool for SearchNotes {
    const NAME: &'static str = "search_notes";
    type Output = SearchOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn detail(&self) -> Option<String> {
        Some(self.query.clone())
    }

    fn run(self, cx: &Reading) -> Result<Found<SearchOutput>, String> {
        if self.query.trim().is_empty() {
            return Err("The query is empty: pass what to look for, or use list_notes to see the notes.".into());
        }
        let folder = folder_at(&cx.workspace.index(), self.folder.as_deref())?;
        let limit = cx.limit(self.limit);
        let grep = |text: &str, limit: usize| -> Result<TextResults, String> {
            let query = TextQuery {
                text: text.to_owned(),
                match_case: self.match_case,
                whole_words: self.whole_words,
                regex: self.mode == SearchMode::Regex,
                folder: folder.clone(),
                limit,
            };
            let found = cx.workspace.grep(&query, || cx.cancel.is_cancelled());
            found.map_err(|e| format!("The regular expression is not valid: {}", e.message))
        };
        let results = match self.mode {
            SearchMode::Words => every_word(&self.query, limit, grep)?,
            _ => grep(&self.query, limit)?,
        };

        // Several matches in a line are one line.
        let notes: Vec<NoteMatches> = results
            .files
            .into_iter()
            .map(|file| {
                let mut lines: Vec<MatchingLine> = Vec::new();
                for m in file.matches {
                    if lines.last().is_none_or(|last| last.line != m.line + 1) {
                        lines.push(MatchingLine { line: m.line + 1, text: m.preview });
                    }
                }
                NoteMatches { path: file.path, lines }
            })
            .collect();
        let count = notes.iter().map(|n| n.lines.len()).sum();
        let output = SearchOutput { notes, truncated: results.truncated };
        Ok(Found { truncated: output.truncated, output, path: None, count })
    }
}

/// The notes where each word appears, with the lines that have any of them.
fn every_word(
    query: &str,
    limit: usize,
    grep: impl Fn(&str, usize) -> Result<TextResults, String>,
) -> Result<TextResults, String> {
    let words: BTreeSet<&str> = query.split_whitespace().take(MAX_WORDS).collect();
    let mut order: Vec<String> = Vec::new();
    let mut all: BTreeMap<String, FileMatches> = BTreeMap::new();
    for (n, word) in words.into_iter().enumerate() {
        let files = grep(word, 0)?.files;
        if n == 0 {
            order = files.iter().map(|f| f.path.clone()).collect();
            all = files.into_iter().map(|f| (f.path.clone(), f)).collect();
            continue;
        }
        let mut these: BTreeMap<String, FileMatches> = files.into_iter().map(|f| (f.path.clone(), f)).collect();
        all.retain(|p, file| match these.remove(p) {
            Some(more) => {
                file.matches.extend(more.matches);
                true
            }
            None => false,
        });
    }
    let mut results = TextResults::default();
    for p in order {
        let Some(mut file) = all.remove(&p) else { continue };
        file.matches.sort_by_key(|m| (m.line, m.col));
        file.matches.dedup_by_key(|m| m.line);
        let left = limit - results.total;
        if file.matches.len() > left {
            file.matches.truncate(left);
            results.truncated = true;
        }
        results.total += file.matches.len();
        if !file.matches.is_empty() {
            results.files.push(file);
        }
    }
    Ok(results)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SortNotes {
    /// By path, or by how well the name matches when `name` is given.
    #[default]
    Path,
    /// The last changed first.
    Modified,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListNotes {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// Only in this folder and the ones inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Only with this tag, or one nested under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// Only notes whose name, alias, title or path looks like this (fuzzy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub sort: SortNotes,
    /// Most notes to return; 100 unless the user changed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1000))]
    pub limit: Option<u32>,
    /// Skip this many, to get the next page.
    #[serde(default)]
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListNotesOutput {
    pub notes: Vec<NoteEntry>,
    /// How many there are in all.
    pub total: usize,
    /// There are more after these: pass `offset`.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NoteEntry {
    pub path: String,
    /// Its title, when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub words: u32,
    /// When it last changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

impl ReadTool for ListNotes {
    const NAME: &'static str = "list_notes";
    type Output = ListNotesOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> Option<&str> {
        self.folder.as_deref()
    }

    fn detail(&self) -> Option<String> {
        filters(&[("tag", self.tag.as_deref()), ("name", self.name.as_deref())])
    }

    fn run(self, cx: &Reading) -> Result<Found<ListNotesOutput>, String> {
        let index = cx.workspace.index();
        let folder = folder_at(&index, self.folder.as_deref())?;
        let tagged: Option<HashSet<String>> = self.tag.as_deref().map(|tag| index.notes_with_tag(tag).into_iter().collect());
        let fits = |p: &str| path::is_within(p, &folder) && tagged.as_ref().is_none_or(|tagged| tagged.contains(p));

        let mut paths: Vec<String> = match self.name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => index.find_files(name, FindScope::Notes, usize::MAX).into_iter().map(|hit| hit.path).collect(),
            None => index.entries().filter(|e| !e.folder && path::is_note(&e.path)).map(|e| e.path.clone()).collect(),
        };
        paths.retain(|p| fits(p));
        if self.sort == SortNotes::Modified {
            paths.sort_by_key(|p| std::cmp::Reverse(index.entry(p).map(|e| e.modified)));
        }
        let total = paths.len();
        let notes: Vec<NoteEntry> = paths
            .into_iter()
            .skip(self.offset as usize)
            .take(cx.limit(self.limit))
            .map(|p| {
                let meta = index.note(&p);
                NoteEntry {
                    title: meta.and_then(|m| m.title.clone()),
                    tags: meta.map(|m| tags_of(m)).unwrap_or_default(),
                    words: meta.map(|m| m.words).unwrap_or_default(),
                    modified: index.entry(&p).and_then(|e| modified(e.modified)),
                    path: p,
                }
            })
            .collect();
        let count = notes.len();
        let truncated = self.offset as usize + count < total;
        Ok(Found { output: ListNotesOutput { notes, total, truncated }, path: None, count, truncated })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path, or its name as links call it.
    pub path: String,
    /// Only this part: `Heading`, `Heading#Subheading`, or `^block-id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Start at this line of the note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub from_line: Option<u32>,
    /// Return this many lines at most.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub max_lines: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadNoteOutput {
    pub path: String,
    pub text: String,
    /// The line of the note the text starts at.
    pub line: u32,
    /// Lines in the whole note.
    pub total_lines: u32,
    /// Identifies this exact content of the whole note, for replace_note and delete_note.
    pub revision: String,
    /// The text goes on: read from `fromLine` = `line` plus the lines returned.
    pub truncated: bool,
}

impl ReadTool for ReadNote {
    const NAME: &'static str = "read_note";
    type Output = ReadNoteOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> Option<&str> {
        Some(&self.path)
    }

    fn detail(&self) -> Option<String> {
        let line = self.from_line.map(|line| line.to_string());
        filters(&[("section", self.section.as_deref()), ("from line", line.as_deref())])
    }

    fn run(self, cx: &Reading) -> Result<Found<ReadNoteOutput>, String> {
        let p = find_note(&cx.workspace.index(), &self.path)?;
        let file = cx.workspace.read(&p).map_err(|e| e.message)?;
        let text = file.text.as_str();
        let total_lines = text.lines().count() as u32;

        let (mut line, mut part) = match self.section.as_deref().map(|s| s.trim_start_matches('#').trim()) {
            Some(section) if !section.is_empty() => {
                let part = section::extract(text, section).ok_or_else(|| no_section(&p, text, section))?;
                (Lines::new(text).position(part.as_ptr() as usize - text.as_ptr() as usize).0 + 1, part)
            }
            _ => (1, text),
        };
        if let Some(from) = self.from_line {
            while line < from && !part.is_empty() {
                part = part.split_once('\n').map_or("", |(_, rest)| rest);
                line += 1;
            }
        }
        let shown = head(part, self.max_lines.map_or(usize::MAX, |n| n as usize));
        let truncated = shown.len() < part.len();
        let output = ReadNoteOutput {
            text: shown.to_owned(),
            line,
            total_lines,
            revision: file.revision.clone(),
            truncated,
            path: p.clone(),
        };
        Ok(Found { output, path: Some(p), count: shown.lines().count(), truncated })
    }
}

fn no_section(p: &str, text: &str, section: &str) -> String {
    let headings: Vec<String> = itztli_core::parse(text).headings.into_iter().take(40).map(|h| h.text).collect();
    if headings.is_empty() {
        return format!("'{p}' has no headings, and no block '{section}'. Read it without `section`.");
    }
    format!("'{p}' has no section '{section}'. Its headings are: {}.", headings.join(" | "))
}

/// The first lines, whole, as far as [`MAX_TEXT`] allows.
fn head(text: &str, lines: usize) -> &str {
    let mut end = 0;
    for line in text.split_inclusive('\n').take(lines) {
        if end + line.len() > MAX_TEXT {
            // A line longer than that alone is cut.
            return if end == 0 { &line[..line.floor_char_boundary(MAX_TEXT)] } else { &text[..end] };
        }
        end += line.len();
    }
    &text[..end]
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DescribeNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path, or its name as links call it.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DescribeNoteOutput {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What the note is, as its `type` property says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    /// Its YAML frontmatter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub properties: Option<Map<String, Value>>,
    pub headings: Vec<HeadingEntry>,
    /// Links in the note, at most 200.
    pub links: Vec<LinkEntry>,
    /// Links to the note, at most 200.
    pub backlinks: Vec<BacklinkEntry>,
    pub tasks_open: usize,
    pub tasks_done: usize,
    pub words: u32,
    /// When it last changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    /// There are more links or backlinks than listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeadingEntry {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkEntry {
    /// As written in the note.
    pub target: String,
    /// Where it leads; absent when nothing is there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The property it is in, which names how the notes relate:
    /// `author` for `author: "[[Ana]]"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkEntry {
    pub path: String,
    pub line: u32,
    /// The line the link is on.
    pub text: String,
    /// The property of that note the link is in: `author` when it says
    /// `author: "[[This note]]"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
}

impl ReadTool for DescribeNote {
    const NAME: &'static str = "describe_note";
    type Output = DescribeNoteOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> Option<&str> {
        Some(&self.path)
    }

    fn run(self, cx: &Reading) -> Result<Found<DescribeNoteOutput>, String> {
        let (p, meta, entry, mut links) = {
            let index = cx.workspace.index();
            let p = find_note(&index, &self.path)?;
            let meta = index.note(&p).cloned().ok_or_else(|| format!("Itztli could not read '{p}'."))?;
            let links: Vec<LinkEntry> = meta
                .links
                .iter()
                .map(|l| LinkEntry {
                    target: match &l.subpath {
                        Some(subpath) => format!("{}#{subpath}", l.target),
                        None => l.target.clone(),
                    },
                    path: index.resolve_link(&p, l).map(str::to_owned),
                    relation: l.relation.clone(),
                    line: l.line + 1,
                })
                .collect();
            let entry = index.entry(&p).cloned();
            (p, meta, entry, links)
        };
        let mut backlinks: Vec<BacklinkEntry> = cx
            .workspace
            .usages(&p)
            .into_iter()
            .flat_map(|from| {
                let path = from.path;
                from.links.into_iter().map(move |u| BacklinkEntry {
                    path: path.clone(),
                    line: u.link.line + 1,
                    text: u.context,
                    relation: u.link.relation,
                })
            })
            .collect();
        let truncated = links.len() > MAX_LINKS || backlinks.len() > MAX_LINKS;
        links.truncate(MAX_LINKS);
        backlinks.truncate(MAX_LINKS);
        let done = meta.tasks.iter().filter(|t| t.done).count();
        let output = DescribeNoteOutput {
            title: meta.title.clone(),
            r#type: meta.r#type.clone(),
            aliases: meta.aliases.clone(),
            tags: tags_of(&meta),
            properties: meta.frontmatter.clone(),
            headings: meta
                .headings
                .iter()
                .map(|h| HeadingEntry { level: h.level, text: h.text.clone(), line: h.line + 1 })
                .collect(),
            tasks_open: meta.tasks.len() - done,
            tasks_done: done,
            words: meta.words,
            modified: entry.and_then(|e| modified(e.modified)),
            truncated,
            links,
            backlinks,
            path: p.clone(),
        };
        let count = output.links.len() + output.backlinks.len();
        Ok(Found { output, path: Some(p), count, truncated })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListTags {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListTagsOutput {
    /// By name. A nested tag, `a/b`, counts for `a` too.
    pub tags: Vec<TagEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TagEntry {
    pub name: String,
    /// How many notes have it.
    pub notes: u32,
}

impl ReadTool for ListTags {
    const NAME: &'static str = "list_tags";
    type Output = ListTagsOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn run(self, cx: &Reading) -> Result<Found<ListTagsOutput>, String> {
        let tags: Vec<TagEntry> =
            cx.workspace.index().tags().into_iter().map(|t| TagEntry { name: t.name, notes: t.notes }).collect();
        let count = tags.len();
        Ok(Found { output: ListTagsOutput { tags }, path: None, count, truncated: false })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    #[default]
    Open,
    Done,
    All,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListTasks {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// Only in this note, or in this folder and the ones inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Open tasks (`- [ ]`) unless given.
    #[serde(default)]
    pub status: TaskStatus,
    /// Most tasks to return; 100 unless the user changed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1000))]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksOutput {
    pub tasks: Vec<TaskEntry>,
    /// How many there are in all.
    pub total: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskEntry {
    pub path: String,
    pub line: u32,
    pub done: bool,
    pub text: String,
}

impl ReadTool for ListTasks {
    const NAME: &'static str = "list_tasks";
    type Output = ListTasksOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    fn detail(&self) -> Option<String> {
        match self.status {
            TaskStatus::Open => None,
            TaskStatus::Done => Some("done".into()),
            TaskStatus::All => Some("open and done".into()),
        }
    }

    fn run(self, cx: &Reading) -> Result<Found<ListTasksOutput>, String> {
        let place = place_at(&cx.workspace.index(), self.path.as_deref())?;
        let tasks: Vec<TaskEntry> = cx
            .workspace
            .tasks()
            .into_iter()
            .filter(|t| path::is_within(&t.path, &place))
            .filter(|t| match self.status {
                TaskStatus::Open => !t.done,
                TaskStatus::Done => t.done,
                TaskStatus::All => true,
            })
            .map(|t| TaskEntry { path: t.path, line: t.line + 1, done: t.done, text: t.text })
            .collect();
        let (tasks, total, truncated) = first(tasks, cx.limit(self.limit));
        let count = tasks.len();
        Ok(Found { output: ListTasksOutput { tasks, total, truncated }, path: None, count, truncated })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListProblems {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// Only in this note, or in this folder and the ones inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Most problems to return; 100 unless the user changed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1000))]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListProblemsOutput {
    pub problems: Vec<ProblemEntry>,
    /// How many there are in all.
    pub total: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProblemEntry {
    pub path: String,
    pub line: u32,
    /// `missingNote`: the link leads to no note. `missingPlace`: the note is there, but not the heading or block.
    /// `invalidFrontmatter`: the properties are not valid YAML.
    pub kind: String,
    /// What the link points at.
    pub target: String,
}

impl ReadTool for ListProblems {
    const NAME: &'static str = "list_problems";
    type Output = ListProblemsOutput;

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    fn run(self, cx: &Reading) -> Result<Found<ListProblemsOutput>, String> {
        let index = cx.workspace.index();
        let place = place_at(&index, self.path.as_deref())?;
        let problems: Vec<ProblemEntry> = index
            .problems()
            .into_iter()
            .filter(|p| path::is_within(&p.path, &place))
            .map(|p| ProblemEntry {
                kind: match p.kind {
                    ProblemKind::MissingNote => "missingNote",
                    ProblemKind::MissingPlace => "missingPlace",
                    ProblemKind::InvalidFrontmatter => "invalidFrontmatter",
                }
                .into(),
                path: p.path,
                line: p.line + 1,
                target: p.target,
            })
            .collect();
        let (problems, total, truncated) = first(problems, cx.limit(self.limit));
        let count = problems.len();
        Ok(Found { output: ListProblemsOutput { problems, total, truncated }, path: None, count, truncated })
    }
}

/// A note or a folder; empty for the whole vault.
fn place_at(index: &Index, p: Option<&str>) -> Result<String, String> {
    match p.map(clean).filter(|p| !p.is_empty()) {
        Some(p) => match note_at(index, p) {
            Some(note) => Ok(note),
            None if index.entry(p).is_some_and(|e| e.folder) => Ok(p.to_owned()),
            None => Err(no_note(index, p)),
        },
        None => Ok(String::new()),
    }
}

fn first<T>(mut all: Vec<T>, limit: usize) -> (Vec<T>, usize, bool) {
    let total = all.len();
    all.truncate(limit);
    (all, total, total > limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_lines_are_whole_lines_that_fit() {
        assert_eq!(head("a\nb\nc\n", 2), "a\nb\n");
        assert_eq!(head("a\nb", 9), "a\nb");
        let long = format!("short\n{}\n", "x".repeat(MAX_TEXT));
        assert_eq!(head(&long, usize::MAX), "short\n");
        let line = "é".repeat(MAX_TEXT);
        assert_eq!(head(&line, usize::MAX).len(), MAX_TEXT);
    }

    #[test]
    fn schemas_describe_arguments_for_the_model() {
        let schema = serde_json::to_value(schemars::schema_for!(SearchNotes)).unwrap();
        assert!(schema["properties"]["query"]["description"].as_str().unwrap().contains("accents"), "{schema}");
        assert_eq!(schema["properties"]["limit"]["maximum"], 1000, "{schema}");
        assert_eq!(schema["required"], serde_json::json!(["vault", "query"]), "{schema}");
    }

    #[test]
    fn arguments_accept_what_models_send() {
        let args = serde_json::json!({ "vault": "v", "query": "x", "mode": "words" });
        let search: SearchNotes = serde_json::from_value(args).unwrap();
        assert_eq!((search.mode, search.limit), (SearchMode::Words, None));
        let list: ListNotes = serde_json::from_value(serde_json::json!({ "vault": "v", "sort": "modified" })).unwrap();
        assert_eq!((list.sort, list.offset), (SortNotes::Modified, 0));
    }
}
