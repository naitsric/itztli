//! The tools as rmcp publishes them: names, descriptions for the model,
//! schemas and annotations, and each call handed to [`McpServer`] with the
//! [`Caller`] the HTTP layer authenticated. Nothing is decided here.

use std::sync::Arc;

use rmcp::handler::server::tool::{schema_for_input, schema_for_output};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, ContentBlock, Implementation, JsonObject, ProgressNotificationParam, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value as Json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::tools::{ReadTool, WriteTool};
use crate::{
    AppendToNote, CallError, Caller, ChangeOutput, ClientInfo, CreateNote, DeleteNote, DescribeNote, EditNote, INSTRUCTIONS,
    ListNotes, ListProblems, ListTags, ListTasks, ListVaults, ListVaultsOutput, McpServer, MoveNote, Progress, ReadNote,
    ReplaceNote, SearchNotes,
};

const LIST_VAULTS: &str = "List the vaults (folders of notes) the user lets this client use in Itztli: each one's id, \
                           name, whether it is open, whether this client may change notes in it, and whether each \
                           change waits for the user's approval. Start here: the other tools take a vault's id (or its \
                           name, when unique) as `vault`, and only the open one can be used.";
const SEARCH_NOTES: &str = "Search the text of every note and return the matching lines. `mode` says how: `text` (as it \
                            is), `words` (notes that contain every word, anywhere) or `regex`. Case and accents are \
                            ignored unless `matchCase` is true. To find notes by name or tag, use list_notes.";
const LIST_NOTES: &str = "List notes, with their title, tags and length: those in a folder, with a tag, or whose name \
                          looks like `name`; all of them without filters. Sort by `modified` for the latest ones.";
const READ_NOTE: &str = "Read a note's Markdown, whole or only a `section` (a heading with everything under it), up to \
                         64 KB at a time; `truncated` says there is more. The `revision` identifies what it says now.";
const DESCRIBE_NOTE: &str = "Describe a note without its text: title, aliases, tags, properties (frontmatter), headings, \
                             links, backlinks (which notes link to it, with the line) and tasks.";
const LIST_TAGS: &str = "List every tag in the vault and how many notes have it.";
const LIST_TASKS: &str = "List tasks (`- [ ]` and `- [x]`) across the vault, in a folder or in a note. Open ones unless \
                          `status` says otherwise.";
const LIST_PROBLEMS: &str = "List what is wrong in the vault, in a folder or in a note: links that lead nowhere and \
                             frontmatter that is not valid YAML.";
const CREATE_NOTE: &str = "Create a note. Unless the user lets this client change notes without asking, they must \
                           approve it in Itztli: the call waits for them (2 minutes by default), and they may reject it. \
                           Pass `reason` to tell them why. Refused where this client may only read, as every change is.";
const EDIT_NOTE: &str = "Change parts of a note: each edit replaces `oldText`, exactly as the note has it, with \
                         `newText`. The user reviews the difference, and approves it in Itztli unless they let this \
                         client change notes without asking: pass `reason`.";
const APPEND_TO_NOTE: &str = "Add text at the end of a note, or of one of its sections. The user approves it in Itztli \
                              unless they let this client change notes without asking: pass `reason`.";
const REPLACE_NOTE: &str = "Replace all of a note's text; prefer edit_note for changing parts. Takes the `revision` \
                            read_note gave, and is refused if the note changed since. The user reviews the difference, \
                            and approves it in Itztli unless they let this client change notes without asking: pass \
                            `reason`.";
const MOVE_NOTE: &str = "Rename or move a note, and rewrite the links other notes have to it. The user approves it in \
                         Itztli unless they let this client change notes without asking: pass `reason`.";
const DELETE_NOTE: &str = "Move a note to the trash. Links to it are left leading nowhere: describe_note shows them as \
                           backlinks. The user approves it in Itztli unless they let this client change notes without \
                           asking: pass `reason`.";

/// What rmcp serves: one per session, or per request without one.
#[derive(Clone)]
pub(crate) struct Handler {
    server: McpServer,
}

impl Handler {
    pub fn new(server: McpServer) -> Self {
        Self { server }
    }

    async fn read<T: ReadTool>(&self, tool: T, context: RequestContext<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let caller = caller(&context)?;
        reply(self.server.read(&caller, tool, &context.ct).await)
    }

    async fn write<T: WriteTool + Sync>(
        &self,
        tool: T,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let caller = caller(&context)?;
        let (progress, relayed) = relay_progress(&context);
        let outcome = self.server.write(&caller, tool, progress, &context.ct).await;
        // Every report reaches the client before the result does.
        if let Some(relayed) = relayed {
            let _ = relayed.await;
        }
        reply(outcome)
    }
}

#[tool_router]
impl Handler {
    #[tool(
        name = "list_vaults",
        title = "List vaults",
        description = LIST_VAULTS,
        input_schema = input_schema::<ListVaults>(),
        output_schema = output_schema::<ListVaultsOutput>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_vaults(
        &self,
        _: Parameters<ListVaults>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let caller = caller(&context)?;
        reply(self.server.list_vaults(&caller).await)
    }

    #[tool(
        name = "search_notes",
        title = "Search notes",
        description = SEARCH_NOTES,
        input_schema = input_schema::<SearchNotes>(),
        output_schema = output_schema::<<SearchNotes as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn search_notes(
        &self,
        Parameters(tool): Parameters<SearchNotes>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "list_notes",
        title = "List notes",
        description = LIST_NOTES,
        input_schema = input_schema::<ListNotes>(),
        output_schema = output_schema::<<ListNotes as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_notes(
        &self,
        Parameters(tool): Parameters<ListNotes>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "read_note",
        title = "Read a note",
        description = READ_NOTE,
        input_schema = input_schema::<ReadNote>(),
        output_schema = output_schema::<<ReadNote as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn read_note(
        &self,
        Parameters(tool): Parameters<ReadNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "describe_note",
        title = "Describe a note",
        description = DESCRIBE_NOTE,
        input_schema = input_schema::<DescribeNote>(),
        output_schema = output_schema::<<DescribeNote as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn describe_note(
        &self,
        Parameters(tool): Parameters<DescribeNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "list_tags",
        title = "List tags",
        description = LIST_TAGS,
        input_schema = input_schema::<ListTags>(),
        output_schema = output_schema::<<ListTags as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_tags(
        &self,
        Parameters(tool): Parameters<ListTags>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "list_tasks",
        title = "List tasks",
        description = LIST_TASKS,
        input_schema = input_schema::<ListTasks>(),
        output_schema = output_schema::<<ListTasks as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_tasks(
        &self,
        Parameters(tool): Parameters<ListTasks>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "list_problems",
        title = "List problems",
        description = LIST_PROBLEMS,
        input_schema = input_schema::<ListProblems>(),
        output_schema = output_schema::<<ListProblems as ReadTool>::Output>(),
        annotations(read_only_hint = true, idempotent_hint = true, open_world_hint = false)
    )]
    async fn list_problems(
        &self,
        Parameters(tool): Parameters<ListProblems>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.read(tool, context).await
    }

    #[tool(
        name = "create_note",
        title = "Create a note",
        description = CREATE_NOTE,
        input_schema = input_schema::<CreateNote>(),
        output_schema = output_schema::<ChangeOutput>(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn create_note(
        &self,
        Parameters(tool): Parameters<CreateNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.write(tool, context).await
    }

    #[tool(
        name = "edit_note",
        title = "Edit a note",
        description = EDIT_NOTE,
        input_schema = input_schema::<EditNote>(),
        output_schema = output_schema::<ChangeOutput>(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn edit_note(
        &self,
        Parameters(tool): Parameters<EditNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.write(tool, context).await
    }

    #[tool(
        name = "append_to_note",
        title = "Add to a note",
        description = APPEND_TO_NOTE,
        input_schema = input_schema::<AppendToNote>(),
        output_schema = output_schema::<ChangeOutput>(),
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = false, open_world_hint = false)
    )]
    async fn append_to_note(
        &self,
        Parameters(tool): Parameters<AppendToNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.write(tool, context).await
    }

    #[tool(
        name = "replace_note",
        title = "Replace a note's text",
        description = REPLACE_NOTE,
        input_schema = input_schema::<ReplaceNote>(),
        output_schema = output_schema::<ChangeOutput>(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn replace_note(
        &self,
        Parameters(tool): Parameters<ReplaceNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.write(tool, context).await
    }

    #[tool(
        name = "move_note",
        title = "Rename or move a note",
        description = MOVE_NOTE,
        input_schema = input_schema::<MoveNote>(),
        output_schema = output_schema::<ChangeOutput>(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn move_note(
        &self,
        Parameters(tool): Parameters<MoveNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.write(tool, context).await
    }

    #[tool(
        name = "delete_note",
        title = "Delete a note",
        description = DELETE_NOTE,
        input_schema = input_schema::<DeleteNote>(),
        output_schema = output_schema::<ChangeOutput>(),
        annotations(read_only_hint = false, destructive_hint = true, idempotent_hint = false, open_world_hint = false)
    )]
    async fn delete_note(
        &self,
        Parameters(tool): Parameters<DeleteNote>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.write(tool, context).await
    }
}

#[tool_handler]
impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("Itztli", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

/// The caller the HTTP layer authenticated, completed with what this
/// request declares about the client: in its `_meta` (protocol 2026-07-28),
/// or else in the `initialize` of its session, which rmcp keeps.
fn caller(context: &RequestContext<RoleServer>) -> Result<Caller, ErrorData> {
    let parts = context.extensions.get::<http::request::Parts>();
    let Some(mut caller) = parts.and_then(|parts| parts.extensions.get::<Caller>()).cloned() else {
        return Err(ErrorData::internal_error("Itztli received a tool call without an authenticated client", None));
    };
    // Outside a session rmcp has no `initialize` to fall back on, and would
    // offer its own name instead.
    let in_session = parts.is_some_and(|parts| parts.headers.contains_key("mcp-session-id"));
    let declared = context.meta.client_info().or_else(|| {
        let session = context.peer.peer_info().filter(|_| in_session)?;
        Some(session.client_info.clone())
    });
    caller.client_info =
        declared.map(|info| ClientInfo { name: info.name, version: Some(info.version).filter(|version| !version.is_empty()) });
    caller.protocol_version = context.protocol_version().map(|version| version.to_string());
    Ok(caller)
}

/// A call's result for the model: its JSON as structured content and as
/// text. A tool error is a result the model reads (`isError`); an internal
/// error is a JSON-RPC error.
fn reply<T: Serialize>(outcome: Result<T, CallError>) -> Result<CallToolResult, ErrorData> {
    match outcome {
        Ok(output) => match serde_json::to_value(output) {
            Ok(json) => Ok(CallToolResult::structured(json)),
            Err(e) => Err(ErrorData::internal_error(format!("Itztli could not encode the result: {e}"), None)),
        },
        Err(CallError::Tool(error)) => Ok(CallToolResult::error(vec![ContentBlock::text(error.message)])),
        Err(CallError::Internal(error)) => Err(ErrorData::internal_error(error.to_string(), None)),
    }
}

/// A tool's arguments schema: rmcp's, from the core's type.
fn input_schema<T: JsonSchema + 'static>() -> Arc<JsonObject> {
    let schema = schema_for_input::<T>().unwrap_or_else(|e| panic!("{}: {e}", std::any::type_name::<T>()));
    portable(&schema)
}

/// A tool's result schema: rmcp's, from the core's type.
fn output_schema<T: JsonSchema + 'static>() -> Arc<JsonObject> {
    portable(&schema_for_output::<T>())
}

/// `schema` without the integer formats schemars adds (`uint64`…): JSON
/// Schema defines none of them, and clients' validators warn about or
/// refuse them. The bounds they imply stay, as `minimum` and `maximum`.
fn portable(schema: &JsonObject) -> Arc<JsonObject> {
    fn strip(value: &mut Json) {
        match value {
            Json::Object(object) => {
                let format = object.get("format").and_then(Json::as_str);
                if format.is_some_and(|format| NUMBER_FORMATS.contains(&format)) {
                    object.remove("format");
                }
                object.values_mut().for_each(strip);
            }
            Json::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    const NUMBER_FORMATS: [&str; 12] =
        ["int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float", "double"];
    let mut schema = Json::Object(schema.clone());
    strip(&mut schema);
    let Json::Object(schema) = schema else { unreachable!("still an object") };
    Arc::new(schema)
}

/// A progress callback for the core that sends each report to the client as
/// a progress notification, when the request asked for them with a
/// `progressToken`; and the task sending them, which ends once the callback
/// is dropped and every report was sent.
fn relay_progress(context: &RequestContext<RoleServer>) -> (impl Fn(Progress) + Send + Sync + 'static, Option<JoinHandle<()>>) {
    let (sender, relayed) = match context.meta.get_progress_token() {
        None => (None, None),
        Some(token) => {
            let (sender, mut reports) = mpsc::unbounded_channel::<Progress>();
            let peer = context.peer.clone();
            let relayed = tokio::spawn(async move {
                while let Some(report) = reports.recv().await {
                    let notification = ProgressNotificationParam::new(token.clone(), report.waited_secs as f64)
                        .with_total(report.timeout_secs as f64)
                        .with_message(report.message);
                    // Fails only once the client is gone, and nobody waits for it.
                    let _ = peer.notify_progress(notification).await;
                }
            });
            (Some(sender), Some(relayed))
        }
    };
    let callback = move |report| {
        if let Some(sender) = &sender {
            let _ = sender.send(report);
        }
    };
    (callback, relayed)
}

#[cfg(test)]
mod tests {
    use rmcp::model::ErrorCode;
    use serde_json::{Value as Json, json};

    use super::*;
    use crate::{Error, ToolError};

    fn text(result: &CallToolResult) -> &str {
        &result.content[0].as_text().expect("text content").text
    }

    #[test]
    fn results_carry_their_json_as_structured_content_and_as_text() {
        let output = ChangeOutput { path: "a.md".into(), revision: Some("r".into()), ..ChangeOutput::default() };
        let result = reply(Ok(output)).unwrap();
        assert_eq!(result.is_error, Some(false));
        let structured = result.structured_content.clone().unwrap();
        assert_eq!(structured, json!({ "path": "a.md", "revision": "r" }));
        assert_eq!(serde_json::from_str::<Json>(text(&result)).unwrap(), structured);
    }

    #[test]
    fn tool_errors_are_results_and_internal_errors_are_protocol_errors() {
        let refused = reply::<ChangeOutput>(Err(ToolError::new("Read it again.").into())).unwrap();
        assert_eq!((refused.is_error, text(&refused)), (Some(true), "Read it again."));
        assert_eq!(refused.structured_content, None);

        let failed = reply::<ChangeOutput>(Err(Error::Internal("the store is locked".into()).into())).unwrap_err();
        assert_eq!((failed.code, failed.message.as_ref()), (ErrorCode::INTERNAL_ERROR, "the store is locked"));
    }

    #[test]
    fn schemas_keep_only_formats_json_schema_defines() {
        let schema = json!({
            "type": "object",
            "properties": {
                "total": { "type": "integer", "format": "uint64", "minimum": 0 },
                "limit": { "type": ["integer", "null"], "format": "uint32", "minimum": 1, "maximum": 1000 },
                "at": { "type": "string", "format": "date-time" },
                "format": { "type": "string" },
            },
            "$defs": { "Entry": { "anyOf": [{ "type": "number", "format": "double" }] } },
        });
        let Json::Object(schema) = schema else { unreachable!() };
        let expected = json!({
            "type": "object",
            "properties": {
                "total": { "type": "integer", "minimum": 0 },
                "limit": { "type": ["integer", "null"], "minimum": 1, "maximum": 1000 },
                "at": { "type": "string", "format": "date-time" },
                "format": { "type": "string" },
            },
            "$defs": { "Entry": { "anyOf": [{ "type": "number" }] } },
        });
        assert_eq!(Json::Object(portable(&schema).as_ref().clone()), expected);

        let search = Json::Object(input_schema::<SearchNotes>().as_ref().clone());
        assert_eq!(search["properties"]["limit"]["maximum"], 1000, "{search}");
        assert!(!search.to_string().contains("\"format\""), "{search}");
    }

    #[test]
    fn every_tool_is_published_under_the_name_the_audit_records() {
        let mut names: Vec<String> = Handler::tool_router().list_all().into_iter().map(|t| t.name.to_string()).collect();
        names.sort();
        let mut expected = vec![
            "list_vaults",
            SearchNotes::NAME,
            ListNotes::NAME,
            ReadNote::NAME,
            DescribeNote::NAME,
            ListTags::NAME,
            ListTasks::NAME,
            ListProblems::NAME,
            CreateNote::NAME,
            EditNote::NAME,
            AppendToNote::NAME,
            ReplaceNote::NAME,
            MoveNote::NAME,
            DeleteNote::NAME,
        ];
        expected.sort();
        assert_eq!(names, expected);
        for name in expected {
            assert!(INSTRUCTIONS.contains(name) || name.starts_with("list_"), "{name}");
        }
    }
}
