//! The tools that change the vault. Each works out what it would do, as a
//! [`Plan`] the user sees whole; making it happens later, on exactly what
//! the plan was made from.

use std::collections::HashMap;

use itztli_backend::{CommandError, ErrorCode, Workspace};
use itztli_core::{path, section};
use itztli_history::Reason;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{WriteTool, clean, no_note, note_at};
use crate::{Action, Warning};

/// A note shorter than this is easy to see whole in the dialog.
const MANY_LINES: usize = 10;

/// A change worked out, and not made yet.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub(super) action: Action,
    pub(super) path: String,
    pub(super) to: Option<String>,
    pub(super) before: Option<String>,
    pub(super) after: Option<String>,
    /// What `before` was read from: the note must still hold it.
    pub(super) revision: Option<String>,
    pub(super) affected: Vec<String>,
    pub(super) warnings: Vec<Warning>,
}

impl Plan {
    fn new(action: Action, path: String) -> Self {
        Self { action, path, to: None, before: None, after: None, revision: None, affected: Vec::new(), warnings: Vec::new() }
    }

    fn edit(path: String, before: String, after: String, revision: String) -> Result<Self, String> {
        if before == after {
            return Err(format!("That changes nothing: '{path}' already says so."));
        }
        let warnings = if removes_most(&before, &after) { vec![Warning::RemovesMost] } else { Vec::new() };
        let (before, after, revision) = (Some(before), Some(after), Some(revision));
        Ok(Self { before, after, revision, warnings, ..Self::new(Action::Edit, path) })
    }

    /// Makes the change. The error is for the model.
    pub(super) fn make(self, workspace: &Workspace) -> Result<ChangeOutput, String> {
        let failed = |e: CommandError| match e.code {
            ErrorCode::Conflict => format!(
                "'{}' changed while the change waited for approval, so it was not made. Read it again and propose the \
                 change anew.",
                self.path
            ),
            ErrorCode::NotFound => {
                format!("'{}' went away while the change waited for approval, so it was not made.", self.path)
            }
            _ => format!("The change was approved, but it could not be made: {}", e.message),
        };
        let mut output = ChangeOutput { path: self.path.clone(), ..ChangeOutput::default() };
        match self.action {
            Action::Create => {
                let text = self.after.as_deref().unwrap_or_default();
                workspace.create(&self.path, text).map_err(failed)?;
                output.revision = Some(workspace.read(&self.path).map_err(failed)?.revision);
            }
            Action::Edit => {
                let text = self.after.as_deref().unwrap_or_default();
                let base = self.revision.as_deref();
                output.revision = Some(workspace.write_as(&self.path, text, base, Reason::Mcp).map_err(failed)?);
            }
            Action::Move => {
                let to = self.to.clone().unwrap_or_default();
                let moved = workspace.move_entry(&self.path, &to, true).map_err(failed)?;
                output.path = to;
                output.relinked = moved.relinked.into_iter().map(|n| n.path).collect();
                output.not_relinked = moved.failed.into_iter().map(|(p, _)| p).collect();
            }
            Action::Delete => workspace.trash_if(&self.path, self.revision.as_deref()).map_err(failed)?,
        }
        Ok(output)
    }
}

/// Whether most of a note's lines are gone.
fn removes_most(before: &str, after: &str) -> bool {
    let lines = |text: &str| text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect::<Vec<_>>();
    let before = lines(before);
    let mut left: HashMap<String, usize> = HashMap::new();
    for line in lines(after) {
        *left.entry(line).or_default() += 1;
    }
    let kept =
        before.iter().filter(|line| left.get_mut(*line).is_some_and(|n| n.checked_sub(1).map(|m| *n = m).is_some())).count();
    before.len() >= MANY_LINES && kept * 2 < before.len()
}

/// What a change did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChangeOutput {
    /// The note's path now; for a deletion, the one it had.
    pub path: String,
    /// Identifies what the note says now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// After a move: notes whose links to it were rewritten.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relinked: Vec<String>,
    /// After a move: notes whose links to it could not be rewritten.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_relinked: Vec<String>,
}

/// The note to change. Never by a name that could mean another one.
fn target(workspace: &Workspace, p: &str) -> Result<String, String> {
    let index = workspace.index();
    note_at(&index, p).ok_or_else(|| no_note(&index, p))
}

/// What a link could not hold, or some platform not write. Invisible
/// characters could pass one name for another in the approval dialog.
fn is_allowed(c: char) -> bool {
    let invisible = matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}');
    !c.is_control() && !invisible && !r#"\:*?"<>|#^[]"#.contains(c)
}

/// A path a new note can have, by the same rules as in the app.
fn note_path(p: &str) -> Result<String, String> {
    if p.trim().ends_with('/') {
        return Err(format!("'{p}' is a folder: add the note's name, like '{}/Note.md'.", clean(p)));
    }
    let p = clean(p);
    let full = match path::name(p).rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && extension.eq_ignore_ascii_case("md") => p.to_owned(),
        _ => format!("{p}.md"),
    };
    if path::validate(&full).is_err() || !path::is_note(&full) {
        return Err(format!("'{p}' is not a path a note can have: use one relative to the vault, like 'Ideas/Note.md'."));
    }
    if full.split('/').any(|part| part.starts_with('.')) {
        return Err("Names starting with a dot are hidden, and not for notes.".into());
    }
    if !full.chars().all(is_allowed) || full.split('/').any(|part| part != part.trim()) {
        return Err(
            r#"A note's path can't contain \ : * ? " < > | # ^ [ ] or invisible characters, nor spaces around a name."#.into()
        );
    }
    Ok(full)
}

/// A path nothing uses yet.
fn unused(workspace: &Workspace, p: String) -> Result<String, String> {
    if workspace.vault.exists(&p) {
        return Err(format!("'{p}' already exists. Choose another path, or change that note instead."));
    }
    Ok(p)
}

/// Text with the line breaks the note uses.
fn with_breaks_of(note: &str, text: &str) -> String {
    let unix = text.replace("\r\n", "\n");
    if note.contains("\r\n") { unix.replace('\n', "\r\n") } else { unix }
}

fn line_break(note: &str) -> &'static str {
    if note.contains("\r\n") { "\r\n" } else { "\n" }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// Where to create it, relative to the vault: `Ideas/Note.md`. Folders that don't exist are created.
    pub path: String,
    /// The note's Markdown.
    pub text: String,
    /// Why, shown to the user who approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WriteTool for CreateNote {
    const NAME: &'static str = "create_note";

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    fn detail(&self) -> Option<String> {
        Some(self.text.clone())
    }

    fn plan(&self, workspace: &Workspace) -> Result<Plan, String> {
        let p = unused(workspace, note_path(&self.path)?)?;
        Ok(Plan { after: Some(self.text.clone()), ..Plan::new(Action::Create, p) })
    }
}

/// Replaces some text of a note with other text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    /// The text to replace, exactly as the note has it.
    pub old_text: String,
    pub new_text: String,
    /// Replace it everywhere; otherwise it must appear once.
    #[serde(default)]
    pub replace_all: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path.
    pub path: String,
    /// Made in order, each on what the one before left.
    #[schemars(length(min = 1))]
    pub edits: Vec<TextEdit>,
    /// Why, shown to the user who approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WriteTool for EditNote {
    const NAME: &'static str = "edit_note";

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    fn detail(&self) -> Option<String> {
        let marked = |mark: char, text: &str| text.lines().map(|line| format!("{mark} {line}\n")).collect::<String>();
        let edits = self.edits.iter().map(|e| marked('-', &e.old_text) + &marked('+', &e.new_text));
        Some(edits.collect::<Vec<_>>().join("\n"))
    }

    fn plan(&self, workspace: &Workspace) -> Result<Plan, String> {
        if self.edits.is_empty() {
            return Err("There are no edits: pass at least one.".into());
        }
        let p = target(workspace, &self.path)?;
        let file = workspace.read(&p).map_err(|e| e.message)?;
        let mut after = file.text.clone();
        for (n, edit) in self.edits.iter().enumerate() {
            let which = if self.edits.len() > 1 { format!("Edit {}: ", n + 1) } else { String::new() };
            let old = with_breaks_of(&file.text, &edit.old_text);
            if old.is_empty() {
                return Err(format!("{which}oldText is empty. Use append_to_note to add text."));
            }
            match after.matches(&old).count() {
                0 => {
                    return Err(format!(
                        "{which}the text to replace is not in '{p}'. It must be exactly as the note has it: read the note \
                         again."
                    ));
                }
                1 => {}
                _ if edit.replace_all => {}
                many => {
                    return Err(format!(
                        "{which}the text to replace appears {many} times in '{p}'. Include more of what surrounds it, or \
                         pass replaceAll."
                    ));
                }
            }
            after = after.replace(&old, &with_breaks_of(&file.text, &edit.new_text));
        }
        Plan::edit(p, file.text, after, file.revision)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppendToNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path.
    pub path: String,
    /// The Markdown to add, on a line of its own. Start it with an empty line to leave one before it.
    pub text: String,
    /// Add it at the end of this section (`Heading`, `Heading#Subheading`) rather than of the note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Why, shown to the user who approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WriteTool for AppendToNote {
    const NAME: &'static str = "append_to_note";

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    fn detail(&self) -> Option<String> {
        Some(self.text.clone())
    }

    fn plan(&self, workspace: &Workspace) -> Result<Plan, String> {
        if self.text.trim().is_empty() {
            return Err("There is no text to add.".into());
        }
        let p = target(workspace, &self.path)?;
        let file = workspace.read(&p).map_err(|e| e.message)?;
        let section = self.section.as_deref().map(|s| s.trim_start_matches('#').trim()).filter(|s| !s.is_empty());
        let after = match section {
            None => append(&file.text, &self.text),
            Some(section) => {
                let part = section::extract(&file.text, section)
                    .ok_or_else(|| format!("'{p}' has no section '{section}'. describe_note lists its headings."))?;
                let end = part.as_ptr() as usize - file.text.as_ptr() as usize + part.len();
                let (before, rest) = file.text.split_at(end);
                let text = with_breaks_of(&file.text, self.text.trim_end());
                format!("{before}{}{text}{rest}", line_break(&file.text))
            }
        };
        Plan::edit(p, file.text, after, file.revision)
    }
}

/// At the end of the note, on a line of its own.
fn append(note: &str, text: &str) -> String {
    let newline = line_break(note);
    let gap = if note.is_empty() || note.ends_with('\n') { "" } else { newline };
    format!("{note}{gap}{}{newline}", with_breaks_of(note, text.trim_end()))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path.
    pub path: String,
    /// All of the note's Markdown.
    pub text: String,
    /// The `revision` read_note gave, so nobody's change made since is lost.
    pub revision: String,
    /// Why, shown to the user who approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WriteTool for ReplaceNote {
    const NAME: &'static str = "replace_note";

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    fn detail(&self) -> Option<String> {
        Some(self.text.clone())
    }

    fn plan(&self, workspace: &Workspace) -> Result<Plan, String> {
        let p = target(workspace, &self.path)?;
        let file = workspace.read(&p).map_err(|e| e.message)?;
        unchanged(&p, &file.revision, &self.revision)?;
        let after = with_breaks_of(&file.text, &self.text);
        Plan::edit(p, file.text, after, file.revision)
    }
}

fn unchanged(p: &str, now: &str, read: &str) -> Result<(), String> {
    if now == read {
        return Ok(());
    }
    Err(format!("'{p}' changed since that revision. Read it again before changing it."))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path.
    pub path: String,
    /// Its new path, to rename it or move it: `Archive/Note.md`; or a folder that exists, with a `/` at the end.
    pub to: String,
    /// Why, shown to the user who approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WriteTool for MoveNote {
    const NAME: &'static str = "move_note";

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    fn detail(&self) -> Option<String> {
        Some(format!("→ {}", self.to))
    }

    fn plan(&self, workspace: &Workspace) -> Result<Plan, String> {
        let p = target(workspace, &self.path)?;
        let to = match self.to.trim().ends_with('/') {
            true => path::join(clean(&self.to), path::name(&p)),
            false => self.to.clone(),
        };
        let to = note_path(&to)?;
        if to == p {
            return Err(format!("'{p}' is already there."));
        }
        // Changing only the case of a name is a rename, though the disk may
        // say the name is taken.
        let to = if path::key(&to) == path::key(&p) { to } else { unused(workspace, to)? };
        let affected = workspace.preview_move(&p, &to).map_err(|e| e.message)?.into_iter().map(|n| n.path).collect();
        Ok(Plan { to: Some(to), affected, ..Plan::new(Action::Move, p) })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteNote {
    /// Vault id, or its name when no other vault has it.
    pub vault: String,
    /// The note's path. It goes to the trash.
    pub path: String,
    /// The `revision` read_note gave, to delete it only if it still says the same.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Why, shown to the user who approves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl WriteTool for DeleteNote {
    const NAME: &'static str = "delete_note";

    fn vault(&self) -> &str {
        &self.vault
    }

    fn path(&self) -> &str {
        &self.path
    }

    fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    fn detail(&self) -> Option<String> {
        None
    }

    fn plan(&self, workspace: &Workspace) -> Result<Plan, String> {
        let p = target(workspace, &self.path)?;
        let file = workspace.read(&p).map_err(|e| e.message)?;
        if let Some(revision) = &self.revision {
            unchanged(&p, &file.revision, revision)?;
        }
        let affected: Vec<String> = workspace.index().backlinks(&p).into_iter().map(|b| b.path).collect();
        let warnings = if affected.is_empty() { Vec::new() } else { vec![Warning::BreaksLinks] };
        let (before, revision) = (Some(file.text), Some(file.revision));
        Ok(Plan { before, revision, affected, warnings, ..Plan::new(Action::Delete, p) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_on_a_line_of_its_own() {
        assert_eq!(append("", "x"), "x\n");
        assert_eq!(append("a", "x\n"), "a\nx\n");
        assert_eq!(append("a\n", "\nx"), "a\n\nx\n");
        assert_eq!(append("a\r\nb", "x\ny"), "a\r\nb\r\nx\r\ny\r\n");
    }

    #[test]
    fn notices_when_most_of_a_note_goes() {
        let note: String = (0..20).map(|n| format!("line {n}\n\n")).collect();
        assert!(!removes_most(&note, &note));
        assert!(!removes_most(&note, &format!("{note}more\n")));
        assert!(removes_most(&note, "line 1\nline 2\n"));
        assert!(!removes_most("a\nb\n", ""), "a short note is easy to see whole");
        assert!(removes_most(&"same\n".repeat(20), "same\n"), "each line counts once");
    }

    #[test]
    fn edits_are_recorded_as_what_goes_and_what_comes() {
        let edit = TextEdit { old_text: "a\nb".into(), new_text: "c".into(), replace_all: false };
        let note = EditNote { edits: vec![edit.clone(), edit], ..EditNote::default() };
        assert_eq!(note.detail().unwrap(), "- a\n- b\n+ c\n\n- a\n- b\n+ c\n");
    }
}
