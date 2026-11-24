import type { Plugin } from "@itztli/plugin-api";
import { create } from "zustand";
import { useApp } from "../appInfo";
import { api, errorMessage, onEvent, type PluginInfo, type PluginManifest } from "../backend/api";
import { host } from "../backend/host";
import { BUILTINS, type BuiltinPlugin } from "../builtin";
import { notify } from "../ui/notifications";
import { useVault } from "../vault/store";
import { createContext, MODULES, type PluginData, type PluginInstance } from "./context";

/**
 * Runs plugins: the app's own and the user's, all through the same API. What
 * may run is the backend's to say (crates/itztli-plugins); this only starts,
 * stops and contains.
 */

export type RunState = "stopped" | "starting" | "running" | "failed";

export interface PluginEntry {
  id: string;
  manifest: PluginManifest | null;
  builtin: boolean;
  /** As the backend sees it; built-in plugins are just on or off. */
  info: PluginInfo | null;
  enabled: boolean;
  state: RunState;
  /** What went wrong, newest last. */
  errors: string[];
}

export const usePlugins = create<{ plugins: PluginEntry[] }>(() => ({ plugins: [] }));

interface Running {
  plugin: Plugin;
  instance: PluginInstance;
  data: PluginData;
  styles: HTMLElement | null;
}

const running = new Map<string, Running>();
/** Changes happen one at a time: a reload never overlaps a stop. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

const MAX_ERRORS = 30;
/** A plugin that fails on every keystroke is said to once. */
const MAX_NOTICES = 3;
const notices = new Map<string, number>();

function update(id: string, change: Partial<PluginEntry>) {
  usePlugins.setState((s) => ({ plugins: s.plugins.map((p) => (p.id === id ? { ...p, ...change } : p)) }));
}

function report(id: string, doing: string, error: unknown) {
  const entry = usePlugins.getState().plugins.find((p) => p.id === id);
  const name = entry?.manifest?.name ?? id;
  console.error(`plugin ${id}: ${doing}`, error);
  if (entry) update(id, { errors: [...entry.errors, `${doing}: ${errorMessage(error)}`].slice(-MAX_ERRORS) });
  const told = (notices.get(id) ?? 0) + 1;
  notices.set(id, told);
  if (told <= MAX_NOTICES) notify(`${name} failed ${doing}: ${errorMessage(error)}`, { kind: "warning" });
}

// ── Surviving a plugin that hangs the app ──────────────────────────────────

const STARTING_KEY = "itztli.plugins.starting";

function markStarting(id: string | null) {
  try {
    if (id) localStorage.setItem(STARTING_KEY, id);
    else localStorage.removeItem(STARTING_KEY);
  } catch {
    // Without storage there is no protection, but nothing breaks.
  }
}

/** The plugin that was starting when the app last stopped, if one was. */
function interrupted(): string | null {
  try {
    return localStorage.getItem(STARTING_KEY);
  } catch {
    return null;
  }
}

// ── Data ───────────────────────────────────────────────────────────────────

async function loadData(id: string): Promise<PluginData> {
  const saved = await api.configGet<Partial<PluginData>>(`plugin-data/${id}`).catch(() => null);
  const object = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {});
  return { settings: object(saved?.settings), storage: object(saved?.storage) };
}

/** A plugin's settings, running or not, for the settings page. */
export async function pluginSettings(id: string): Promise<Record<string, unknown>> {
  return { ...(running.get(id)?.data ?? (await loadData(id))).settings };
}

export async function setPluginSetting(id: string, key: string, value: unknown): Promise<void> {
  const active = running.get(id);
  if (active) {
    active.instance.settingChanged(key, value);
    await api.configSet(`plugin-data/${id}`, active.data);
    return;
  }
  const data = await loadData(id);
  data.settings[key] = value;
  await api.configSet(`plugin-data/${id}`, data);
}

// ── Starting and stopping ──────────────────────────────────────────────────

async function activate(id: string, manifest: PluginManifest, load: () => Promise<{ plugin: Plugin; token: string | null; styles: HTMLElement | null }>) {
  update(id, { state: "starting", errors: [] });
  notices.delete(id);
  markStarting(id);
  let instance: PluginInstance | null = null;
  let styles: HTMLElement | null = null;
  try {
    const data = await loadData(id);
    const loaded = await load();
    styles = loaded.styles;
    if (typeof loaded.plugin?.activate !== "function") {
      throw new Error("main.js has to export a plugin by default: an object with an `activate` function");
    }
    instance = createContext({
      manifest,
      data,
      token: loaded.token,
      save: (d) => api.configSet(`plugin-data/${id}`, d),
      onError: (doing, e) => report(id, doing, e),
    });
    await loaded.plugin.activate(instance.context);
    running.set(id, { plugin: loaded.plugin, instance, data, styles });
    update(id, { state: "running" });
  } catch (e) {
    instance?.dispose();
    styles?.remove();
    update(id, { state: "failed" });
    report(id, "starting", e);
  } finally {
    markStarting(null);
  }
}

async function deactivate(id: string) {
  const active = running.get(id);
  if (!active) return;
  running.delete(id);
  try {
    await active.plugin.deactivate?.();
  } catch (e) {
    report(id, "stopping", e);
  }
  active.instance.dispose();
  active.styles?.remove();
  update(id, { state: "stopped" });
}

const startBuiltin = (builtin: BuiltinPlugin) =>
  activate(builtin.manifest.id, builtin.manifest, async () => ({ plugin: await builtin.load(), token: null, styles: null }));

async function startExternal(id: string, manifest: PluginManifest) {
  await activate(id, manifest, async () => {
    const { token, manifest: loaded } = await api.pluginLoad(id);
    const module = (await import(/* @vite-ignore */ host.pluginUrl(token, loaded.main))) as { default: Plugin };
    let styles: HTMLElement | null = null;
    if (loaded.styles) {
      // As text, so it needs no stylesheet origin in the content policy.
      const css = await (await fetch(host.pluginUrl(token, loaded.styles))).text();
      styles = document.createElement("style");
      styles.dataset.plugin = id;
      styles.textContent = css;
      document.head.append(styles);
    }
    return { plugin: module.default, token, styles };
  });
}

/** Reads which plugins there are, keeping the state of those running. */
async function refresh(): Promise<PluginEntry[]> {
  const { plugins: external, builtinsOff } = await api.pluginsList();
  const before = new Map(usePlugins.getState().plugins.map((p) => [p.id, p]));
  const keep = (id: string) => ({ state: before.get(id)?.state ?? ("stopped" as const), errors: before.get(id)?.errors ?? [] });
  const entries: PluginEntry[] = [
    ...BUILTINS.map(({ manifest }) => ({
      id: manifest.id,
      manifest,
      builtin: true,
      info: null,
      enabled: !builtinsOff.includes(manifest.id),
      ...keep(manifest.id),
    })),
    ...external
      // A built-in plugin's id is taken.
      .filter((info) => !BUILTINS.some((b) => b.manifest.id === info.id))
      .map((info) => ({
        id: info.id,
        manifest: info.manifest,
        builtin: false,
        info,
        enabled: info.status === "enabled",
        ...keep(info.id),
      })),
  ];
  usePlugins.setState({ plugins: entries });
  return entries;
}

/** Brings what runs in line with what is enabled. `touched` restart if they are under development. */
async function reconcile(touched: readonly string[]) {
  const entries = await refresh();
  const safeMode = useApp.getState().info?.safeMode ?? false;
  for (const id of [...running.keys()]) {
    const entry = entries.find((e) => e.id === id);
    const reload = touched.includes(id) && entry?.info?.development;
    if (!entry?.enabled || reload) await deactivate(id);
  }
  if (safeMode || !useVault.getState().info) return;
  for (const entry of entries) {
    const retry = entry.state === "failed" && touched.includes(entry.id);
    if (!entry.enabled || !entry.manifest || running.has(entry.id) || (entry.state === "failed" && !retry)) continue;
    const builtin = BUILTINS.find((b) => b.manifest.id === entry.id);
    if (builtin) await startBuiltin(builtin);
    else await startExternal(entry.id, entry.manifest);
  }
}

export function startPlugins(): Promise<void> {
  return enqueue(async () => {
    (globalThis as { itztli?: object }).itztli = { modules: MODULES };
    const suspect = interrupted();
    markStarting(null);
    await refresh();
    if (suspect) {
      update(suspect, { state: "failed", errors: ["The app stopped responding while this plugin was starting."] });
      const name = usePlugins.getState().plugins.find((p) => p.id === suspect)?.manifest?.name ?? suspect;
      notify(`${name} was not started: the app stopped responding while it was starting the last time.`, {
        kind: "warning",
        actions: [{ title: "Try again", run: () => void enqueue(() => reconcile([suspect])) }],
      });
    }
    await reconcile([]);
    reviewChanged();
  });
}

/** A plugin that changed since it was enabled waits for the user, who should know. */
function reviewChanged() {
  const changed = usePlugins.getState().plugins.filter((p) => p.info?.status === "needsReview");
  if (changed.length === 0) return;
  const names = changed.map((p) => p.manifest?.name ?? p.id).join(", ");
  notify(`${names} changed since you enabled it, and is stopped until you review it in Settings → Plugins.`, { kind: "warning" });
}

export function stopPlugins(): Promise<void> {
  return enqueue(async () => {
    for (const id of [...running.keys()].reverse()) await deactivate(id);
  });
}

export function reloadPlugin(id: string): Promise<void> {
  return enqueue(async () => {
    await deactivate(id);
    update(id, { state: "stopped" });
    await reconcile([id]);
  });
}

export function refreshPlugins(): Promise<void> {
  return enqueue(async () => void (await refresh()));
}

export async function setPluginEnabled(entry: PluginEntry, enabled: boolean, development = false): Promise<void> {
  if (entry.builtin) await api.pluginBuiltinSet(entry.id, enabled);
  else if (!enabled) await api.pluginDisable(entry.id);
  else if (!(await api.pluginEnable(entry.id, development))) return;
  if (entry.state === "failed") update(entry.id, { state: "stopped" });
  await enqueue(() => reconcile([entry.id]));
}

export function listenToPlugins(): () => void {
  return onEvent("plugins-changed", ({ folders }) => {
    if (useVault.getState().info) void enqueue(() => reconcile(folders)).catch((e) => console.error("plugins not refreshed", e));
  });
}
