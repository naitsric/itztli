import { create } from "zustand";
import { api, onEvent, type Entry, type IndexStatus, type VaultChange, type VaultInfo } from "../backend/api";
import { notify } from "../ui/notifications";
import { isWithin, movedPath } from "./paths";

interface VaultState {
  info: VaultInfo | null;
  /** By path. Replaced in place: watch the counters below instead. */
  entries: Map<string, Entry>;
  /** Grows when something is created, removed or moved. */
  structure: number;
  /** Grows on any change, and when the index is ready. */
  content: number;
  index: IndexStatus | null;
}

export const useVault = create<VaultState>(() => ({
  info: null,
  entries: new Map(),
  structure: 0,
  content: 0,
  index: null,
}));

/** What happened to a file or folder, as the rest of the UI hears it. */
export type FileChange =
  | { kind: "put"; path: string; created: boolean; origin: "app" | "disk" }
  | { kind: "remove"; path: string }
  | { kind: "move"; from: string; to: string };

const listeners = new Set<(change: FileChange) => void>();

/** Hears every change to the vault, whoever made it. */
export function onFileChange(listener: (change: FileChange) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function tell(change: FileChange) {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch (e) {
      console.error("a listener of vault changes failed", e);
    }
  }
}

/** Applies changes to the entries. Returns them as listeners hear them. */
export function applyChanges(
  entries: Map<string, Entry>,
  changes: readonly VaultChange[],
  origin: "app" | "disk",
): FileChange[] {
  const heard: FileChange[] = [];
  for (const change of changes) {
    if (change.kind === "put") {
      const created = !entries.has(change.entry.path);
      entries.set(change.entry.path, change.entry);
      heard.push({ kind: "put", path: change.entry.path, created, origin });
    } else if (change.kind === "remove") {
      let known = false;
      for (const path of [...entries.keys()]) {
        if (isWithin(path, change.path)) known = entries.delete(path) || known;
      }
      // A folder's contents are also reported one by one.
      if (known) heard.push(change);
    } else {
      const moving = [...entries.values()].filter((e) => isWithin(e.path, change.from));
      for (const e of moving) entries.delete(e.path);
      for (const e of moving) {
        const path = movedPath(e.path, change.from, change.to);
        entries.set(path, { ...e, path });
      }
      heard.push(change);
    }
  }
  return heard;
}

export function listenToVault(): () => void {
  const stops = [
    onEvent("vault-changed", ({ origin, changes }) => {
      const { entries } = useVault.getState();
      const heard = applyChanges(entries, changes, origin);
      if (heard.length === 0) return;
      const restructured = heard.some((c) => c.kind !== "put" || c.created);
      useVault.setState((s) => ({ content: s.content + 1, structure: s.structure + (restructured ? 1 : 0) }));
      heard.forEach(tell);
    }),
    onEvent("index-ready", (index) => useVault.setState((s) => ({ index, content: s.content + 1 }))),
    onEvent("warning", ({ message }) => notify(message, { kind: "warning" })),
  ];
  return () => stops.forEach((stop) => stop());
}

export async function loadVault(info: VaultInfo) {
  const entries = new Map((await api.vaultEntries()).map((e) => [e.path, e]));
  const index = await api.indexStatus();
  useVault.setState((s) => ({ info, entries, index, structure: s.structure + 1, content: s.content + 1 }));
}

export function unloadVault() {
  useVault.setState((s) => ({ info: null, entries: new Map(), index: null, structure: s.structure + 1, content: s.content + 1 }));
}

export function entryAt(path: string): Entry | undefined {
  return useVault.getState().entries.get(path);
}
