import { api } from "../backend/api";
import { movedPath } from "./paths";
import { onFileChange, useVault } from "./store";

/** What the app remembers about a vault on this computer, between launches. */
export interface WorkspaceState {
  /** dockview's layout of the editor area. */
  layout?: unknown;
  toolWindows?: unknown;
  /** Most recent first. */
  recentFiles: string[];
  expandedFolders: string[];
  /** Where the caret was, by path. */
  carets: Record<string, number>;
}

const EMPTY: WorkspaceState = { recentFiles: [], expandedFolders: [], carets: {} };
const MAX_RECENT = 50;
const MAX_CARETS = 300;
const SAVE_DELAY_MS = 600;

let vaultId: string | null = null;
let state: WorkspaceState = { ...EMPTY };
let timer = 0;

export async function loadWorkspaceState(id: string): Promise<void> {
  const saved = await api.stateGet<Partial<WorkspaceState>>(`workspace-${id}`).catch(() => null);
  state = { ...EMPTY, ...saved };
  vaultId = id;
}

export function workspaceState(): Readonly<WorkspaceState> {
  return state;
}

export function updateWorkspaceState(change: Partial<WorkspaceState>) {
  if (!vaultId) return;
  state = { ...state, ...change };
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void saveWorkspaceState(), SAVE_DELAY_MS);
}

export async function saveWorkspaceState(): Promise<void> {
  window.clearTimeout(timer);
  if (!vaultId) return;
  // Not being able to remember the layout is no reason to bother anyone.
  await api.stateSet(`workspace-${vaultId}`, state).catch((e) => console.error("workspace not saved", e));
}

export function forgetWorkspaceState() {
  window.clearTimeout(timer);
  vaultId = null;
  state = { ...EMPTY };
}

export function noteOpened(path: string) {
  updateWorkspaceState({ recentFiles: [path, ...state.recentFiles.filter((p) => p !== path)].slice(0, MAX_RECENT) });
}

export function rememberCaret(path: string, position: number) {
  const { [path]: _, ...others } = state.carets;
  // Last in, last kept.
  const kept = Object.entries(others).slice(-(MAX_CARETS - 1));
  updateWorkspaceState({ carets: { ...Object.fromEntries(kept), [path]: position } });
}

/** Recent files that still exist, most recent first. */
export function recentFiles(): string[] {
  const { entries } = useVault.getState();
  return state.recentFiles.filter((p) => entries.has(p));
}

onFileChange((change) => {
  if (change.kind !== "move") return;
  const follow = (p: string) => movedPath(p, change.from, change.to);
  updateWorkspaceState({
    recentFiles: state.recentFiles.map(follow),
    expandedFolders: state.expandedFolders.map(follow),
    carets: Object.fromEntries(Object.entries(state.carets).map(([p, at]) => [follow(p), at])),
  });
});
