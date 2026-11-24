/**
 * The backend's commands, typed. Their other side is
 * `crates/itztli-backend/src/commands.rs`.
 */
import { host } from "./host";

export interface CommandError {
  code:
    | "noVault"
    | "notFound"
    | "exists"
    | "conflict"
    | "notText"
    | "invalidArgument"
    | "io"
    | "plugin"
    | "network";
  message: string;
}

export function isCommandError(e: unknown): e is CommandError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

/** Something to show for anything thrown. */
export function errorMessage(e: unknown): string {
  if (isCommandError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface AppInfo {
  version: string;
  platform: string;
  safeMode: boolean;
  pluginApi: number;
  remoteImages: boolean;
}

export interface VaultInfo {
  id: string;
  name: string;
  path: string;
}

export interface RecentVault extends VaultInfo {
  openedAt: number;
  exists: boolean;
}

export interface Entry {
  path: string;
  folder: boolean;
  size: number;
  modified: number;
}

export interface IndexStatus {
  ready: boolean;
  notes: number;
  elapsedMs: number;
}

export interface FileText {
  text: string;
  revision: string;
}

export type LinkKind = "wiki" | "embed" | "markdown" | "image" | "property";

export interface Link {
  kind: LinkKind;
  target: string;
  subpath: string | null;
  display: string | null;
  line: number;
  col: number;
  len: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface NoteMeta {
  title: string | null;
  frontmatter: Record<string, unknown> | null;
  invalidFrontmatter: boolean;
  aliases: string[];
  tags: { name: string; line: number; col: number }[];
  headings: Heading[];
  links: Link[];
  tasks: { done: boolean; text: string; line: number }[];
  blocks: { id: string; line: number }[];
  words: number;
}

export interface FileHit {
  path: string;
  alias: string | null;
  inPath: boolean;
  positions: number[];
  score: number;
}

export interface HeadingHit extends Heading {
  path: string;
  positions: number[];
  score: number;
}

export interface LinkSuggestion {
  path: string | null;
  insert: string;
  alias: string | null;
}

export interface TextQuery {
  text: string;
  matchCase?: boolean;
  wholeWords?: boolean;
  regex?: boolean;
  folder?: string;
  limit?: number;
}

export interface TextMatch {
  line: number;
  col: number;
  len: number;
  preview: string;
  previewCol: number;
}

export interface TextResults {
  files: { path: string; matches: TextMatch[] }[];
  total: number;
  truncated: boolean;
}

export interface Usages {
  path: string;
  links: (Link & { context: string })[];
}

export interface Excerpt {
  path: string;
  text: string;
  line: number;
}

export interface TagCount {
  name: string;
  notes: number;
}

export interface NoteTask {
  path: string;
  line: number;
  done: boolean;
  text: string;
}

export interface Problem {
  kind: "missingNote" | "missingPlace" | "invalidFrontmatter";
  path: string;
  line: number;
  col: number;
  len: number;
  target: string;
}

export interface Graph {
  nodes: { id: string; name: string; missing: boolean; tag: string | null }[];
  edges: [number, number][];
}

export interface RelinkedNote {
  path: string;
  links: number;
}

export interface Revision {
  id: number;
  at: number;
  reason: "edit" | "refactor" | "delete";
  size: number;
}

export interface PluginSetting {
  key: string;
  title: string;
  description: string;
  type: "boolean" | "string" | "text" | "number" | "select";
  default: unknown;
  options?: { value: string; label: string }[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  api: number;
  description: string;
  author: string;
  homepage: string | null;
  main: string;
  styles: string | null;
  network: string[];
  settings: PluginSetting[];
}

export interface PluginInfo {
  id: string;
  scope: "user" | "vault";
  status: "disabled" | "enabled" | "needsReview" | "invalid";
  development: boolean;
  manifest: PluginManifest | null;
  error: string | null;
  fingerprint: string | null;
  folder: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  token: string;
  development: boolean;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type VaultChange =
  | { kind: "put"; entry: Entry }
  | { kind: "remove"; path: string }
  | { kind: "move"; from: string; to: string };

export interface BackendEvents {
  "vault-changed": { origin: "app" | "disk"; changes: VaultChange[] };
  "index-ready": IndexStatus;
  "plugins-changed": { folders: string[] };
  "config-changed": Record<string, never>;
  warning: { message: string };
}

export function onEvent<K extends keyof BackendEvents>(name: K, handler: (payload: BackendEvents[K]) => void) {
  return host.listen<BackendEvents[K]>(name, handler);
}

const call = <T>(command: string, args: object = {}) => host.call<T>(command, args);
const ask = <T>(command: string, args: object = {}) => host.ask<T>(command, args);

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  stateGet: <T>(name: string) => call<T | null>("state_get", { name }),
  stateSet: (name: string, value: unknown) => call<void>("state_set", { name, value }),
  appQuit: () => ask<void>("app_quit"),
  appRestart: (safeMode: boolean) => ask<void>("app_restart", { safeMode }),

  vaultRecents: () => call<RecentVault[]>("vault_recents"),
  vaultOpen: (id: string) => call<VaultInfo>("vault_open", { id }),
  vaultPick: (welcome: boolean) => ask<VaultInfo | null>("vault_pick", { welcome }),
  vaultForget: (id: string) => call<void>("vault_forget", { id }),
  vaultCurrent: () => call<VaultInfo | null>("vault_current"),
  vaultClose: () => call<void>("vault_close"),
  vaultEntries: () => call<Entry[]>("vault_entries"),
  indexStatus: () => call<IndexStatus>("index_status"),
  configGet: <T>(name: string) => call<T | null>("config_get", { name }),
  configSet: (name: string, value: unknown) => call<void>("config_set", { name, value }),

  noteRead: (path: string) => call<FileText>("note_read", { path }),
  noteWrite: (path: string, text: string, base?: string) => call<string>("note_write", { path, text, base }),
  noteCreate: (path: string, text = "") => call<void>("note_create", { path, text }),
  noteCreateFree: (folder: string, name: string, text = "") =>
    call<string>("note_create_free", { folder, name, text }),
  attachmentCreate: (folder: string, name: string, base64: string) =>
    call<string>("attachment_create", { folder, name, base64 }),
  folderCreate: (path: string) => call<void>("folder_create", { path }),
  entryDuplicate: (path: string) => call<string>("entry_duplicate", { path }),
  entryMovePreview: (from: string, to: string) => call<RelinkedNote[]>("entry_move_preview", { from, to }),
  entryMove: (from: string, to: string, relink = true) =>
    call<{ relinked: RelinkedNote[]; failed: [string, string][] }>("entry_move", { from, to, relink }),
  entryTrash: (path: string) => call<void>("entry_trash", { path }),
  entryReveal: (path: string) => ask<void>("entry_reveal", { path }),
  entryOpen: (path: string) => ask<void>("entry_open", { path }),
  urlOpen: (url: string) => ask<void>("url_open", { url }),

  findFiles: (query: string, scope: "notes" | "files" = "notes", limit = 50) =>
    call<FileHit[]>("find_files", { query, scope, limit }),
  findHeadings: (query: string, limit = 50) => call<HeadingHit[]>("find_headings", { query, limit }),
  searchText: (query: TextQuery) => call<TextResults>("search_text", query),

  noteMeta: (path: string) => call<NoteMeta | null>("note_meta", { path }),
  linkResolve: (source: string, target: string, relative = false) =>
    call<string | null>("link_resolve", { source, target, relative }),
  linksResolve: (links: { source: string; target: string; relative: boolean }[]) =>
    call<(string | null)[]>("links_resolve", { links }),
  linkText: (source: string, target: string) => call<string>("link_text", { source, target }),
  suggestLinks: (source: string, query: string, limit = 50) =>
    call<LinkSuggestion[]>("suggest_links", { source, query, limit }),
  excerpt: (source: string, target: string, subpath: string | null, relative = false) =>
    call<Excerpt>("excerpt", { source, target, subpath, relative }),
  usages: (path: string) => call<Usages[]>("usages", { path }),
  tags: () => call<TagCount[]>("tags"),
  notesWithTag: (name: string) => call<string[]>("notes_with_tag", { name }),
  tasks: () => call<NoteTask[]>("tasks"),
  problems: () => call<Problem[]>("problems"),
  problemsIn: (path: string) => call<Problem[]>("problems_in", { path }),
  graph: (options: { around?: string; depth?: number; missing?: boolean }) => call<Graph>("graph", options),

  historyList: (path: string) => call<Revision[]>("history_list", { path }),
  historyText: (id: number) => call<string | null>("history_text", { id }),

  pluginsList: () => call<{ plugins: PluginInfo[]; builtinsOff: string[] }>("plugins_list"),
  pluginLoad: (id: string) => call<LoadedPlugin>("plugin_load", { id }),
  pluginEnable: (id: string, development: boolean) => ask<boolean>("plugin_enable", { id, development }),
  pluginDisable: (id: string) => call<void>("plugin_disable", { id }),
  pluginBuiltinSet: (id: string, enabled: boolean) => call<void>("plugin_builtin_set", { id, enabled }),
  pluginCreate: (id: string, name: string, scope: "user" | "vault") =>
    call<PluginInfo>("plugin_create", { id, name, scope }),
  pluginInstall: () => ask<PluginInfo | null>("plugin_install"),
  pluginUninstall: (id: string) => call<void>("plugin_uninstall", { id }),
  pluginReveal: (id: string) => ask<void>("plugin_reveal", { id }),
  pluginFetch: (token: string, request: object) => ask<NetResponse>("plugin_fetch", { token, request }),
  remoteImagesSet: (allowed: boolean) => ask<boolean>("remote_images_set", { allowed }),
};
