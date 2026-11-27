import { create } from "zustand";
import { errorMessage, onEvent } from "../backend/api";
import { confirm } from "../dialogs/ask";
import { notifyError } from "../ui/notifications";
import { showToolWindow } from "../workbench/toolWindows";
import {
  addLive,
  addPage,
  canLoadOlder,
  emptyLog,
  NO_FILTER,
  olderCursor,
  startLog,
  toAuditFilter,
  type ActivityFilter,
  type ActivityLog,
} from "./activity";
import { mcpApi, type Access, type McpClient, type McpEvent, type McpSettings } from "./api";
import { addPending, emptyQueue, resolveRequest, stepRequest } from "./approvalsQueue";
import { applyEvent, AUDIT_RING, mergeAudit, type McpSnapshot } from "./events";

/**
 * The MCP server as the UI sees it: its status and settings, the clients
 * and their access, changes waiting for approval and the latest activity.
 * Kept current by the `mcp` event; see {@link listenToMcp}.
 */

/**
 * The tool window's tabs, in order. Activity comes first and is where it
 * opens: once a client is set up, watching what it does is why the window
 * is opened. Creating a client switches to Clients.
 */
export type McpTab = "activity" | "clients" | "server";

export type McpDialog =
  | { kind: "newClient" }
  /** A token just created or replaced: shown once. */
  | { kind: "token"; client: McpClient; token: string; replaced: boolean };

/** The Activity tab: its filters, the log they select and the row whose detail shows. */
export interface ActivityState {
  filter: ActivityFilter;
  log: ActivityLog;
  selectedId: number | null;
  /**
   * Bumped each time the log starts over (a new filter, Refresh): a page
   * asked for before is dropped, and the list goes back to the top.
   */
  version: number;
}

interface McpState extends McpSnapshot {
  loaded: boolean;
  /** Why the initial load failed. */
  loadError: string | null;
  settings: McpSettings | null;
  tab: McpTab;
  selectedClientId: string | null;
  dialog: McpDialog | null;
  activity: ActivityState;
}

export const useMcp = create<McpState>(() => ({
  loaded: false,
  loadError: null,
  status: { running: false, port: null, url: null, error: null },
  settings: null,
  clients: [],
  approvals: emptyQueue,
  approvalsHidden: false,
  audit: [],
  tab: "activity",
  selectedClientId: null,
  dialog: null,
  activity: { filter: NO_FILTER, log: emptyLog, selectedId: null, version: 0 },
}));

const set = useMcp.setState;
const get = useMcp.getState;

/** Status events seen, so a status read that an event overtook is not applied after it. */
let statusEvents = 0;

function onMcpEvent(event: McpEvent) {
  if (event.kind === "status") statusEvents++;
  set((state) => {
    const changes = applyEvent(state, event);
    if (event.kind !== "audit") return changes;
    const { kind: _, ...entry } = event;
    const { filter, log } = state.activity;
    return { ...changes, activity: { ...state.activity, log: addLive(log, [entry], filter) } };
  });
}

/**
 * Listens to the server's events and loads its state. Changes waiting for
 * approval are read too, so a reloaded UI asks about them again.
 */
export function listenToMcp(): () => void {
  const stop = onEvent("mcp", onMcpEvent);
  void loadMcp();
  return stop;
}

/**
 * Reads everything again; events that arrive meanwhile are kept. Each part
 * stands alone, so pending approvals still show if, say, the audit log
 * can't be read.
 */
export async function loadMcp() {
  const seen = statusEvents;
  const [status, settings, clients, pending, audit] = await Promise.allSettled([
    mcpApi.status(),
    mcpApi.settings(),
    mcpApi.clients(),
    mcpApi.pendingApprovals(),
    mcpApi.audit({ limit: AUDIT_RING }),
  ]);
  const ok = <T>(result: PromiseSettledResult<T>) => (result.status === "fulfilled" ? result.value : undefined);
  const failed = [status, settings, clients, pending, audit].find((r): r is PromiseRejectedResult => r.status === "rejected");
  set((state) => ({
    loaded: true,
    loadError: failed ? errorMessage(failed.reason) : null,
    status: (statusEvents === seen && ok(status)) || state.status,
    settings: ok(settings) ?? state.settings,
    clients: ok(clients) ?? state.clients,
    approvals: addPending(state.approvals, ok(pending) ?? []),
    audit: mergeAudit(state.audit, ok(audit) ?? []),
    // The newest rows, so complete up to now like the Activity log: they add without a gap.
    activity: { ...state.activity, log: addLive(state.activity.log, ok(audit) ?? [], state.activity.filter) },
  }));
}

/** The clients again, e.g. when the tool window opens: `lastSeenAt` moves without events in between. */
export async function reloadClients() {
  try {
    set({ clients: await mcpApi.clients() });
  } catch {
    // The list shown stays; the next action reports what is wrong.
  }
}

// Server

/**
 * Saves the settings; the server starts, restarts or stops to match. False
 * when the user, asked by the system, said no. Throws what the server refused.
 */
export async function saveSettings(settings: McpSettings): Promise<boolean> {
  const seen = statusEvents;
  const status = await mcpApi.saveSettings(settings);
  if (!status) return false;
  set(statusEvents === seen ? { settings, status } : { settings });
  return true;
}

/** Turns the server on or off, keeping the other settings as saved. */
export async function toggleServer() {
  try {
    const settings = await mcpApi.settings();
    await saveSettings({ ...settings, enabled: !settings.enabled });
  } catch (e) {
    notifyError(e, "The MCP server could not be changed");
  }
}

/** Starts the server again with the saved settings, e.g. after it failed to start. */
export async function retryServer() {
  try {
    await saveSettings(get().settings ?? (await mcpApi.settings()));
  } catch (e) {
    notifyError(e, "The MCP server could not start");
  }
}

// Clients

export function selectClient(id: string | null) {
  set({ selectedClientId: id });
}

export function setMcpTab(tab: McpTab) {
  set({ tab });
}

export function showMcp(tab: McpTab) {
  set({ tab });
  showToolWindow("mcp");
}

export function openNewClient() {
  set({ dialog: { kind: "newClient" } });
}

export function closeDialog() {
  set({ dialog: null });
}

const replaceClient = (client: McpClient) =>
  set((state) => ({ clients: state.clients.map((c) => (c.id === client.id ? client : c)) }));

/**
 * Registers a client and shows its token. False when the user, asked by
 * the system, said no. Throws what the server refused.
 */
export async function createClient(
  name: string,
  access: { vaultId: string; access: Access } | null,
  turnOn: boolean,
): Promise<boolean> {
  const created = await mcpApi.createClient(name, access, turnOn);
  if (!created) return false;
  const { client, token } = created;
  set((state) => ({
    clients: [...state.clients, client],
    settings: turnOn && state.settings ? { ...state.settings, enabled: true } : state.settings,
    selectedClientId: client.id,
    tab: "clients",
    dialog: { kind: "token", client, token, replaced: false },
  }));
  return true;
}

export async function renameClient(client: McpClient, name: string) {
  try {
    replaceClient(await mcpApi.renameClient(client.id, name));
  } catch (e) {
    notifyError(e, "The client could not be renamed");
  }
}

export async function replaceToken(client: McpClient) {
  try {
    const replaced = await mcpApi.rotateClient(client.id);
    if (!replaced) return;
    replaceClient(replaced.client);
    set({ dialog: { kind: "token", client: replaced.client, token: replaced.token, replaced: true } });
  } catch (e) {
    notifyError(e, "The token could not be replaced");
  }
}

export async function revokeClient(client: McpClient) {
  const confirmed = await confirm({
    title: `Revoke “${client.name}”?`,
    message:
      "Its token stops working at once, and any change it proposed that waits for approval is withdrawn. " +
      "It stays in the list, and its activity in the log.",
    action: "Revoke",
    danger: true,
  });
  if (!confirmed) return;
  try {
    replaceClient(await mcpApi.revokeClient(client.id));
  } catch (e) {
    notifyError(e, "The client could not be revoked");
  }
}

export async function deleteClient(client: McpClient) {
  const confirmed = await confirm({
    title: `Delete “${client.name}”?`,
    message: "Its token stops working at once and its access is removed. Its activity stays in the log.",
    action: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await mcpApi.deleteClient(client.id);
    set((state) => ({
      clients: state.clients.filter((c) => c.id !== client.id),
      selectedClientId: state.selectedClientId === client.id ? null : state.selectedClientId,
    }));
  } catch (e) {
    notifyError(e, "The client could not be deleted");
  }
}

/** Sets what a client may do in a vault. More than before takes the user's word, asked by the system. */
export async function setAccess(clientId: string, vaultId: string, access: Access | null) {
  try {
    const client = await mcpApi.setAccess(clientId, vaultId, access);
    if (client) replaceClient(client);
  } catch (e) {
    notifyError(e, "The client's access could not be changed");
  }
}

/**
 * Whether each change of a client waits for the user's approval. Not asking
 * takes the user's word, asked by the system; asking again counts from the
 * client's next call.
 */
export async function setApproval(clientId: string, required: boolean) {
  try {
    const client = await mcpApi.setApproval(clientId, required);
    if (client) replaceClient(client);
  } catch (e) {
    notifyError(e, "Whether the client's changes need approval could not be changed");
  }
}

// Activity

const setLog = (change: (log: ActivityLog) => ActivityLog) =>
  set((state) => ({ activity: { ...state.activity, log: change(state.activity.log) } }));

const sameFilter = (a: ActivityFilter, b: ActivityFilter) =>
  a.clientId === b.clientId && a.vaultId === b.vaultId && a.decision === b.decision && a.search === b.search;

/** Starts the Activity log the first time it shows; later it stays current by itself. */
export function startActivity() {
  if (!get().activity.log.started) void reloadActivity();
}

/** The log again from the newest row: the ring's matching rows at once, then the newest page. */
export async function reloadActivity() {
  set((state) => ({
    activity: {
      ...state.activity,
      log: startLog(state.audit, state.activity.filter),
      version: state.activity.version + 1,
    },
  }));
  await fetchActivityPage(get().activity.version, null);
}

/** The next page of older rows, if there are any and none is on its way. Also retries a failed page. */
export async function loadOlderActivity() {
  const { log, version } = get().activity;
  const cursor = olderCursor(log);
  if (!canLoadOlder(log) || cursor === undefined) return;
  setLog((l) => ({ ...l, loading: true, error: null }));
  await fetchActivityPage(version, cursor);
}

/** Adds a page to the log, unless the log started over meanwhile. */
async function fetchActivityPage(version: number, beforeId: number | null) {
  const current = () => get().activity.version === version;
  try {
    const page = await mcpApi.audit(toAuditFilter(get().activity.filter, beforeId));
    if (current()) setLog((log) => addPage(log, page));
  } catch (e) {
    if (current()) setLog((log) => ({ ...log, loading: false, error: errorMessage(e) }));
  }
}

/** Changes some of the filters and shows what matches, from the newest row. */
export function setActivityFilter(change: Partial<ActivityFilter>) {
  const current = get().activity.filter;
  const filter = { ...current, ...change };
  if (sameFilter(filter, current)) return;
  set((state) => ({ activity: { ...state.activity, filter } }));
  void reloadActivity();
}

export function clearActivityFilter() {
  setActivityFilter(NO_FILTER);
}

export function selectActivity(id: number | null) {
  set((state) => ({ activity: { ...state.activity, selectedId: id } }));
}

/** Switches to Activity, showing only what `clientId` did. */
export function showClientActivity(clientId: string) {
  setActivityFilter({ ...NO_FILTER, clientId });
  set({ tab: "activity" });
}

// Approvals

/**
 * Answers the request and takes it off the queue: answered now, or
 * already resolved (timed out, withdrawn) with its event on the way.
 */
export async function answerApproval(id: number, approve: boolean) {
  try {
    await mcpApi.answerApproval(id, approve);
    set((state) => ({ approvals: resolveRequest(state.approvals, id) }));
  } catch (e) {
    notifyError(e, "The change could not be answered");
  }
}

export const hasApprovals = () => get().approvals.requests.length > 0;

export function showApprovals() {
  set({ approvalsHidden: false });
}

/** Puts the dialog aside; the requests keep waiting, and the status bar brings them back. */
export function hideApprovals() {
  set({ approvalsHidden: true });
}

export function stepApproval(step: -1 | 1) {
  set((state) => ({ approvals: stepRequest(state.approvals, step) }));
}
