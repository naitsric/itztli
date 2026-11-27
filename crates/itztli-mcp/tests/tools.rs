//! The tools over a real vault: what each one returns, what it refuses, and
//! what it leaves behind in the notes, the local history and the audit log.

use std::time::Duration;

use itztli_mcp::testing::TestVault;
use itztli_mcp::{
    Access, Action, AppendToNote, ApprovalRequest, CallError, Caller, CancellationToken, ChangeOutput, CreateNote, Decision,
    DeleteNote, DescribeNote, EditNote, ListNotes, ListProblems, ListTags, ListTasks, McpEvent, MoveNote, ReadNote, ReplaceNote,
    SearchNotes, TextEdit, Warning,
};
use serde_json::{Value, json};

const FILES: &[(&str, &str)] = &[
    ("Home.md", "---\ntags: [index]\naliases: [Start]\n---\n# Home\n\nSee [[Plan]] and [[Nowhere]].\n"),
    ("Work/Plan.md", "# The plan\n\nIntro #work\n\n## Steps\n\n- [ ] Call José\n- [x] Canción nueva\n\n## Later\n\nMore.\n"),
    ("Work/Old plan.md", "Nothing. #work/archive\n"),
    ("Diary/2026-11-24.md", "Talked about the plan and about budgets.\n"),
    (".hidden/Secret.md", "Plan of plans\n"),
    ("image.png", "not a note"),
];

fn vault() -> String {
    "Notes".into()
}

fn args<T: serde::de::DeserializeOwned>(mut value: Value) -> T {
    value["vault"] = json!("Notes");
    serde_json::from_value(value).unwrap()
}

/// Calls a tool that reads, as JSON.
macro_rules! read {
    ($test:expr, $caller:expr, $tool:ty, $args:expr) => {
        $test
            .server
            .read($caller, args::<$tool>($args), &CancellationToken::new())
            .await
            .map(|output| serde_json::to_value(output).unwrap())
    };
}

/// Calls a tool that changes something, with the user answering `approve`.
/// Returns what the user saw, too.
macro_rules! change {
    ($test:expr, $caller:expr, $approve:expr, $tool:ty, $args:expr) => {{
        let server = $test.server.clone();
        let mut events = $test.events.subscribe();
        let user = tokio::spawn(async move {
            loop {
                if let McpEvent::ApprovalRequested(request) = events.recv().await.unwrap() {
                    server.answer_approval(request.id, $approve);
                    return request;
                }
            }
        });
        let outcome = $test.server.write($caller, args::<$tool>($args), |_| {}, &CancellationToken::new()).await;
        (outcome, user)
    }};
}

async fn seen(user: tokio::task::JoinHandle<ApprovalRequest>) -> ApprovalRequest {
    tokio::time::timeout(Duration::from_secs(10), user).await.expect("a request in time").unwrap()
}

fn message<T: std::fmt::Debug>(outcome: Result<T, CallError>) -> String {
    match outcome {
        Err(CallError::Tool(e)) => e.message,
        other => panic!("expected a tool error: {other:?}"),
    }
}

async fn setup(access: Access) -> (TestVault, Caller) {
    let test = TestVault::new(FILES).await;
    let (caller, _) = test.client("claude", Some(access));
    (test, caller)
}

#[tokio::test]
async fn a_client_sees_only_the_vaults_it_was_given() {
    let test = TestVault::new(FILES).await;
    let (stranger, _) = test.client("stranger", None);
    assert!(test.server.list_vaults(&stranger).await.unwrap().vaults.is_empty());
    let refused = message(read!(test, &stranger, ReadNote, json!({ "path": "Home.md" })));
    assert!(refused.starts_with("No vault 'Notes' is available"), "{refused}");
    let audit = test.events.last_audit();
    assert_eq!((audit.decision, audit.tool.as_str()), (Decision::Denied, "read_note"));
    assert_eq!(audit.vault_name.as_deref(), Some("Notes"), "the user sees what it tried to reach");

    let (caller, _) = test.client("claude", Some(Access::Read));
    let vaults = test.server.list_vaults(&caller).await.unwrap().vaults;
    assert_eq!((vaults.len(), vaults[0].name.as_str(), vaults[0].open), (1, "Notes", true));
    assert_eq!((vaults[0].writes_allowed, vaults[0].notes), (false, Some(4)));
    // By id, and by name whatever its case.
    for name in [vaults[0].id.as_str(), "notes"] {
        let read = ReadNote { vault: name.into(), path: "Home.md".into(), ..ReadNote::default() };
        assert!(test.server.read(&caller, read, &CancellationToken::new()).await.is_ok(), "{name}");
    }

    // Another vault opened: theirs is not at hand, and the other not theirs.
    test.open("Other").await;
    assert!(!test.server.list_vaults(&caller).await.unwrap().vaults[0].open);
    let refused = message(read!(test, &caller, ReadNote, json!({ "path": "Home.md" })));
    assert!(refused.contains("isn't open") && !refused.contains("Other"), "{refused}");
    let other = ReadNote { vault: "Other".into(), path: "x".into(), ..ReadNote::default() };
    assert!(message(test.server.read(&caller, other, &CancellationToken::new()).await).starts_with("No vault 'Other'"));
}

#[tokio::test]
async fn a_revoked_client_can_do_nothing() {
    let (test, caller) = setup(Access::Write).await;
    test.server.store().revoke_client(&caller.client_id).unwrap();
    assert!(message(read!(test, &caller, ReadNote, json!({ "path": "Home.md" }))).starts_with("No vault"));
    assert!(test.server.list_vaults(&caller).await.unwrap().vaults.is_empty());
}

#[tokio::test]
async fn searches_the_text_of_notes() {
    let (test, caller) = setup(Access::Read).await;
    let found = read!(test, &caller, SearchNotes, json!({ "query": "cancion" })).unwrap();
    assert_eq!(found["notes"], json!([{ "path": "Work/Plan.md", "lines": [{ "line": 8, "text": "- [x] Canción nueva" }] }]));

    let paths = |found: &Value| -> Vec<String> {
        found["notes"].as_array().unwrap().iter().map(|n| n["path"].as_str().unwrap().to_owned()).collect()
    };
    // Hidden folders are not notes, whatever they hold.
    let found = read!(test, &caller, SearchNotes, json!({ "query": "plan" })).unwrap();
    assert_eq!(paths(&found), ["Work/Plan.md", "Diary/2026-11-24.md", "Home.md"]);
    let found = read!(test, &caller, SearchNotes, json!({ "query": "plan", "folder": "Work/" })).unwrap();
    assert_eq!(paths(&found), ["Work/Plan.md"]);
    assert!(paths(&read!(test, &caller, SearchNotes, json!({ "query": "budgets plan" })).unwrap()).is_empty());
    let found = read!(test, &caller, SearchNotes, json!({ "query": "budgets plan", "mode": "words" })).unwrap();
    assert_eq!(paths(&found), ["Diary/2026-11-24.md"]);
    assert_eq!(found["notes"][0]["lines"].as_array().unwrap().len(), 1, "one line, though both words are in it");
    let found = read!(test, &caller, SearchNotes, json!({ "query": r"^- \[.\]", "mode": "regex", "limit": 1 })).unwrap();
    assert_eq!((found["notes"][0]["lines"].as_array().unwrap().len(), &found["truncated"]), (1, &json!(true)));
    let audit = test.events.last_audit();
    assert_eq!((audit.detail.as_deref(), audit.count, audit.truncated), (Some(r"^- \[.\]"), Some(1), true));

    let bad = message(read!(test, &caller, SearchNotes, json!({ "query": "(", "mode": "regex" })));
    assert!(bad.starts_with("The regular expression is not valid"), "{bad}");
    assert!(message(read!(test, &caller, SearchNotes, json!({ "query": " " }))).contains("empty"));
    assert!(message(read!(test, &caller, SearchNotes, json!({ "query": "x", "folder": "Nope" }))).contains("no folder"));
}

#[tokio::test]
async fn lists_notes_by_folder_tag_and_name() {
    let (test, caller) = setup(Access::Read).await;
    let paths = |listed: &Value| -> Vec<String> {
        listed["notes"].as_array().unwrap().iter().map(|n| n["path"].as_str().unwrap().to_owned()).collect()
    };
    let all = read!(test, &caller, ListNotes, json!({})).unwrap();
    assert_eq!(paths(&all), ["Diary/2026-11-24.md", "Home.md", "Work/Old plan.md", "Work/Plan.md"]);
    assert_eq!(all["notes"][1]["title"], "Home");
    assert_eq!(all["notes"][1]["tags"], json!(["index"]));
    assert!(all["notes"][1]["modified"].as_str().unwrap().ends_with('Z'));

    let page = read!(test, &caller, ListNotes, json!({ "limit": 2, "offset": 2 })).unwrap();
    assert_eq!((paths(&page), &page["total"], &page["truncated"]), (paths(&all)[2..].to_vec(), &json!(4), &json!(false)));
    let tagged = read!(test, &caller, ListNotes, json!({ "tag": "#work" })).unwrap();
    assert_eq!(paths(&tagged), ["Work/Old plan.md", "Work/Plan.md"], "nested tags too");
    let named = read!(test, &caller, ListNotes, json!({ "name": "start" })).unwrap();
    assert_eq!(paths(&named)[0], "Home.md", "by its alias");
    let inside = read!(test, &caller, ListNotes, json!({ "folder": "Diary" })).unwrap();
    assert_eq!(paths(&inside), ["Diary/2026-11-24.md"]);

    test.write(&[("Home.md", "changed\n")]);
    test.until(|| test.backend().workspace().unwrap().index().note("Home.md").unwrap().title.is_none()).await;
    let latest = read!(test, &caller, ListNotes, json!({ "sort": "modified", "limit": 1 })).unwrap();
    assert_eq!(paths(&latest), ["Home.md"]);
}

#[tokio::test]
async fn reads_a_note_whole_or_in_part() {
    let (test, caller) = setup(Access::Read).await;
    let whole = read!(test, &caller, ReadNote, json!({ "path": "Work/Plan.md" })).unwrap();
    assert_eq!((whole["text"].as_str().unwrap(), &whole["line"], &whole["truncated"]), (FILES[1].1, &json!(1), &json!(false)));
    // By name, as a link would, and without its extension.
    for p in ["Plan", "plan", "/Work/Plan", "work/plan.md"] {
        let found = read!(test, &caller, ReadNote, json!({ "path": p })).unwrap();
        assert_eq!(found["path"], "Work/Plan.md", "{p}");
    }
    assert_eq!(test.events.last_audit().path.as_deref(), Some("Work/Plan.md"), "the audit says which one it was");

    let section = read!(test, &caller, ReadNote, json!({ "path": "Plan", "section": "## Steps" })).unwrap();
    assert_eq!(
        (section["text"].as_str().unwrap(), &section["line"]),
        ("## Steps\n\n- [ ] Call José\n- [x] Canción nueva", &json!(5))
    );
    let lines = read!(test, &caller, ReadNote, json!({ "path": "Plan", "fromLine": 7, "maxLines": 1 })).unwrap();
    assert_eq!(
        (lines["text"].as_str().unwrap(), &lines["line"], &lines["truncated"]),
        ("- [ ] Call José\n", &json!(7), &json!(true))
    );
    let past = read!(test, &caller, ReadNote, json!({ "path": "Plan", "fromLine": 999 })).unwrap();
    assert_eq!((past["text"].as_str().unwrap(), &past["truncated"]), ("", &json!(false)));

    let missing = message(read!(test, &caller, ReadNote, json!({ "path": "Work/Plam" })));
    assert!(missing.starts_with("There is no note 'Work/Plam'."), "{missing}");
    let missing = message(read!(test, &caller, ReadNote, json!({ "path": "Plan", "section": "Nope" })));
    assert!(missing.contains("The plan | Steps | Later"), "{missing}");
    for hidden in [".hidden/Secret.md", "Secret", "../Notes/Home.md", "image.png", ".itztli/trust.json", "Work"] {
        assert!(message(read!(test, &caller, ReadNote, json!({ "path": hidden }))).starts_with("There is no note"), "{hidden}");
    }
}

#[tokio::test]
async fn describes_notes_tags_tasks_and_problems() {
    let (test, caller) = setup(Access::Read).await;
    let home = read!(test, &caller, DescribeNote, json!({ "path": "Home" })).unwrap();
    assert_eq!((&home["aliases"], &home["properties"]["tags"]), (&json!(["Start"]), &json!(["index"])));
    assert_eq!(home["links"][0], json!({ "target": "Plan", "path": "Work/Plan.md", "line": 7 }));
    assert_eq!(home["links"][1], json!({ "target": "Nowhere", "line": 7 }));
    let plan = read!(test, &caller, DescribeNote, json!({ "path": "Plan" })).unwrap();
    assert_eq!(plan["backlinks"], json!([{ "path": "Home.md", "line": 7, "text": "See [[Plan]] and [[Nowhere]]." }]));
    assert_eq!((&plan["tasksOpen"], &plan["tasksDone"]), (&json!(1), &json!(1)));
    assert_eq!(plan["headings"][1], json!({ "level": 2, "text": "Steps", "line": 5 }));

    let tags = read!(test, &caller, ListTags, json!({})).unwrap();
    assert_eq!(tags["tags"][1], json!({ "name": "work", "notes": 2 }));
    let tasks = read!(test, &caller, ListTasks, json!({})).unwrap();
    assert_eq!(tasks["tasks"], json!([{ "path": "Work/Plan.md", "line": 7, "done": false, "text": "Call José" }]));
    let tasks = read!(test, &caller, ListTasks, json!({ "status": "all", "path": "Work" })).unwrap();
    assert_eq!(tasks["total"], 2);
    let problems = read!(test, &caller, ListProblems, json!({ "path": "Home.md" })).unwrap();
    assert_eq!(problems["problems"], json!([{ "path": "Home.md", "line": 7, "kind": "missingNote", "target": "Nowhere" }]));
}

#[tokio::test]
async fn describes_how_notes_relate() {
    let (test, caller) = setup(Access::Read).await;
    test.write(&[("Work/Sync.md", "---\ntype: meeting\nattendees: [\"[[Plan]]\"]\n---\nAbout [[Plan]].\n")]);
    test.until(|| test.backend().workspace().unwrap().index().note("Work/Sync.md").is_some()).await;
    let sync = read!(test, &caller, DescribeNote, json!({ "path": "Work/Sync.md" })).unwrap();
    assert_eq!(sync["type"], "meeting");
    assert_eq!(
        sync["links"],
        json!([
            { "target": "Plan", "path": "Work/Plan.md", "relation": "attendees", "line": 3 },
            { "target": "Plan", "path": "Work/Plan.md", "line": 5 },
        ])
    );
    let plan = read!(test, &caller, DescribeNote, json!({ "path": "Plan" })).unwrap();
    assert_eq!(plan.get("type"), None);
    assert_eq!(
        plan["backlinks"],
        json!([
            { "path": "Home.md", "line": 7, "text": "See [[Plan]] and [[Nowhere]]." },
            { "path": "Work/Sync.md", "line": 3, "text": "attendees: [\"[[Plan]]\"]", "relation": "attendees" },
            { "path": "Work/Sync.md", "line": 5, "text": "About [[Plan]]." },
        ])
    );
}

#[tokio::test]
async fn nothing_is_changed_without_write_access() {
    let (test, caller) = setup(Access::Read).await;
    let create = CreateNote { vault: vault(), path: "New.md".into(), text: "x".into(), reason: None };
    let refused = message(test.server.write(&caller, create, |_| {}, &CancellationToken::new()).await);
    assert!(refused.contains("may only read 'Notes'"), "{refused}");
    assert_eq!(test.events.last_audit().decision, Decision::Denied);
    assert!(test.server.pending_approvals().is_empty() && test.on_disk("New.md").is_none());
}

#[tokio::test]
async fn creates_what_the_user_approves_and_only_that() {
    let (test, caller) = setup(Access::Write).await;
    let new = json!({ "path": "Ideas/New idea", "text": "# New\n", "reason": "you asked" });
    let (outcome, user) = change!(test, &caller, false, CreateNote, new.clone());
    assert!(message(outcome).starts_with("The user rejected this change"));
    assert_eq!((test.events.last_audit().decision, test.on_disk("Ideas/New idea.md")), (Decision::Rejected, None));
    let request = seen(user).await;
    assert_eq!((request.action, request.path.as_str()), (Action::Create, "Ideas/New idea.md"));
    assert_eq!((request.before, request.after.as_deref(), request.reason.as_deref()), (None, Some("# New\n"), Some("you asked")));

    let (outcome, _) = change!(test, &caller, true, CreateNote, new);
    let output = outcome.unwrap();
    assert_eq!(output.path, "Ideas/New idea.md");
    assert_eq!(test.on_disk("Ideas/New idea.md").as_deref(), Some("# New\n"));
    let audit = test.events.last_audit();
    assert_eq!(
        (audit.decision, audit.detail.as_deref(), audit.reason.as_deref()),
        (Decision::Approved, Some("# New\n"), Some("you asked"))
    );
    assert!(audit.approval_wait_ms.is_some());
    let read = read!(test, &caller, ReadNote, json!({ "path": "New idea" })).unwrap();
    assert_eq!(read["revision"].as_str(), output.revision.as_deref());

    for (p, why) in [
        ("Home", "already exists"),
        (".itztli/plugins/evil/main", "hidden"),
        ("../out", "not a path"),
        ("a//b", "not a path"),
        ("", "not a path"),
        ("Work/", "is a folder"),
        ("a [b]", "can't contain"),
        ("a\nb", "can't contain"),
        ("invoice\u{202e}dm", "can't contain"),
        ("Work /x", "can't contain"),
    ] {
        let (outcome, user) = change!(test, &caller, true, CreateNote, json!({ "path": p, "text": "x" }));
        user.abort();
        let refused = message(outcome);
        assert!(refused.contains(why), "{p}: {refused}");
    }
}

#[tokio::test]
async fn edits_parts_of_a_note_and_keeps_what_it_said() {
    let (test, caller) = setup(Access::Write).await;
    let edits = json!({ "path": "Work/Plan.md", "edits": [
        { "oldText": "- [ ] Call José", "newText": "- [x] Call José" },
        { "oldText": "More.", "newText": "More, later.\n\nAnd more." },
    ] });
    let (outcome, user) = change!(test, &caller, true, EditNote, edits);
    outcome.unwrap();
    let request = seen(user).await;
    assert_eq!((request.before.as_deref(), request.warnings.len()), (Some(FILES[1].1), 0));
    let after = FILES[1].1.replace("[ ]", "[x]").replace("More.", "More, later.\n\nAnd more.");
    assert_eq!((request.after.as_deref(), test.on_disk("Work/Plan.md").as_deref()), (Some(after.as_str()), Some(after.as_str())));

    // What it replaced is in the local history, even right after another edit.
    let (outcome, _) = change!(test, &caller, true, AppendToNote, json!({ "path": "Work/Plan", "text": "\nEnd." }));
    outcome.unwrap();
    let history = test.backend().call("history_list", json!({ "path": "Work/Plan.md" })).unwrap();
    let reasons: Vec<&str> = history.as_array().unwrap().iter().map(|r| r["reason"].as_str().unwrap()).collect();
    assert_eq!(reasons, ["mcp", "mcp"]);

    let edit = |old: &str, new: &str, replace_all| json!({ "path": "Work/Plan.md", "edits": [{ "oldText": old, "newText": new, "replaceAll": replace_all }] });
    for (edits, why) in [
        (edit("not there", "x", false), "is not in 'Work/Plan.md'"),
        (edit("##", "#", false), "appears 2 times"),
        (edit("", "x", false), "append_to_note"),
        (edit("Steps", "Steps", false), "changes nothing"),
        (json!({ "path": "Work/Plan.md", "edits": [] }), "no edits"),
        (json!({ "path": "Plan", "edits": [] }), "no edits"),
    ] {
        let (outcome, user) = change!(test, &caller, true, EditNote, edits.clone());
        user.abort();
        let refused = message(outcome);
        assert!(refused.contains(why), "{edits}: {refused}");
    }
    let (outcome, _) = change!(test, &caller, true, EditNote, edit("## ", "### ", true));
    outcome.unwrap();
    assert_eq!(test.on_disk("Work/Plan.md").unwrap().matches("### ").count(), 2);
}

#[tokio::test]
async fn changes_only_the_note_at_that_very_path() {
    let (test, caller) = setup(Access::Write).await;
    // A name a link would follow is not enough to change a note.
    let edits = json!({ "path": "Plan", "edits": [{ "oldText": "Intro", "newText": "x" }] });
    let (outcome, user) = change!(test, &caller, true, EditNote, edits);
    user.abort();
    assert_eq!(message(outcome), "There is no note 'Plan'. Did you mean 'Work/Plan.md', 'Work/Old plan.md'?");
}

#[tokio::test]
async fn adds_to_a_section_and_keeps_the_line_breaks_of_the_note() {
    let (test, caller) = setup(Access::Write).await;
    let add = json!({ "path": "Work/Plan.md", "section": "Steps", "text": "- [ ] Ship it\n" });
    let (outcome, _) = change!(test, &caller, true, AppendToNote, add);
    outcome.unwrap();
    let text = test.on_disk("Work/Plan.md").unwrap();
    assert!(text.contains("- [x] Canción nueva\n- [ ] Ship it\n\n## Later"), "{text}");

    test.write(&[("Windows.md", "# One\r\n\r\ntext\r\n\r\n# Two\r\n")]);
    test.until(|| test.backend().workspace().unwrap().index().note("Windows.md").is_some()).await;
    let add = json!({ "path": "Windows.md", "section": "One", "text": "a\nb" });
    let (outcome, _) = change!(test, &caller, true, AppendToNote, add);
    outcome.unwrap();
    assert_eq!(test.on_disk("Windows.md").unwrap(), "# One\r\n\r\ntext\r\na\r\nb\r\n\r\n# Two\r\n");
    let edits = json!({ "path": "Windows.md", "edits": [{ "oldText": "a\nb", "newText": "c\nd" }] });
    let (outcome, _) = change!(test, &caller, true, EditNote, edits);
    outcome.unwrap();
    assert!(test.on_disk("Windows.md").unwrap().contains("text\r\nc\r\nd\r\n"));

    let (outcome, user) =
        change!(test, &caller, true, AppendToNote, json!({ "path": "Home.md", "section": "Nope", "text": "x" }));
    user.abort();
    assert!(message(outcome).contains("no section 'Nope'"));
}

#[tokio::test]
async fn replaces_a_note_only_if_it_still_says_what_was_read() {
    let (test, caller) = setup(Access::Write).await;
    let long: String = (0..30).map(|n| format!("line {n}\n")).collect();
    test.write(&[("Long.md", &long)]);
    test.until(|| test.backend().workspace().unwrap().index().note("Long.md").is_some()).await;
    let revision = read!(test, &caller, ReadNote, json!({ "path": "Long.md" })).unwrap()["revision"].clone();

    let (outcome, user) =
        change!(test, &caller, false, ReplaceNote, json!({ "path": "Long.md", "text": "x\n", "revision": revision }));
    assert!(outcome.is_err());
    assert_eq!(seen(user).await.warnings, [Warning::RemovesMost]);

    test.write(&[("Long.md", "someone else's\n")]);
    let (outcome, user) =
        change!(test, &caller, true, ReplaceNote, json!({ "path": "Long.md", "text": "x\n", "revision": revision }));
    user.abort();
    assert!(message(outcome).contains("changed since that revision"));
    assert_eq!(test.on_disk("Long.md").as_deref(), Some("someone else's\n"));
}

#[tokio::test]
async fn a_note_changed_while_the_user_decides_is_left_alone() {
    let (test, caller) = setup(Access::Write).await;
    let server = test.server.clone();
    let mut events = test.events.subscribe();
    let folder = test.folder();
    let user = tokio::spawn(async move {
        loop {
            if let McpEvent::ApprovalRequested(request) = events.recv().await.unwrap() {
                std::fs::write(folder.join("Home.md"), "typed meanwhile\n").unwrap();
                server.answer_approval(request.id, true);
                return;
            }
        }
    });
    let edit = args::<EditNote>(json!({ "path": "Home.md", "edits": [{ "oldText": "See", "newText": "Saw" }] }));
    let refused = message(test.server.write(&caller, edit, |_| {}, &CancellationToken::new()).await);
    user.await.unwrap();
    assert!(refused.contains("changed while the change waited"), "{refused}");
    assert_eq!(test.on_disk("Home.md").as_deref(), Some("typed meanwhile\n"));
    let audit = test.events.last_audit();
    assert_eq!((audit.decision, audit.error.is_some()), (Decision::Approved, true));
}

#[tokio::test]
async fn moves_a_note_and_the_links_to_it() {
    let (test, caller) = setup(Access::Write).await;
    let (outcome, user) = change!(test, &caller, true, MoveNote, json!({ "path": "Work/Plan.md", "to": "Archive/Big plan" }));
    let output = outcome.unwrap();
    assert_eq!((output.path.as_str(), &output.relinked[..]), ("Archive/Big plan.md", &["Home.md".to_owned()][..]));
    let request = seen(user).await;
    assert_eq!((request.action, request.to.as_deref()), (Action::Move, Some("Archive/Big plan.md")));
    assert_eq!((&request.affected[..], request.before), (&["Home.md".to_owned()][..], None));
    assert!(test.on_disk("Home.md").unwrap().contains("[[Big plan]]"));
    assert!(test.on_disk("Work/Plan.md").is_none());

    let (outcome, _) = change!(test, &caller, true, MoveNote, json!({ "path": "Home.md", "to": "Work/" }));
    assert_eq!(outcome.unwrap().path, "Work/Home.md");
    let (outcome, _) = change!(test, &caller, true, MoveNote, json!({ "path": "Work/Home.md", "to": "Work/home.md" }));
    assert_eq!(outcome.unwrap().path, "Work/home.md", "changing only its case");
    for (to, why) in [("Work/Old plan.md", "already exists"), ("../x", "not a path"), ("Work/home.md", "already there")] {
        let (outcome, user) = change!(test, &caller, true, MoveNote, json!({ "path": "Work/home.md", "to": to }));
        user.abort();
        let refused = message(outcome);
        assert!(refused.contains(why), "{to}: {refused}");
    }
}

#[tokio::test]
async fn deletes_to_the_trash_and_warns_about_links() {
    let (test, caller) = setup(Access::Write).await;
    let (outcome, user) = change!(test, &caller, true, DeleteNote, json!({ "path": "Work/Plan.md" }));
    outcome.unwrap();
    let request = seen(user).await;
    assert_eq!((request.warnings, request.affected), (vec![Warning::BreaksLinks], vec!["Home.md".to_owned()]));
    assert_eq!((request.before.as_deref(), request.after), (Some(FILES[1].1), None));
    assert!(test.on_disk("Work/Plan.md").is_none());
    let history = test.backend().call("history_list", json!({ "path": "Work/Plan.md" })).unwrap();
    assert_eq!(history[0]["reason"], "delete");

    let (outcome, user) = change!(test, &caller, true, DeleteNote, json!({ "path": "Home.md", "revision": "old" }));
    user.abort();
    assert!(message(outcome).contains("changed since that revision"));
    let (outcome, user) = change!(test, &caller, true, DeleteNote, json!({ "path": "Work" }));
    user.abort();
    assert!(message(outcome).starts_with("There is no note 'Work'"), "folders are not notes");
}

/// A change waiting for the user, and the call that waits.
async fn waiting(
    test: &TestVault,
    caller: &Caller,
) -> (ApprovalRequest, tokio::task::JoinHandle<Result<ChangeOutput, CallError>>) {
    let (server, caller) = (test.server.clone(), caller.clone());
    let mut events = test.events.subscribe();
    let edit = TextEdit { old_text: "See".into(), new_text: "Saw".into(), replace_all: false };
    let call = tokio::spawn(async move {
        let edit = EditNote { vault: "Notes".into(), path: "Home.md".into(), edits: vec![edit], reason: None };
        server.write(&caller, edit, |_| {}, &CancellationToken::new()).await
    });
    let request = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let McpEvent::ApprovalRequested(request) = events.recv().await.unwrap() {
                return request;
            }
        }
    });
    (request.await.expect("a request in time"), call)
}

#[tokio::test]
async fn access_lost_while_the_user_decides_counts() {
    // Lowered, though the answer is yes.
    let (test, caller) = setup(Access::Write).await;
    let (request, call) = waiting(&test, &caller).await;
    test.grant(&caller.client_id, Access::Read);
    assert!(test.server.answer_approval(request.id, true));
    assert!(message(call.await.unwrap()).contains("changed this client's access"));
    assert_eq!(test.on_disk("Home.md").as_deref(), Some(FILES[0].1));

    // Another vault opened.
    test.grant(&caller.client_id, Access::Write);
    let (request, call) = waiting(&test, &caller).await;
    test.open("Other").await;
    assert!(test.server.answer_approval(request.id, true));
    assert!(message(call.await.unwrap()).contains("closed 'Notes'"));

    assert_eq!(test.on_disk("Home.md").as_deref(), Some(FILES[0].1));

    // The same one opened anew, as when the UI reloads, is the same vault.
    test.open("Notes").await;
    let (request, call) = waiting(&test, &caller).await;
    test.open("Notes").await;
    assert!(test.server.answer_approval(request.id, true));
    assert_eq!(call.await.unwrap().unwrap().path, "Home.md");
    assert!(test.on_disk("Home.md").unwrap().contains("Saw [[Plan]]"));
}

#[tokio::test]
async fn taking_access_away_withdraws_what_waits() {
    let (test, caller) = setup(Access::Write).await;
    let (request, call) = waiting(&test, &caller).await;
    let change = json!({ "kind": "setAccess", "id": caller.client_id, "vaultId": test.info().id, "access": null });
    test.server.change(serde_json::from_value(change).unwrap(), |_| false).await.unwrap();
    assert!(message(call.await.unwrap()).contains("access was revoked"));
    assert!(!test.server.answer_approval(request.id, true), "there is nothing to answer any more");
    assert_eq!(test.events.last_audit().decision, Decision::Withdrawn);
}

#[tokio::test]
async fn a_client_cannot_flood_the_user() {
    let (test, caller) = setup(Access::Write).await;
    let mut calls = Vec::new();
    for _ in 0..20 {
        calls.push(waiting(&test, &caller).await.1);
    }
    let edit = args::<EditNote>(json!({ "path": "Home.md", "edits": [{ "oldText": "See", "newText": "Saw" }] }));
    let refused = message(test.server.write(&caller, edit, |_| {}, &CancellationToken::new()).await);
    assert!(refused.contains("already wait"), "{refused}");
    test.server.stop().await;
    for call in calls {
        assert!(message(call.await.unwrap()).contains("was stopped"));
    }
}

#[tokio::test]
async fn nobody_answering_is_a_no() {
    let (test, caller) = setup(Access::Write).await;
    tokio::time::pause();
    let (_, call) = waiting(&test, &caller).await;
    tokio::time::advance(Duration::from_secs(121)).await;
    assert!(message(call.await.unwrap()).starts_with("Nobody approved the change in Itztli within 120s"));
    assert_eq!(test.events.last_audit().decision, Decision::Timeout);
    assert_eq!(test.on_disk("Home.md").as_deref(), Some(FILES[0].1));
}

/// What the user decides in Itztli about asking before each change of a client.
async fn set_approval(test: &TestVault, caller: &Caller, required: bool) {
    let change = json!({ "kind": "setApproval", "id": caller.client_id, "required": required });
    let client = test.server.change(serde_json::from_value(change).unwrap(), |_| true).await.unwrap();
    assert_eq!(client["changesNeedApproval"], required);
}

fn approvals_asked(test: &TestVault) -> usize {
    test.events.all().iter().filter(|e| matches!(e, McpEvent::ApprovalRequested(_))).count()
}

#[tokio::test]
async fn a_client_the_user_lets_go_without_asking_changes_notes_at_once() {
    let (test, caller) = setup(Access::Write).await;
    let (other, _) = test.client("other", Some(Access::Write));
    set_approval(&test, &caller, false).await;
    let vaults = test.server.list_vaults(&caller).await.unwrap().vaults;
    assert_eq!((vaults[0].writes_allowed, vaults[0].changes_need_approval), (true, false));
    assert!(test.server.list_vaults(&other).await.unwrap().vaults[0].changes_need_approval, "only that client");

    // Nobody answers anything: each call returns with its change made.
    macro_rules! at_once {
        ($tool:ty, $args:expr) => {{
            let cancel = CancellationToken::new();
            let call = test.server.write(&caller, args::<$tool>($args), |_| {}, &cancel);
            tokio::time::timeout(Duration::from_secs(10), call).await.expect("made without waiting for anyone")
        }};
    }
    let created = at_once!(CreateNote, json!({ "path": "Ideas/New", "text": "# New\n", "reason": "you asked" })).unwrap();
    assert_eq!((created.path.as_str(), test.on_disk("Ideas/New.md").as_deref()), ("Ideas/New.md", Some("# New\n")));
    let audit = test.events.last_audit();
    assert_eq!((audit.tool.as_str(), audit.decision, audit.approval_wait_ms), ("create_note", Decision::Allowed, None));
    assert_eq!((audit.detail.as_deref(), audit.reason.as_deref(), audit.count), (Some("# New\n"), Some("you asked"), Some(1)));

    at_once!(EditNote, json!({ "path": "Home.md", "edits": [{ "oldText": "See", "newText": "Saw" }] })).unwrap();
    assert!(test.on_disk("Home.md").unwrap().contains("Saw [[Plan]]"));
    let history = test.backend().call("history_list", json!({ "path": "Home.md" })).unwrap();
    assert_eq!(history[0]["reason"], "mcp", "what it replaced is in the local history");
    let moved = at_once!(MoveNote, json!({ "path": "Work/Plan.md", "to": "Archive/Big plan" })).unwrap();
    assert_eq!(moved.relinked, ["Home.md"]);
    at_once!(DeleteNote, json!({ "path": "Work/Old plan.md" })).unwrap();
    assert!(test.on_disk("Work/Old plan.md").is_none());

    // What can't be done is refused as before.
    let refused = message(at_once!(CreateNote, json!({ "path": "Home", "text": "x" })));
    assert!(refused.contains("already exists"), "{refused}");
    assert_eq!(test.events.last_audit().decision, Decision::Denied);

    assert_eq!(approvals_asked(&test), 0);
    assert!(test.server.pending_approvals().is_empty());
    let decisions: Vec<Decision> = test.events.audit().iter().filter(|e| e.tool != "list_vaults").map(|e| e.decision).collect();
    assert_eq!(decisions, [Decision::Allowed, Decision::Allowed, Decision::Allowed, Decision::Allowed, Decision::Denied]);
}

#[tokio::test]
async fn asking_again_counts_from_the_next_call() {
    let (test, caller) = setup(Access::Write).await;
    set_approval(&test, &caller, false).await;
    let (outcome, user) = change!(test, &caller, true, AppendToNote, json!({ "path": "Home.md", "text": "One." }));
    user.abort();
    outcome.unwrap();
    assert_eq!((test.events.last_audit().decision, approvals_asked(&test)), (Decision::Allowed, 0));

    set_approval(&test, &caller, true).await;
    assert!(test.server.list_vaults(&caller).await.unwrap().vaults[0].changes_need_approval);
    let (outcome, user) = change!(test, &caller, false, AppendToNote, json!({ "path": "Home.md", "text": "Two." }));
    assert!(message(outcome).starts_with("The user rejected this change"));
    assert_eq!(seen(user).await.after.unwrap(), format!("{}One.\nTwo.\n", FILES[0].1));
    let audit = test.events.last_audit();
    assert_eq!((audit.decision, audit.approval_wait_ms.is_some()), (Decision::Rejected, true));
    assert_eq!(test.on_disk("Home.md").unwrap(), format!("{}One.\n", FILES[0].1));

    let (outcome, _) = change!(test, &caller, true, AppendToNote, json!({ "path": "Home.md", "text": "Three." }));
    outcome.unwrap();
    let audit = test.events.last_audit();
    assert_eq!((audit.decision, audit.approval_wait_ms.is_some()), (Decision::Approved, true));

    tokio::time::pause();
    let (_, call) = waiting(&test, &caller).await;
    tokio::time::advance(Duration::from_secs(121)).await;
    assert!(message(call.await.unwrap()).starts_with("Nobody approved the change"));
    assert_eq!(test.events.last_audit().decision, Decision::Timeout);
}

#[tokio::test]
async fn not_asking_never_lets_a_client_change_what_it_may_only_read() {
    let (test, caller) = setup(Access::Read).await;
    set_approval(&test, &caller, false).await;
    let vaults = test.server.list_vaults(&caller).await.unwrap().vaults;
    assert_eq!((vaults[0].writes_allowed, vaults[0].changes_need_approval), (false, false));
    let create = CreateNote { vault: vault(), path: "New.md".into(), text: "x".into(), reason: None };
    let refused = message(test.server.write(&caller, create, |_| {}, &CancellationToken::new()).await);
    assert!(refused.contains("may only read 'Notes'"), "{refused}");
    assert_eq!(test.events.last_audit().decision, Decision::Denied);
    assert!(test.on_disk("New.md").is_none() && approvals_asked(&test) == 0);
}
