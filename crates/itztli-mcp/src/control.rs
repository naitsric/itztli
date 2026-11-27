//! What the UI sees and does about the server.
//!
//! Plugins run in the UI's page, so whatever the page may ask for, a plugin
//! may too. What widens what programs outside Itztli can do (turning the
//! server on, giving a client access or a new token, letting it change notes
//! without asking) is therefore a [`Change`] that comes with a [`Question`],
//! which the host puts to the user in a dialog of the system's before
//! anything happens.
//!
//! Answering an approval is not one of those: it lets a client change a note
//! of the open vault, which a plugin can do by itself.

use itztli_backend::{CommandError, CommandResult, ErrorCode, VaultInfo, printable};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::store::AuditFilter;
use crate::{Access, Error, Grant, MCP_PATH, McpClient, McpServer, McpSettings, ServerStatus, new_token, settings};

/// Most audit rows the UI may ask for at once.
const MAX_PAGE: u32 = 1000;
/// Longest client name, in characters.
const MAX_NAME: usize = 80;

/// Something the user changes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Change {
    /// Saves the settings; the server starts, restarts or stops to match.
    Settings {
        settings: McpSettings,
    },
    /// Registers a client, perhaps with access to a vault, and perhaps
    /// turning the server on.
    CreateClient {
        name: String,
        #[serde(default)]
        access: Option<AccessTo>,
        #[serde(default)]
        turn_on: bool,
    },
    RenameClient {
        id: String,
        name: String,
    },
    /// A new token; the old one stops working.
    RotateClient {
        id: String,
    },
    RevokeClient {
        id: String,
    },
    DeleteClient {
        id: String,
    },
    /// What a client may do in a vault; nothing when `access` is None.
    SetAccess {
        id: String,
        vault_id: String,
        access: Option<Access>,
    },
    /// Whether each change the client makes waits for the user's approval.
    /// Never lets it change a vault it may only read.
    SetApproval {
        id: String,
        required: bool,
    },
}

/// The vault is named, rather than whichever is open: what the user agrees
/// to is what happens, even if another one opened while they read.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessTo {
    pub vault_id: String,
    pub access: Access,
}

/// What to ask the user before a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub message: String,
    /// The button that agrees.
    pub yes: &'static str,
}

/// Where clients reach the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// At the port it listens on, else the saved one.
    pub url: String,
    pub bridge_command: Option<String>,
}

#[derive(Deserialize)]
struct AuditArgs {
    filter: AuditFilter,
}

#[derive(Deserialize)]
struct AnswerArgs {
    id: u64,
    approve: bool,
}

impl From<Error> for CommandError {
    fn from(e: Error) -> Self {
        match e {
            Error::InvalidSettings(message) => Self::invalid(format!("Invalid MCP settings: {message}.")),
            e => Self::new(ErrorCode::Io, e.to_string()),
        }
    }
}

impl From<crate::store::Error> for CommandError {
    fn from(e: crate::store::Error) -> Self {
        Error::from(e).into()
    }
}

fn args<T: serde::de::DeserializeOwned>(value: Value) -> CommandResult<T> {
    serde_json::from_value(value).map_err(|e| CommandError::invalid(e.to_string()))
}

fn ok(value: impl Serialize) -> CommandResult<Value> {
    serde_json::to_value(value).map_err(|e| CommandError::invalid(e.to_string()))
}

fn no_client() -> CommandError {
    CommandError::new(ErrorCode::NotFound, "That MCP client does not exist.")
}

fn client_name(name: &str) -> CommandResult<String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(MAX_NAME).collect();
    if name.is_empty() { Err(CommandError::invalid("A client needs a name.")) } else { Ok(name) }
}

const MAY_WRITE: &str = "It will also be able to propose changes. Each one waits for your approval in Itztli.";
const MAY_WRITE_UNASKED: &str =
    "It will also be able to change notes, at once: you turned off approval of its changes in Itztli.";

impl McpServer {
    /// What the UI may do without asking anyone: look, and answer approvals.
    pub fn command(&self, command: &str, value: Value) -> CommandResult<Value> {
        let store = self.store();
        match command {
            "status" => ok(self.status()),
            "settings" => ok(self.settings()?),
            "clients" => ok(store.clients()?),
            "audit" => {
                let AuditArgs { filter } = args(value)?;
                ok(store.audit(&AuditFilter { limit: filter.limit.min(MAX_PAGE), ..filter })?)
            }
            "approvals" => ok(self.pending_approvals()),
            "answer" => {
                let AnswerArgs { id, approve } = args(value)?;
                ok(self.answer_approval(id, approve))
            }
            "endpoint" => {
                let port = match self.status().port {
                    Some(port) => port,
                    None => self.settings()?.port,
                };
                // An IP, not `localhost`, which may resolve to `::1` first.
                let url = format!("http://127.0.0.1:{port}{MCP_PATH}");
                ok(Endpoint { url, bridge_command: self.0.host.bridge_command() })
            }
            _ => Err(CommandError::invalid(format!("there is no MCP command “{command}”"))),
        }
    }

    /// Makes a change, once the user agreed to it when it takes asking.
    /// `ask` may block. The result is null when the user said no.
    pub async fn change(&self, change: Change, ask: impl FnOnce(Question) -> bool + Send + 'static) -> CommandResult<Value> {
        let question = self.question(&change)?;
        let asked = question.is_some();
        if let Some(question) = question {
            let agreed = tokio::task::spawn_blocking(move || ask(question)).await;
            if !agreed.map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))? {
                return Ok(Value::Null);
            }
        }
        let _one_at_a_time = self.0.changing.lock().await;
        // Another change may have made this one take asking.
        if !asked && self.question(&change)?.is_some() {
            return Err(CommandError::new(ErrorCode::Conflict, "Something else changed meanwhile. Try again."));
        }
        self.apply(change).await
    }

    /// Starts listening, if the user turned the server on.
    pub async fn start_if_enabled(&self) {
        match self.settings() {
            // A failure is in the status, where the UI reads it.
            Ok(settings) if settings.enabled => drop(self.start(&settings).await),
            Ok(_) => {}
            Err(e) => eprintln!("MCP server not started: {e}"),
        }
    }

    fn question(&self, change: &Change) -> CommandResult<Option<Question>> {
        Ok(match change {
            Change::Settings { settings } => (settings.enabled && !self.settings()?.enabled).then(|| turn_on(settings.port)),
            Change::CreateClient { name, access, turn_on: on } => {
                let name = client_name(name)?;
                let settings = self.settings()?;
                let starts = *on && !settings.enabled;
                match access {
                    Some(to) => {
                        // A new client asks before each change.
                        let mut question = give_access(&name, &self.0.vault(&to.vault_id)?, to.access, true);
                        if starts {
                            question.message.push_str(&format!("\n\n{}", listens(settings.port)));
                        }
                        Some(question)
                    }
                    None => starts.then(|| turn_on(settings.port)),
                }
            }
            Change::RotateClient { id } => {
                let client = self.client(id)?;
                Some(Question {
                    title: format!("Make a new token for “{}”?", printable(&client.name)),
                    message: "The current one stops working at once, and changes it proposed that wait for your approval \
                              are withdrawn. The program needs the new token to connect again."
                        .into(),
                    yes: "Make New Token",
                })
            }
            Change::SetAccess { id, vault_id, access: Some(access) } => {
                let client = self.client(id)?;
                let has = client.grants.iter().find(|g| g.vault_id == *vault_id).map(|g| g.access);
                let vault = self.0.vault(vault_id)?;
                (has < Some(*access)).then(|| give_access(&client.name, &vault, *access, client.changes_need_approval))
            }
            Change::SetApproval { id, required: false } => {
                let client = self.client(id)?;
                client.changes_need_approval.then(|| stop_asking(&client))
            }
            // Nobody gets to do more than before.
            Change::SetApproval { required: true, .. }
            | Change::SetAccess { access: None, .. }
            | Change::RenameClient { .. }
            | Change::RevokeClient { .. }
            | Change::DeleteClient { .. } => None,
        })
    }

    async fn apply(&self, change: Change) -> CommandResult<Value> {
        let core = &self.0;
        match change {
            Change::Settings { settings } => {
                self.save_settings(&settings).await?;
                ok(self.status())
            }
            Change::CreateClient { name, access, turn_on } => {
                let name = client_name(&name)?;
                let grant = access.map(|to| Ok::<_, CommandError>(grant(&core.vault(&to.vault_id)?, to.access))).transpose()?;
                let (token, hash, prefix) = new_token();
                let client = core.store.create_client(&name, &hash, &prefix, grant.as_ref())?;
                if turn_on {
                    let settings = self.settings()?;
                    self.save_settings(&McpSettings { enabled: true, ..settings }).await?;
                }
                ok(json!({ "client": client, "token": token }))
            }
            Change::RenameClient { id, name } => {
                ok(core.store.rename_client(&id, &client_name(&name)?)?.ok_or_else(no_client)?)
            }
            Change::RotateClient { id } => {
                let (token, hash, prefix) = new_token();
                let client = core.store.rotate_client(&id, &hash, &prefix)?.ok_or_else(no_client)?;
                core.approvals.withdraw_client(&id, None);
                ok(json!({ "client": client, "token": token }))
            }
            Change::RevokeClient { id } => {
                let client = core.store.revoke_client(&id)?.ok_or_else(no_client)?;
                core.approvals.withdraw_client(&id, None);
                ok(client)
            }
            Change::DeleteClient { id } => {
                core.store.delete_client(&id)?;
                core.approvals.withdraw_client(&id, None);
                Ok(Value::Null)
            }
            Change::SetAccess { id, vault_id, access } => {
                let client = match access {
                    Some(access) => core.store.set_grant(&id, &grant(&core.vault(&vault_id)?, access))?,
                    None => core.store.remove_grant(&id, &vault_id)?,
                };
                if access != Some(Access::Write) {
                    core.approvals.withdraw_client(&id, Some(&vault_id));
                }
                ok(client.ok_or_else(no_client)?)
            }
            // Asking again holds back no change: one made without asking
            // was made at once.
            Change::SetApproval { id, required } => ok(core.store.set_approval(&id, required)?.ok_or_else(no_client)?),
        }
    }

    fn client(&self, id: &str) -> CommandResult<McpClient> {
        self.store().client(id)?.ok_or_else(no_client)
    }

    /// Saves the settings and brings the server in line with them.
    async fn save_settings(&self, settings: &McpSettings) -> CommandResult<()> {
        settings::save(self.store(), settings)?;
        match reconcile(&self.status(), settings) {
            // A failure is in the status, where the UI reads it.
            Reconcile::Start => drop(self.start(settings).await),
            Reconcile::Stop => self.stop().await,
            Reconcile::Keep => {}
        }
        Ok(())
    }
}

impl crate::Core {
    /// A vault the user opened.
    fn vault(&self, id: &str) -> CommandResult<VaultInfo> {
        if let Ok(open) = self.host.backend().workspace()
            && open.info.id == id
        {
            return Ok(open.info.clone());
        }
        let recent = self.host.backend().recents().into_iter().find(|r| r.id == id);
        let recent = recent.ok_or_else(|| CommandError::new(ErrorCode::NotFound, "That vault is not in the list."))?;
        Ok(VaultInfo { id: recent.id, name: recent.name, path: recent.path })
    }
}

fn grant(vault: &VaultInfo, access: Access) -> Grant {
    let vault_path = vault.path.display().to_string();
    Grant { vault_id: vault.id.clone(), vault_name: vault.name.clone(), vault_path, access }
}

fn listens(port: u16) -> String {
    format!("The MCP server will be turned on. It listens on 127.0.0.1:{port}, which only programs on this computer can reach.")
}

fn turn_on(port: u16) -> Question {
    Question {
        title: "Turn the MCP server on?".into(),
        message: format!("{} Those holding a client's token can use the vaults you give it access to.", listens(port)),
        yes: "Turn On",
    }
}

/// `asks`: whether the client's changes wait for the user's approval.
fn give_access(client: &str, vault: &VaultInfo, access: Access, asks: bool) -> Question {
    let mut message = format!(
        "It will be able to read every note in this vault, and may send what it reads to the service behind it.\n{}",
        vault.path.display().to_string().replace(char::is_control, "")
    );
    if access == Access::Write {
        message.push_str(&format!("\n\n{}", if asks { MAY_WRITE } else { MAY_WRITE_UNASKED }));
    }
    Question { title: format!("Let “{}” use “{}”?", printable(client), printable(&vault.name)), message, yes: "Allow" }
}

fn stop_asking(client: &McpClient) -> Question {
    let writes: Vec<String> =
        client.grants.iter().filter(|g| g.access == Access::Write).map(|g| format!("“{}”", printable(&g.vault_name))).collect();
    let where_ = if writes.is_empty() {
        "It may not change any vault now. Once you let it write in one, its changes there will be made at once, without \
         waiting for your approval."
            .to_owned()
    } else {
        format!("Its changes to {} will be made at once, without waiting for your approval.", writes.join(", "))
    };
    Question {
        title: format!("Let “{}” change notes without asking?", printable(&client.name)),
        message: format!(
            "{where_} An assistant can be misled by what it reads, and nothing will stop what it then changes.\n\n\
             Each change is still recorded in the activity log, and what it replaces is kept in Local History. Vaults it \
             may only read stay that way."
        ),
        yes: "Don't Ask",
    }
}

/// What saving the settings does to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reconcile {
    /// Start listening, or listen again on another port.
    Start,
    Stop,
    /// Leave it as it is: the other settings apply from the next tool call.
    Keep,
}

/// Turned on, the server must listen on the saved port: it starts if it is
/// not listening (also after failing to) and restarts on a new port. Turned
/// off, it stops if it listens, and a start error is cleared.
fn reconcile(status: &ServerStatus, settings: &McpSettings) -> Reconcile {
    if !settings.enabled {
        return if status.running || status.error.is_some() { Reconcile::Stop } else { Reconcile::Keep };
    }
    if !status.running || status.port != Some(settings.port) {
        return Reconcile::Start;
    }
    Reconcile::Keep
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestVault;

    async fn change(test: &TestVault, value: Value, agree: bool) -> (CommandResult<Value>, Option<Question>) {
        let change: Change = serde_json::from_value(value).unwrap();
        let asked = std::sync::Arc::new(std::sync::Mutex::new(None));
        let heard = asked.clone();
        let result = test
            .server
            .change(change, move |question| {
                *heard.lock().unwrap() = Some(question);
                agree
            })
            .await;
        let question = asked.lock().unwrap().take();
        (result, question)
    }

    #[tokio::test]
    async fn what_widens_access_is_asked_and_the_rest_is_not() {
        let test = TestVault::new(&[]).await;
        let vault = test.info().id;

        let (created, asked) = change(&test, json!({ "kind": "createClient", "name": " claude\u{7}-code " }), false).await;
        let created = created.unwrap();
        assert_eq!((created["client"]["name"].as_str(), asked), (Some("claude-code"), None), "it has no access yet");
        let id = created["client"]["id"].as_str().unwrap().to_owned();
        let access = |level: Value| json!({ "kind": "setAccess", "id": id, "vaultId": vault, "access": level });

        let (refused, asked) = change(&test, access(json!("read")), false).await;
        assert_eq!(refused.unwrap(), Value::Null);
        let asked = asked.unwrap();
        assert_eq!(asked.title, format!("Let “claude-code” use “{}”?", test.info().name));
        assert!(asked.message.contains(&test.info().path.display().to_string()) && !asked.message.contains(MAY_WRITE));
        assert!(test.server.store().client(&id).unwrap().unwrap().grants.is_empty());

        let (given, _) = change(&test, access(json!("read")), true).await;
        assert_eq!(given.unwrap()["grants"][0]["access"], "read");
        let (_, asked) = change(&test, access(json!("read")), true).await;
        assert_eq!(asked, None, "it already could");
        let (_, asked) = change(&test, access(json!("write")), true).await;
        assert!(asked.unwrap().message.contains(MAY_WRITE));

        for quiet in [
            access(json!("read")),
            access(Value::Null),
            json!({ "kind": "renameClient", "id": id, "name": "renamed" }),
            json!({ "kind": "revokeClient", "id": id }),
            json!({ "kind": "deleteClient", "id": id }),
        ] {
            let (result, asked) = change(&test, quiet.clone(), false).await;
            assert!(result.is_ok() && asked.is_none(), "{quiet}: {result:?}");
        }
    }

    #[tokio::test]
    async fn a_client_can_be_made_with_access_and_the_server_on_in_one_question() {
        let test = TestVault::new(&[]).await;
        test.free_port();
        let access = json!({ "vaultId": test.info().id, "access": "write" });
        let create = json!({ "kind": "createClient", "name": "c", "access": access, "turnOn": true });

        let (refused, asked) = change(&test, create.clone(), false).await;
        assert_eq!(refused.unwrap(), Value::Null);
        let asked = asked.unwrap();
        assert!(asked.message.contains(MAY_WRITE) && asked.message.contains("127.0.0.1"), "{asked:?}");
        assert!(test.server.store().clients().unwrap().is_empty() && !test.server.status().running);

        let (created, _) = change(&test, create, true).await;
        let created = created.unwrap();
        assert_eq!(created["client"]["grants"][0]["access"], "write");
        assert!(created["token"].as_str().unwrap().starts_with("itztli_"));
        assert!(test.server.status().running && test.server.settings().unwrap().enabled);
        test.server.stop().await;
    }

    #[tokio::test]
    async fn access_is_to_the_vault_the_user_was_asked_about() {
        let test = TestVault::new(&[]).await;
        let asked_about = test.info();
        let access = json!({ "vaultId": asked_about.id, "access": "read" });
        let create = serde_json::from_value(json!({ "kind": "createClient", "name": "c", "access": access })).unwrap();
        // Another vault opens while they read the question.
        let (answer, answered) = std::sync::mpsc::channel();
        let server = test.server.clone();
        let change = tokio::spawn(async move { server.change(create, move |_| answered.recv().unwrap()).await });
        tokio::task::yield_now().await;
        let other = test.open("Other").await;
        answer.send(true).unwrap();
        let created = change.await.unwrap().unwrap();
        assert_eq!(created["client"]["grants"][0]["vaultId"], json!(asked_about.id));
        assert_ne!(asked_about.id, other.id);
    }

    #[tokio::test]
    async fn turning_on_is_asked_and_off_is_not() {
        let test = TestVault::new(&[]).await;
        let settings = test.free_port();
        let set = |enabled| json!({ "kind": "settings", "settings": McpSettings { enabled, ..settings.clone() } });
        let (refused, asked) = change(&test, set(true), false).await;
        assert_eq!((refused.unwrap(), asked.unwrap().yes), (Value::Null, "Turn On"));
        assert!(!test.server.settings().unwrap().enabled);

        let (status, _) = change(&test, set(true), true).await;
        assert_eq!(status.unwrap()["running"], true);
        let (_, asked) = change(&test, set(true), true).await;
        assert_eq!(asked, None, "it is on already");
        let (status, asked) = change(&test, set(false), false).await;
        assert_eq!((status.unwrap()["running"].clone(), asked), (json!(false), None));
    }

    #[tokio::test]
    async fn a_new_token_is_asked_for_and_never_shown_again() {
        let test = TestVault::new(&[]).await;
        let (caller, old) = test.client("c", Some(Access::Read));
        let rotate = json!({ "kind": "rotateClient", "id": caller.client_id });
        let (refused, asked) = change(&test, rotate.clone(), false).await;
        assert!(refused.unwrap().is_null() && asked.is_some());
        assert!(test.server.authenticate(&old).unwrap().is_some());

        let (rotated, _) = change(&test, rotate, true).await;
        let token = rotated.unwrap()["token"].as_str().unwrap().to_owned();
        assert!(test.server.authenticate(&old).unwrap().is_none());
        assert!(test.server.authenticate(&token).unwrap().is_some());
        let shown = test.server.command("clients", json!({})).unwrap().to_string();
        assert!(!shown.contains(&token), "{shown}");
    }

    #[tokio::test]
    async fn commands_cannot_change_who_may_do_what() {
        let test = TestVault::new(&[]).await;
        for command in ["change", "apply", "settings_save", "createClient", "mcp_client_create"] {
            assert!(test.server.command(command, json!({})).is_err(), "{command}");
        }
        assert_eq!(test.server.command("settings", json!({})).unwrap()["enabled"], false);
        let endpoint = test.server.command("endpoint", json!({})).unwrap();
        assert_eq!(endpoint["url"], "http://127.0.0.1:7413/mcp");
    }

    #[tokio::test]
    async fn access_is_only_to_vaults_the_user_opened() {
        let test = TestVault::new(&[]).await;
        let (caller, _) = test.client("c", None);
        let set = json!({ "kind": "setAccess", "id": caller.client_id, "vaultId": "ffffffffffffffff", "access": "read" });
        let (result, asked) = change(&test, set, true).await;
        assert!(result.is_err() && asked.is_none());
    }

    #[tokio::test]
    async fn not_asking_before_changes_is_asked_and_asking_again_is_not() {
        let test = TestVault::new(&[]).await;
        let (caller, _) = test.client("claude", Some(Access::Write));
        let id = caller.client_id;
        let approval = |required: bool| json!({ "kind": "setApproval", "id": id, "required": required });

        let (refused, asked) = change(&test, approval(false), false).await;
        assert_eq!(refused.unwrap(), Value::Null);
        let asked = asked.unwrap();
        assert_eq!((asked.title.as_str(), asked.yes), ("Let “claude” change notes without asking?", "Don't Ask"));
        assert!(asked.message.contains(&format!("Its changes to “{}” will be made at once", test.info().name)), "{asked:?}");
        assert!(test.server.store().client(&id).unwrap().unwrap().changes_need_approval);

        let (stopped, _) = change(&test, approval(false), true).await;
        assert_eq!(stopped.unwrap()["changesNeedApproval"], false);
        let (_, asked) = change(&test, approval(false), true).await;
        assert_eq!(asked, None, "it already doesn't ask");

        // Writing somewhere else is asked knowing that.
        let other = test.open("Other").await;
        let write = json!({ "kind": "setAccess", "id": id, "vaultId": other.id, "access": "write" });
        let (_, asked) = change(&test, write, false).await;
        assert!(asked.unwrap().message.contains(MAY_WRITE_UNASKED));

        let (asking, asked) = change(&test, approval(true), false).await;
        assert_eq!((asking.unwrap()["changesNeedApproval"].clone(), asked), (json!(true), None));
        let (missing, _) = change(&test, json!({ "kind": "setApproval", "id": "nobody", "required": false }), true).await;
        assert!(missing.is_err());
    }

    #[tokio::test]
    async fn not_asking_a_client_that_may_write_nowhere_says_so() {
        let test = TestVault::new(&[]).await;
        let (caller, _) = test.client("reader", Some(Access::Read));
        let set = json!({ "kind": "setApproval", "id": caller.client_id, "required": false });
        let (_, asked) = change(&test, set, false).await;
        assert!(asked.unwrap().message.starts_with("It may not change any vault now."));
    }

    #[test]
    fn a_name_cannot_write_the_question() {
        let vault = VaultInfo { id: "v".into(), name: "Notes\n\nIt is safe".into(), path: "/n".into() };
        let question = give_access("x\n\nClick Allow", &vault, Access::Read, true);
        assert!(!question.title.contains('\n'), "{question:?}");
    }

    #[test]
    fn the_server_follows_its_settings() {
        let on = |port| McpSettings { enabled: true, port, ..McpSettings::default() };
        let running = ServerStatus { running: true, port: Some(7413), ..ServerStatus::default() };
        let failed = ServerStatus { error: Some("in use".into()), ..ServerStatus::default() };
        let stopped = ServerStatus::default();
        assert_eq!(reconcile(&stopped, &on(7413)), Reconcile::Start);
        assert_eq!(reconcile(&failed, &on(7413)), Reconcile::Start);
        assert_eq!(reconcile(&running, &on(7500)), Reconcile::Start);
        assert_eq!(reconcile(&running, &on(7413)), Reconcile::Keep);
        assert_eq!(reconcile(&running, &McpSettings::default()), Reconcile::Stop);
        assert_eq!(reconcile(&failed, &McpSettings::default()), Reconcile::Stop);
        assert_eq!(reconcile(&stopped, &McpSettings::default()), Reconcile::Keep);
    }
}
