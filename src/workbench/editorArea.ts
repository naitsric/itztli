import { EditorView } from "@codemirror/view";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { create } from "zustand";
import { editorIn, focusEditorIn, setActivePanel, withEditor, type MountedEditor } from "../editor/active";
import { documentAt } from "../editor/documents";
import { flashLineAt } from "../editor/flash";
import { lineOfSubpath } from "../editor/outline";
import { isWithin, movedPath, displayName } from "../vault/paths";
import { entryAt, onFileChange } from "../vault/store";
import { noteOpened } from "../vault/workspaceState";

/**
 * Lets code outside React (commands, actions, plugins) open and focus the
 * editor area's tabs, and tracks which one is in front.
 */

interface EditorAreaState {
  activePath: string | null;
  activePanelId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export const useEditorArea = create<EditorAreaState>(() => ({
  activePath: null,
  activePanelId: null,
  canGoBack: false,
  canGoForward: false,
}));

export interface PanelParams {
  path: string;
  /** Opened to look at: the next one takes its place, until it is edited or kept. */
  preview?: boolean;
}

export interface OpenOptions {
  line?: number;
  col?: number;
  /** A heading or block of the note. */
  subpath?: string | null;
  /** In a new group beside. */
  split?: boolean;
  focus?: boolean;
  preview?: boolean;
  /** Not a jump one comes back from. */
  noHistory?: boolean;
}

let dockview: DockviewApi | null = null;
let nextPanel = 1;

export const WELCOME_PANEL_ID = "welcome";

export function attachDockview(api: DockviewApi | null) {
  dockview = api;
}

export function pathOf(panel: IDockviewPanel | undefined): string | null {
  return (panel?.params as PanelParams | undefined)?.path ?? null;
}

function panels(): IDockviewPanel[] {
  return dockview?.panels.filter((p) => pathOf(p) !== null) ?? [];
}

export function openPaths(): string[] {
  return [...new Set(panels().map((p) => pathOf(p)!))];
}

/** Opens a file in a tab, or goes to the one it has. */
export function openPath(path: string, options: OpenOptions = {}) {
  if (!dockview || entryAt(path)?.folder) return;
  const { split = false, focus = true, preview = false } = options;
  const jumps = path !== currentPlace()?.path || options.line !== undefined || !!options.subpath;
  if (!options.noHistory && jumps) rememberPlace();

  const group = dockview.activeGroup;
  let panel = split
    ? undefined
    : (panels().find((p) => p.group === group && pathOf(p) === path) ?? panels().find((p) => pathOf(p) === path));

  if (panel) {
    if (!preview) keepPanel(panel);
    panel.api.setActive();
  } else {
    const reusable = !split && panels().find((p) => p.group === group && (p.params as PanelParams).preview);
    if (reusable && preview) {
      reusable.api.updateParameters({ path, preview: true });
      reusable.api.setTitle(displayName(path));
      reusable.api.setActive();
      panel = reusable;
      syncActive();
    } else {
      const anchor = panels().find((p) => p.group === group) ?? panels()[0] ?? dockview.getPanel(WELCOME_PANEL_ID);
      panel = dockview.addPanel<PanelParams>({
        id: `file:${Date.now().toString(36)}-${nextPanel++}`,
        component: "file",
        title: displayName(path),
        params: { path, preview },
        position: anchor ? { referencePanel: anchor, direction: split ? "right" : "within" } : undefined,
      });
      panel.group.header.hidden = false;
      dockview.getPanel(WELCOME_PANEL_ID)?.api.close();
    }
  }

  const { line, col, subpath } = options;
  if (line !== undefined || subpath) {
    withEditor(panel.id, path, (editor) => reveal(editor, { line, col, subpath }));
  }
  if (focus) focusEditorIn(panel.id);
}

function reveal({ view }: MountedEditor, place: { line?: number; col?: number; subpath?: string | null }) {
  const line = place.line ?? (place.subpath ? lineOfSubpath(view.state, place.subpath) : null);
  if (line === null) return;
  const target = view.state.doc.line(Math.min(Math.max(line + 1, 1), view.state.doc.lines));
  const pos = Math.min(target.from + (place.col ?? 0), target.to);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  flashLineAt(view, pos);
}

/** A preview tab becomes a tab like any other. */
export function keepPanel(panel: IDockviewPanel) {
  const params = panel.params as PanelParams | undefined;
  if (params?.preview) panel.api.updateParameters({ ...params, preview: false });
}

export function keepPanelOf(panelId: string) {
  const panel = dockview?.getPanel(panelId);
  if (panel) keepPanel(panel);
}

export function closeActiveTab() {
  dockview?.activePanel?.api.close();
}

export function closeOtherTabs() {
  const active = dockview?.activePanel;
  if (!active) return;
  for (const p of [...active.group.panels]) if (p !== active) p.api.close();
}

export function closeAllTabs() {
  for (const p of panels()) p.api.close();
}

export function hasTabs(): boolean {
  return panels().length > 0;
}

export function cycleTab(direction: 1 | -1) {
  const active = dockview?.activePanel;
  if (!active) return;
  const all = active.group.panels;
  const at = all.indexOf(active);
  all[(at + direction + all.length) % all.length]?.api.setActive();
  focusEditor();
}

export function splitActive(direction: "right" | "below") {
  const active = dockview?.activePanel;
  const path = pathOf(active);
  if (!dockview || !active || !path) return;
  const panel = dockview.addPanel<PanelParams>({
    id: `file:${Date.now().toString(36)}-${nextPanel++}`,
    component: "file",
    title: displayName(path),
    params: { path },
    position: { referencePanel: active, direction },
  });
  focusEditorIn(panel.id);
}

/** Gives the keyboard to the tab in front. */
export function focusEditor() {
  const active = dockview?.activePanel;
  if (!active) return;
  active.api.setActive();
  const editor = editorIn(active.id);
  if (editor) editor.view.focus();
  else (active.view.content.element as HTMLElement).focus?.();
}

/** Brings the state in line with the tab in front. */
export function syncActive() {
  const panel = dockview?.activePanel;
  const activePath = pathOf(panel);
  useEditorArea.setState({ activePath, activePanelId: panel?.id ?? null });
  setActivePanel(panel?.id ?? null);
  if (activePath) noteOpened(activePath);
}

// ── Back and forward ───────────────────────────────────────────────────────

interface Place {
  path: string;
  position: number;
}

const back: Place[] = [];
const forward: Place[] = [];
const MAX_PLACES = 100;

function currentPlace(): Place | null {
  const panel = dockview?.activePanel;
  const path = pathOf(panel);
  if (!panel || !path) return null;
  return { path, position: editorIn(panel.id)?.view.state.selection.main.head ?? 0 };
}

function publishPlaces() {
  useEditorArea.setState({ canGoBack: back.length > 0, canGoForward: forward.length > 0 });
}

/** The caret is about to jump away from here. */
export function rememberPlace() {
  const place = currentPlace();
  if (!place) return;
  const last = back[back.length - 1];
  if (last?.path === place.path && last.position === place.position) return;
  back.push(place);
  if (back.length > MAX_PLACES) back.shift();
  forward.length = 0;
  publishPlaces();
}

function go(from: Place[], to: Place[]) {
  let place = from.pop();
  // What was deleted since can't be gone back to.
  while (place && !entryAt(place.path)) place = from.pop();
  if (place) {
    const here = currentPlace();
    if (here) to.push(here);
    const { path, position } = place;
    openPath(path, { noHistory: true });
    const panel = dockview?.activePanel;
    if (panel) {
      withEditor(panel.id, path, ({ view }) => {
        const pos = Math.min(position, view.state.doc.length);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      });
    }
  }
  publishPlaces();
}

export const goBack = () => go(back, forward);
export const goForward = () => go(forward, back);

export function forgetPlaces() {
  back.length = 0;
  forward.length = 0;
  publishPlaces();
}

onFileChange((change) => {
  if (change.kind === "move") {
    for (const place of [...back, ...forward]) place.path = movedPath(place.path, change.from, change.to);
    for (const panel of panels()) {
      const path = pathOf(panel)!;
      if (!isWithin(path, change.from)) continue;
      const next = movedPath(path, change.from, change.to);
      panel.api.updateParameters({ ...(panel.params as PanelParams), path: next });
      panel.api.setTitle(displayName(next));
    }
    syncActive();
  } else if (change.kind === "remove") {
    for (const panel of panels()) {
      const path = pathOf(panel)!;
      // With unsaved changes it stays, to be saved or let go.
      if (isWithin(path, change.path) && !documentAt(path)?.dirty) panel.api.close();
    }
  }
});
