import { host } from "../backend/host";

/*
 * Mirrors of the Rust types of the MCP server (crates/itztli-mcp). What the
 * page may do without asking is a `command`; what changes who may do what is
 * a `change`, which the host asks the user about when it has to.
 */

export interface McpSettings {
  /** Whether the server listens. Off until the user turns it on. */
  enabled: boolean;
  /** The loopback port it listens on. */
  port: number;
  /** Results a search or a listing returns unless the client asks for another number (up to 1000). */
  maxResults: number;
  /** A change nobody approves or rejects within this long is refused. */
  approvalTimeoutSecs: number;
}

export interface ServerStatus {
  running: boolean;
  /** The port it listens on, while running. */
  port: number | null;
  /** The MCP endpoint while running, e.g. `http://127.0.0.1:7413/mcp`. */
  url: string | null;
  /** Why it is not running, when starting it failed. */
  error: string | null;
}

/** What a client may do in a vault. Changes also need the user's approval each time, unless they let the client go without. */
export type Access = "read" | "write";

export interface Grant {
  vaultId: string;
  vaultName: string;
  vaultPath: string;
  access: Access;
}

/** A registered MCP client. Its token is shown once, when created or replaced. */
export interface McpClient {
  id: string;
  name: string;
  /** The token's first characters, to tell tokens apart. */
  tokenPrefix: string;
  /** UTC, RFC 3339, like every timestamp here. */
  createdAt: string;
  /** Its last authenticated request. */
  lastSeenAt: string | null;
  /** The `clientInfo` it last declared; unverified. */
  lastClientName: string | null;
  lastClientVersion: string | null;
  /** Set once revoked: its token no longer works. */
  revokedAt: string | null;
  /** Whether each change it makes waits for the user's approval. True unless they turned it off for this client. */
  changesNeedApproval: boolean;
  grants: Grant[];
}

/** How a tool call was let through or stopped. */
export type Decision = "allowed" | "approved" | "rejected" | "denied" | "timeout" | "withdrawn";

/** How the client reached the server: directly, or through the stdio bridge. */
export type Transport = "http" | "bridge";

/** One tool call in the audit log. */
export interface AuditEntry {
  id: number;
  at: string;
  clientId: string;
  /** As registered in Itztli when the call ran. */
  clientName: string;
  /** What the client declared itself to be; unverified. */
  clientInfoName: string | null;
  clientInfoVersion: string | null;
  protocolVersion: string | null;
  transport: Transport;
  sessionKey: string | null;
  tool: string;
  vaultId: string | null;
  vaultName: string | null;
  /** The note the call is about. */
  path: string | null;
  /** What was asked: the text searched for, the text to write… */
  detail: string | null;
  /** The detail was longer and is cut to its first 100 KiB. */
  detailTruncated: boolean;
  reason: string | null;
  decision: Decision;
  approvalWaitMs: number | null;
  elapsedMs: number | null;
  /** How many things the call returned. */
  count: number | null;
  /** The result sent back was cut short. */
  truncated: boolean;
  error: string | null;
}

/** Audit rows matching every condition given, newest first. */
export interface AuditFilter {
  clientId?: string | null;
  vaultId?: string | null;
  decision?: Decision | null;
  /** Contained in the path or the detail, case-insensitive. */
  search?: string | null;
  /** Only rows older than this one: the last id of the previous page. */
  beforeId?: number | null;
  limit?: number;
}

/** What a change does to the note. */
export type Action = "create" | "edit" | "move" | "delete";

/** Something the person approving a change should look at twice. */
export type Warning = "removesMost" | "breaksLinks";

/** An MCP client's self-reported `clientInfo`. */
export interface ClientInfo {
  name: string;
  version: string | null;
}

/** A change waiting for the user. */
export interface ApprovalRequest {
  id: number;
  clientId: string;
  /** As registered in Itztli: the verified identity. */
  clientName: string;
  /** What the client declared itself to be; unverified. */
  clientInfo: ClientInfo | null;
  vaultId: string;
  vaultName: string;
  action: Action;
  path: string;
  /** Where a move takes it. */
  to: string | null;
  /** What the note says, unless it is being created or moved. */
  before: string | null;
  /** What it would say, unless it is being moved or deleted. */
  after: string | null;
  /** Notes whose links a move rewrites, or a deletion breaks. */
  affected: string[];
  warnings: Warning[];
  /** Why the client says it wants the change. */
  reason: string | null;
  requestedAt: string;
  /** When it is refused unless answered. */
  expiresAt: string;
}

/** What the server reports as the `mcp` event. */
export type McpEvent =
  | ({ kind: "status" } & ServerStatus)
  | ({ kind: "audit" } & AuditEntry)
  | ({ kind: "approvalRequested" } & ApprovalRequest)
  /** Answered, timed out or withdrawn. */
  | { kind: "approvalResolved"; id: number; decision: Decision }
  /** A client authenticated; `at` is its new `lastSeenAt`. Sent at most every 30 s per client. */
  | { kind: "clientSeen"; clientId: string; at: string };

/** A client and its token, which is never shown again. */
export interface ClientWithToken {
  client: McpClient;
  token: string;
}

/** Where clients reach the server. */
export interface Endpoint {
  /** At the port it listens on, else the saved one. */
  url: string;
  /**
   * The executable stdio-only clients (Claude Desktop) run as `<it> mcp-bridge`: the one the app runs
   * from, so a dev build names the dev binary. Null when the app can't tell.
   */
  bridgeCommand: string | null;
}

const command = <T>(name: string, args: object = {}) => host.ask<T>("mcp", { command: name, args });
const change = <T>(kind: string, args: object) => host.ask<T>("mcp_change", { change: { kind, ...args } });

export const mcpApi = {
  status: () => command<ServerStatus>("status"),
  settings: () => command<McpSettings>("settings"),
  /** Revoked ones included, oldest first. */
  clients: () => command<McpClient[]>("clients"),
  audit: (filter: AuditFilter) => command<AuditEntry[]>("audit", { filter: { limit: 100, ...filter } }),
  /** Oldest first. */
  pendingApprovals: () => command<ApprovalRequest[]>("approvals"),
  /** False when it was no longer pending. */
  answerApproval: (id: number, approve: boolean) => command<boolean>("answer", { id, approve }),
  endpoint: () => command<Endpoint>("endpoint"),

  // Null when the user, asked by the system, said no.

  /** Saves, then starts, restarts or stops the server to match. A failed start is in the status. */
  saveSettings: (settings: McpSettings) => change<ServerStatus | null>("settings", { settings }),
  /** Perhaps with access to a vault, and turning the server on. */
  createClient: (name: string, access: { vaultId: string; access: Access } | null, turnOn: boolean) =>
    change<ClientWithToken | null>("createClient", { name, access, turnOn }),
  renameClient: (id: string, name: string) => change<McpClient>("renameClient", { id, name }),
  /** A new token; the old one stops working and its pending approvals are withdrawn. */
  rotateClient: (id: string) => change<ClientWithToken | null>("rotateClient", { id }),
  revokeClient: (id: string) => change<McpClient>("revokeClient", { id }),
  deleteClient: (id: string) => change<null>("deleteClient", { id }),
  setAccess: (id: string, vaultId: string, access: Access | null) =>
    change<McpClient | null>("setAccess", { id, vaultId, access }),
  /** Whether each change of the client waits for approval. Never lets it change a vault it may only read. */
  setApproval: (id: string, required: boolean) => change<McpClient | null>("setApproval", { id, required }),
};
