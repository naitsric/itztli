import type { EditorView } from "@codemirror/view";
import { create } from "zustand";

/** An editor on screen, in one of the workbench's tabs. */
export interface MountedEditor {
  panelId: string;
  path: string;
  view: EditorView;
}

/** The editor of the tab in front, whether or not it has the caret. */
export const useActiveEditor = create<{ editor: MountedEditor | null }>(() => ({ editor: null }));

const mounted = new Map<string, MountedEditor>();
const waiting = new Map<string, ((editor: MountedEditor) => void)[]>();
let activePanelId: string | null = null;
/** The tab that should have the caret, for when its editor mounts. */
let wantsFocus: { panelId: string; until: number } | null = null;

/** Long enough to load a note; an editor that comes later doesn't take the caret. */
const FOCUS_WAIT_MS = 1500;

export function mountEditor(editor: MountedEditor): () => void {
  mounted.set(editor.panelId, editor);
  if (editor.panelId === activePanelId) useActiveEditor.setState({ editor });
  if (wantsFocus?.panelId === editor.panelId && performance.now() < wantsFocus.until) editor.view.focus();
  // Once it is there to stay: an editor may be replaced right after mounting.
  const timer = window.setTimeout(() => {
    for (const run of waiting.get(editor.panelId)?.splice(0) ?? []) run(editor);
  });
  return () => {
    window.clearTimeout(timer);
    if (mounted.get(editor.panelId) === editor) mounted.delete(editor.panelId);
    if (useActiveEditor.getState().editor === editor) useActiveEditor.setState({ editor: null });
  };
}

/** Told by the editor area which tab is in front. */
export function setActivePanel(panelId: string | null) {
  activePanelId = panelId;
  const editor = (panelId && mounted.get(panelId)) || null;
  if (useActiveEditor.getState().editor !== editor) useActiveEditor.setState({ editor });
}

/** Gives the caret to a tab's editor, now or as soon as it is there. */
export function focusEditorIn(panelId: string) {
  wantsFocus = { panelId, until: performance.now() + FOCUS_WAIT_MS };
  mounted.get(panelId)?.view.focus();
}

export function editorIn(panelId: string): MountedEditor | undefined {
  return mounted.get(panelId);
}

/** Runs something with a tab's editor, now or as soon as it is there. */
export function withEditor(panelId: string, path: string, run: (editor: MountedEditor) => void) {
  const editor = mounted.get(panelId);
  if (editor?.path === path) return run(editor);
  const list = waiting.get(panelId) ?? [];
  list.push((next) => next.path === path && run(next));
  waiting.set(panelId, list);
}

export function activeView(): EditorView | null {
  return useActiveEditor.getState().editor?.view ?? null;
}
