//! What the server remembers, in an SQLite file of its own: its settings,
//! the registered clients (only a hash of each token), what each one may do
//! per vault, and the audit log of tool calls.
//!
//! Timestamps are UTC, RFC 3339 with milliseconds.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, Value, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::token::random_id;

#[derive(Debug, thiserror::Error)]
#[error("the MCP store: {0}")]
pub struct Error(#[from] rusqlite::Error);

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Audit rows kept; older ones are pruned on insert.
const AUDIT_RETENTION: usize = 20_000;

// Longest text an audit row keeps per field, in bytes. Longer values are cut
// on a char boundary; only a cut detail is flagged (`detail_truncated`).
const MAX_DETAIL: usize = 100 * 1024;
const MAX_ERROR: usize = 16 * 1024;
const MAX_REASON: usize = 4 * 1024;
const MAX_PATH: usize = 1024;
/// Every other field: names, versions, ids, keys.
const MAX_SHORT: usize = 256;

/// What a client may do in a vault. Changes also need the user's approval
/// each time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Write,
}

/// Vaults are remembered by name and path too, to show grants on ones the
/// app no longer lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub vault_id: String,
    pub vault_name: String,
    pub vault_path: String,
    pub access: Access,
}

/// A registered MCP client. Its token's hash is never read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClient {
    pub id: String,
    pub name: String,
    /// The token's first characters, to tell tokens apart.
    pub token_prefix: String,
    pub created_at: String,
    /// Its last authenticated request.
    pub last_seen_at: Option<String>,
    /// The `clientInfo` it last declared; unverified.
    pub last_client_name: Option<String>,
    pub last_client_version: Option<String>,
    /// Set once revoked: its token no longer authenticates.
    pub revoked_at: Option<String>,
    /// By vault name.
    pub grants: Vec<Grant>,
}

/// How a tool call was let through or stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    /// Ran without asking.
    Allowed,
    /// The user approved it.
    Approved,
    /// The user rejected it.
    Rejected,
    /// Refused without asking.
    Denied,
    /// Nobody answered the approval in time.
    Timeout,
    /// The request went away while waiting for approval.
    Withdrawn,
}

/// How the client reached the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// Streamable HTTP, directly.
    Http,
    /// Through the stdio bridge.
    Bridge,
}

/// Stored as the same text serde uses.
macro_rules! text_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text,)+
                }
            }
        }

        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }

        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value.as_str()? {
                    $($text => Ok(Self::$variant),)+
                    other => Err(FromSqlError::Other(format!("unknown {} {other:?}", stringify!($name)).into())),
                }
            }
        }
    };
}

text_enum!(Access { Read => "read", Write => "write" });
text_enum!(Decision {
    Allowed => "allowed",
    Approved => "approved",
    Rejected => "rejected",
    Denied => "denied",
    Timeout => "timeout",
    Withdrawn => "withdrawn",
});
text_enum!(Transport { Http => "http", Bridge => "bridge" });

/// One tool call, as [`Store::add_audit`] records it. Client and vault names
/// are copied so the row outlives both.
#[derive(Debug, Clone, Copy)]
pub struct NewAuditEntry<'a> {
    pub client_id: &'a str,
    pub client_name: &'a str,
    /// The `clientInfo` the client declared; unverified.
    pub client_info_name: Option<&'a str>,
    pub client_info_version: Option<&'a str>,
    pub protocol_version: Option<&'a str>,
    pub transport: Transport,
    /// The legacy `Mcp-Session-Id`, or the bridge's instance id.
    pub session_key: Option<&'a str>,
    pub tool: &'a str,
    pub vault_id: Option<&'a str>,
    pub vault_name: Option<&'a str>,
    /// The note the call is about.
    pub path: Option<&'a str>,
    /// What was asked: the text searched for, the text to write…
    pub detail: Option<&'a str>,
    /// Why the client says it wants the change.
    pub reason: Option<&'a str>,
    pub decision: Decision,
    pub approval_wait_ms: Option<u64>,
    pub elapsed_ms: Option<u64>,
    /// How many things the call returned.
    pub count: Option<u64>,
    /// The result sent back was cut short.
    pub truncated: bool,
    pub error: Option<&'a str>,
}

/// A recorded [`NewAuditEntry`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub at: String,
    pub client_id: String,
    pub client_name: String,
    pub client_info_name: Option<String>,
    pub client_info_version: Option<String>,
    pub protocol_version: Option<String>,
    pub transport: Transport,
    pub session_key: Option<String>,
    pub tool: String,
    pub vault_id: Option<String>,
    pub vault_name: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
    /// The detail was longer and is cut to its first 100 KiB.
    pub detail_truncated: bool,
    pub reason: Option<String>,
    pub decision: Decision,
    pub approval_wait_ms: Option<u64>,
    pub elapsed_ms: Option<u64>,
    pub count: Option<u64>,
    pub truncated: bool,
    pub error: Option<String>,
}

/// Which audit rows [`Store::audit`] returns: those matching every condition
/// given, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuditFilter {
    pub client_id: Option<String>,
    pub vault_id: Option<String>,
    pub decision: Option<Decision>,
    /// Contained in the path or the detail, case-insensitive for ASCII.
    pub search: Option<String>,
    /// Only rows older than this one: the last id of the previous page.
    pub before_id: Option<i64>,
    pub limit: u32,
}

impl Default for AuditFilter {
    fn default() -> Self {
        Self { client_id: None, vault_id: None, decision: None, search: None, before_id: None, limit: 100 }
    }
}

const CLIENT_COLUMNS: &str =
    "id, name, token_prefix, created_at, last_seen_at, last_client_name, last_client_version, revoked_at";

const AUDIT_COLUMNS: &str = "id, at, client_id, client_name, client_info_name, client_info_version, \
    protocol_version, transport, session_key, tool, vault_id, vault_name, path, detail, detail_truncated, reason, \
    decision, approval_wait_ms, elapsed_ms, count, truncated, error";

/// Applied in order; `PRAGMA user_version` records how many ran. Only ever append.
const MIGRATIONS: &[&str] = &["create table setting (
        key text primary key,
        value text not null
    );
    create table client (
        id text primary key,
        name text not null,
        token_hash blob not null unique,
        token_prefix text not null,
        created_at text not null,
        last_seen_at text,
        last_client_name text,
        last_client_version text,
        revoked_at text
    );
    create table vault_grant (
        client_id text not null,
        vault_id text not null,
        vault_name text not null,
        vault_path text not null,
        access text not null check (access in ('read', 'write')),
        primary key (client_id, vault_id)
    );
    create table audit (
        id integer primary key autoincrement,
        at text not null,
        client_id text not null,
        client_name text not null,
        client_info_name text,
        client_info_version text,
        protocol_version text,
        transport text not null check (transport in ('http', 'bridge')),
        session_key text,
        tool text not null,
        vault_id text,
        vault_name text,
        path text,
        detail text,
        detail_truncated integer not null default 0,
        reason text,
        decision text not null
            check (decision in ('allowed', 'approved', 'rejected', 'denied', 'timeout', 'withdrawn')),
        approval_wait_ms integer,
        elapsed_ms integer,
        count integer,
        truncated integer not null default 0,
        error text
    );
    create index audit_by_client on audit (client_id, id);
    create index audit_by_vault on audit (vault_id, id)"];

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

pub struct Store {
    db: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut db: Connection) -> Result<Self> {
        db.pragma_update(None, "journal_mode", "wal")?;
        db.pragma_update(None, "synchronous", "normal")?;
        let done: usize = db.query_row("pragma user_version", [], |r| r.get::<_, i64>(0))? as usize;
        for (i, migration) in MIGRATIONS.iter().enumerate().skip(done) {
            let tx = db.transaction()?;
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", i as i64 + 1)?;
            tx.commit()?;
        }
        Ok(Self { db: Mutex::new(db) })
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self.db().query_row("select value from setting where key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub(crate) fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.db().execute(
            "insert into setting (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }

    /// Revoked ones included, oldest first.
    pub fn clients(&self) -> Result<Vec<McpClient>> {
        let db = self.db();
        let mut stmt = db.prepare(&format!("select {CLIENT_COLUMNS} from client order by created_at, rowid"))?;
        let clients = stmt.query_map([], client_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        clients.into_iter().map(|client| with_grants(&db, client)).collect()
    }

    /// Registers a client for a token of which only the hash is kept.
    pub fn create_client(
        &self,
        name: &str,
        token_hash: &[u8; 32],
        token_prefix: &str,
        grant: Option<&Grant>,
    ) -> Result<McpClient> {
        let id = random_id();
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            &format!("insert into client (id, name, token_hash, token_prefix, created_at) values (?1, ?2, ?3, ?4, {NOW})"),
            params![id, name, token_hash, token_prefix],
        )?;
        if let Some(grant) = grant {
            put_grant(&tx, &id, grant)?;
        }
        tx.commit()?;
        Ok(client_by_id(&db, &id)?.expect("client just inserted"))
    }

    /// With its grants; revoked or not.
    pub fn client(&self, id: &str) -> Result<Option<McpClient>> {
        client_by_id(&self.db(), id)
    }

    /// The client this token authenticates; never a revoked one.
    pub fn client_by_token_hash(&self, token_hash: &[u8; 32]) -> Result<Option<McpClient>> {
        let db = self.db();
        let client = db
            .query_row(
                &format!("select {CLIENT_COLUMNS} from client where token_hash = ?1 and revoked_at is null"),
                [token_hash],
                client_row,
            )
            .optional()?;
        client.map(|client| with_grants(&db, client)).transpose()
    }

    /// The renamed client, or None if there is no such client.
    pub fn rename_client(&self, id: &str, name: &str) -> Result<Option<McpClient>> {
        let db = self.db();
        db.execute("update client set name = ?2 where id = ?1", params![id, name])?;
        client_by_id(&db, id)
    }

    /// Its token stops authenticating at once. Revoking again keeps the
    /// first time. None if there is no such client.
    pub fn revoke_client(&self, id: &str) -> Result<Option<McpClient>> {
        let db = self.db();
        db.execute(&format!("update client set revoked_at = coalesce(revoked_at, {NOW}) where id = ?1"), [id])?;
        client_by_id(&db, id)
    }

    /// Replaces the token; the old one stops authenticating at once. None,
    /// and nothing changed, if there is no such client or it is revoked: a
    /// revoked client gets no new token.
    pub fn rotate_client(&self, id: &str, token_hash: &[u8; 32], token_prefix: &str) -> Result<Option<McpClient>> {
        let db = self.db();
        let rotated = db.execute(
            "update client set token_hash = ?2, token_prefix = ?3 where id = ?1 and revoked_at is null",
            params![id, token_hash, token_prefix],
        )?;
        if rotated == 0 {
            return Ok(None);
        }
        client_by_id(&db, id)
    }

    /// With its grants. Its audit rows stay, under the name they recorded.
    pub fn delete_client(&self, id: &str) -> Result<()> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute("delete from vault_grant where client_id = ?1", [id])?;
        tx.execute("delete from client where id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Marks the client seen now, with the `clientInfo` it declared, and
    /// returns the time recorded (None if there is no such client). Without
    /// a `client_name` the last declared name and version are kept.
    pub fn touch_client(&self, id: &str, client_name: Option<&str>, client_version: Option<&str>) -> Result<Option<String>> {
        let short = |text: Option<&str>| text.map(|text| cut(text, MAX_SHORT).to_owned());
        let seen = self
            .db()
            .query_row(
                &format!(
                    "update client set
                       last_seen_at = {NOW},
                       last_client_name = coalesce(?2, last_client_name),
                       last_client_version = case when ?2 is null then last_client_version else ?3 end
                     where id = ?1
                     returning last_seen_at"
                ),
                params![id, short(client_name), short(client_version)],
                |r| r.get(0),
            )
            .optional()?;
        Ok(seen)
    }

    /// Sets what a client may do in a vault, replacing what it could.
    /// None, and nothing changed, if there is no such client.
    pub fn set_grant(&self, client_id: &str, grant: &Grant) -> Result<Option<McpClient>> {
        let mut db = self.db();
        let tx = db.transaction()?;
        if client_by_id(&tx, client_id)?.is_none() {
            return Ok(None);
        }
        put_grant(&tx, client_id, grant)?;
        let client = client_by_id(&tx, client_id)?;
        tx.commit()?;
        Ok(client)
    }

    /// The client can no longer use the vault.
    pub fn remove_grant(&self, client_id: &str, vault_id: &str) -> Result<Option<McpClient>> {
        let db = self.db();
        db.execute("delete from vault_grant where client_id = ?1 and vault_id = ?2", [client_id, vault_id])?;
        client_by_id(&db, client_id)
    }

    /// Records a tool call, stamped now, and returns it as stored.
    pub fn add_audit(&self, entry: NewAuditEntry) -> Result<AuditEntry> {
        self.add_audit_retaining(entry, AUDIT_RETENTION)
    }

    fn add_audit_retaining(&self, entry: NewAuditEntry, keep: usize) -> Result<AuditEntry> {
        fn short(text: &str) -> &str {
            cut(text, MAX_SHORT)
        }
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            &format!(
                "insert into audit (at, client_id, client_name, client_info_name, client_info_version,
                   protocol_version, transport, session_key, tool, vault_id, vault_name, path, detail,
                   detail_truncated, reason, decision, approval_wait_ms, elapsed_ms, count, truncated, error)
                 values ({NOW}, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19,
                   ?20)"
            ),
            params![
                short(entry.client_id),
                short(entry.client_name),
                entry.client_info_name.map(short),
                entry.client_info_version.map(short),
                entry.protocol_version.map(short),
                entry.transport,
                entry.session_key.map(short),
                short(entry.tool),
                entry.vault_id.map(short),
                entry.vault_name.map(short),
                entry.path.map(|path| cut(path, MAX_PATH)),
                entry.detail.map(|detail| cut(detail, MAX_DETAIL)),
                entry.detail.is_some_and(|detail| detail.len() > MAX_DETAIL),
                entry.reason.map(|reason| cut(reason, MAX_REASON)),
                entry.decision,
                entry.approval_wait_ms.map(|n| n as i64),
                entry.elapsed_ms.map(|n| n as i64),
                entry.count.map(|n| n as i64),
                entry.truncated,
                entry.error.map(|error| cut(error, MAX_ERROR)),
            ],
        )?;
        let id = tx.last_insert_rowid();
        // Rows only ever go from the oldest end, so ids are consecutive and
        // the newest `keep` rows are exactly those above `id - keep`.
        tx.execute("delete from audit where id <= ?1", [id - keep as i64])?;
        let stored = tx.query_row(&format!("select {AUDIT_COLUMNS} from audit where id = ?1"), [id], audit_row)?;
        tx.commit()?;
        Ok(stored)
    }

    /// Newest first; see [`AuditFilter`].
    pub fn audit(&self, filter: &AuditFilter) -> Result<Vec<AuditEntry>> {
        // Only the conditions given, so SQLite can use the indexes.
        let mut conditions = Vec::new();
        let mut args: Vec<Value> = Vec::new();
        if let Some(id) = &filter.client_id {
            conditions.push("client_id = ?");
            args.push(id.clone().into());
        }
        if let Some(id) = &filter.vault_id {
            conditions.push("vault_id = ?");
            args.push(id.clone().into());
        }
        if let Some(decision) = filter.decision {
            conditions.push("decision = ?");
            args.push(decision.as_str().to_owned().into());
        }
        if let Some(search) = filter.search.as_deref().filter(|s| !s.is_empty()) {
            conditions.push("(instr(lower(path), lower(?)) > 0 or instr(lower(detail), lower(?)) > 0)");
            args.push(search.to_owned().into());
            args.push(search.to_owned().into());
        }
        if let Some(id) = filter.before_id {
            conditions.push("id < ?");
            args.push(id.into());
        }
        args.push(i64::from(filter.limit).into());

        let mut sql = format!("select {AUDIT_COLUMNS} from audit");
        if !conditions.is_empty() {
            sql.push_str(" where ");
            sql.push_str(&conditions.join(" and "));
        }
        sql.push_str(" order by id desc limit ?");

        let db = self.db();
        let mut stmt = db.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), audit_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// `text` cut to at most `max` bytes, on a char boundary.
fn cut(text: &str, max: usize) -> &str {
    &text[..text.floor_char_boundary(max)]
}

fn put_grant(db: &Connection, client_id: &str, grant: &Grant) -> Result<()> {
    db.execute(
        "insert into vault_grant (client_id, vault_id, vault_name, vault_path, access) values (?1, ?2, ?3, ?4, ?5)
         on conflict (client_id, vault_id) do update set
           vault_name = excluded.vault_name, vault_path = excluded.vault_path, access = excluded.access",
        params![client_id, grant.vault_id, grant.vault_name, grant.vault_path, grant.access],
    )?;
    Ok(())
}

fn client_by_id(db: &Connection, id: &str) -> Result<Option<McpClient>> {
    let client = db.query_row(&format!("select {CLIENT_COLUMNS} from client where id = ?1"), [id], client_row).optional()?;
    client.map(|client| with_grants(db, client)).transpose()
}

fn client_row(row: &Row) -> rusqlite::Result<McpClient> {
    Ok(McpClient {
        id: row.get(0)?,
        name: row.get(1)?,
        token_prefix: row.get(2)?,
        created_at: row.get(3)?,
        last_seen_at: row.get(4)?,
        last_client_name: row.get(5)?,
        last_client_version: row.get(6)?,
        revoked_at: row.get(7)?,
        grants: Vec::new(),
    })
}

fn with_grants(db: &Connection, mut client: McpClient) -> Result<McpClient> {
    let mut stmt = db.prepare(
        "select vault_id, vault_name, vault_path, access from vault_grant where client_id = ?1
         order by vault_name, vault_id",
    )?;
    let row = |r: &Row| Ok(Grant { vault_id: r.get(0)?, vault_name: r.get(1)?, vault_path: r.get(2)?, access: r.get(3)? });
    client.grants = stmt.query_map([&client.id], row)?.collect::<rusqlite::Result<_>>()?;
    Ok(client)
}

fn audit_row(row: &Row) -> rusqlite::Result<AuditEntry> {
    let count = |i: usize| -> rusqlite::Result<Option<u64>> { Ok(row.get::<_, Option<i64>>(i)?.map(|n| n as u64)) };
    Ok(AuditEntry {
        id: row.get(0)?,
        at: row.get(1)?,
        client_id: row.get(2)?,
        client_name: row.get(3)?,
        client_info_name: row.get(4)?,
        client_info_version: row.get(5)?,
        protocol_version: row.get(6)?,
        transport: row.get(7)?,
        session_key: row.get(8)?,
        tool: row.get(9)?,
        vault_id: row.get(10)?,
        vault_name: row.get(11)?,
        path: row.get(12)?,
        detail: row.get(13)?,
        detail_truncated: row.get(14)?,
        reason: row.get(15)?,
        decision: row.get(16)?,
        approval_wait_ms: count(17)?,
        elapsed_ms: count(18)?,
        count: count(19)?,
        truncated: row.get(20)?,
        error: row.get(21)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn grant(vault_id: &str, access: Access) -> Grant {
        Grant { vault_id: vault_id.into(), vault_name: vault_id.to_uppercase(), vault_path: format!("/{vault_id}"), access }
    }

    fn entry<'a>(client_id: &'a str, vault_id: &'a str, path: &'a str, detail: &'a str) -> NewAuditEntry<'a> {
        NewAuditEntry {
            client_id,
            client_name: "claude-code",
            client_info_name: Some("claude-code"),
            client_info_version: Some("2.1.0"),
            protocol_version: Some("2026-07-28"),
            transport: Transport::Http,
            session_key: None,
            tool: "edit_note",
            vault_id: Some(vault_id),
            vault_name: Some("Notes"),
            path: Some(path),
            detail: Some(detail),
            reason: None,
            decision: Decision::Allowed,
            approval_wait_ms: None,
            elapsed_ms: Some(4),
            count: Some(2),
            truncated: false,
            error: None,
        }
    }

    fn details(entries: &[AuditEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.detail.as_deref().unwrap_or_default()).collect()
    }

    #[test]
    fn a_token_is_one_client_until_revoked_or_replaced() {
        let store = Store::in_memory().unwrap();
        let a = store.create_client("a", &hash(1), "itztli_aaaaaa", None).unwrap();
        let b = store.create_client("b", &hash(2), "itztli_bbbbbb", Some(&grant("v", Access::Read))).unwrap();
        let by = |n| store.client_by_token_hash(&hash(n)).unwrap().map(|c| c.id);
        assert_eq!((by(1), by(2), by(3)), (Some(a.id.clone()), Some(b.id.clone()), None));
        assert_eq!(b.grants, [grant("v", Access::Read)]);

        store.rotate_client(&a.id, &hash(3), "itztli_cccccc").unwrap().unwrap();
        assert_eq!((by(1), by(3)), (None, Some(a.id.clone())));

        let revoked = store.revoke_client(&a.id).unwrap().unwrap();
        assert!(revoked.revoked_at.is_some());
        assert_eq!(by(3), None);
        assert_eq!(store.revoke_client(&a.id).unwrap().unwrap().revoked_at, revoked.revoked_at);
        assert_eq!(store.rotate_client(&a.id, &hash(4), "x").unwrap(), None, "a revoked client gets no new token");

        store.delete_client(&b.id).unwrap();
        assert_eq!(by(2), None);
        assert_eq!(store.clients().unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>(), ["a"]);
        assert_eq!(store.rename_client("nobody", "x").unwrap(), None);
        assert_eq!(store.rename_client(&a.id, "renamed").unwrap().unwrap().name, "renamed");
    }

    #[test]
    fn grants_are_per_vault() {
        let store = Store::in_memory().unwrap();
        let client = store.create_client("a", &hash(1), "p", None).unwrap();
        store.set_grant(&client.id, &grant("b", Access::Read)).unwrap();
        store.set_grant(&client.id, &grant("a", Access::Write)).unwrap();
        let client = store.set_grant(&client.id, &grant("b", Access::Write)).unwrap().unwrap();
        assert_eq!(client.grants, [grant("a", Access::Write), grant("b", Access::Write)]);
        let client = store.remove_grant(&client.id, "a").unwrap().unwrap();
        assert_eq!(client.grants, [grant("b", Access::Write)]);
        assert_eq!(store.set_grant("nobody", &grant("a", Access::Read)).unwrap(), None);
    }

    #[test]
    fn remembers_when_a_client_was_seen_and_what_it_said_it_is() {
        let store = Store::in_memory().unwrap();
        let id = store.create_client("a", &hash(1), "p", None).unwrap().id;
        let seen = store.touch_client(&id, Some("cursor"), Some("1.0")).unwrap();
        assert!(seen.is_some());
        store.touch_client(&id, None, None).unwrap();
        let client = store.client(&id).unwrap().unwrap();
        assert_eq!((client.last_client_name.as_deref(), client.last_client_version.as_deref()), (Some("cursor"), Some("1.0")));
        assert_eq!(store.touch_client("nobody", None, None).unwrap(), None);
    }

    #[test]
    fn pages_and_filters_the_audit_log() {
        let store = Store::in_memory().unwrap();
        for (client, vault, path, detail) in [
            ("c1", "v1", "a.md", "one"),
            ("c2", "v1", "b.md", "two"),
            ("c1", "v2", "Plans.md", "three"),
            ("c1", "v1", "a.md", "Four"),
        ] {
            store.add_audit(entry(client, vault, path, detail)).unwrap();
        }
        let find = |filter: AuditFilter| store.audit(&filter).unwrap();
        let all = find(AuditFilter::default());
        assert_eq!(details(&all), ["Four", "three", "two", "one"]);
        let page = find(AuditFilter { limit: 2, ..Default::default() });
        let next = find(AuditFilter { limit: 2, before_id: Some(page[1].id), ..Default::default() });
        assert_eq!((details(&page), details(&next)), (vec!["Four", "three"], vec!["two", "one"]));
        assert_eq!(details(&find(AuditFilter { client_id: Some("c2".into()), ..Default::default() })), ["two"]);
        assert_eq!(details(&find(AuditFilter { vault_id: Some("v2".into()), ..Default::default() })), ["three"]);
        assert_eq!(details(&find(AuditFilter { search: Some("FOUR".into()), ..Default::default() })), ["Four"]);
        assert_eq!(details(&find(AuditFilter { search: Some("plans".into()), ..Default::default() })), ["three"]);
        assert!(find(AuditFilter { decision: Some(Decision::Rejected), ..Default::default() }).is_empty());
    }

    #[test]
    fn keeps_the_newest_and_cuts_what_is_long() {
        let store = Store::in_memory().unwrap();
        for n in 0..5 {
            store.add_audit_retaining(entry("c", "v", "a.md", &n.to_string()), 3).unwrap();
        }
        assert_eq!(details(&store.audit(&AuditFilter::default()).unwrap()), ["4", "3", "2"]);

        let long = "é".repeat(MAX_DETAIL);
        let stored = store.add_audit(NewAuditEntry { reason: Some(&long), ..entry("c", "v", "a.md", &long) }).unwrap();
        assert!(stored.detail_truncated);
        assert_eq!(stored.detail.unwrap().len(), MAX_DETAIL);
        assert_eq!(stored.reason.unwrap().len(), MAX_REASON);
    }

    #[test]
    fn survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.db");
        let id = Store::open(&file).unwrap().create_client("a", &hash(1), "p", None).unwrap().id;
        assert_eq!(Store::open(&file).unwrap().client(&id).unwrap().unwrap().name, "a");
    }
}
