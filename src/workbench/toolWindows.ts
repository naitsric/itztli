import type { ComponentType } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";
import { keymapHeld } from "../commands/keymapHold";
import { updateWorkspaceState } from "../vault/workspaceState";
import { focusEditor } from "./editorArea";

export type Side = "left" | "right" | "bottom";

export interface ToolWindow {
  id: string;
  title: string;
  icon: string;
  side: Side;
  /** Place in its stripe. */
  order: number;
  /** The command that shows it, for its shortcut. */
  commandId?: string;
  component?: ComponentType;
  /** For plugins: draws in an element, and returns what undoes it. */
  mount?: (element: HTMLElement) => (() => void) | void;
}

interface ToolWindowState {
  all: Record<string, ToolWindow>;
  /** The window showing on each side. */
  open: Record<Side, string | null>;
  /** In pixels. */
  size: Record<Side, number>;
  badges: Record<string, string>;
  /** Sides hidden together by Hide All, to bring back. */
  stashed: Record<Side, string | null> | null;
}

const DEFAULT_OPEN: Record<Side, string | null> = { left: "vault", right: null, bottom: null };
const DEFAULT_SIZE: Record<Side, number> = { left: 280, right: 300, bottom: 260 };

export const useToolWindows = create<ToolWindowState>(() => ({
  all: {},
  open: DEFAULT_OPEN,
  size: DEFAULT_SIZE,
  badges: {},
  stashed: null,
}));

export function registerToolWindow(window: ToolWindow): () => void {
  useToolWindows.setState((s) => ({ all: { ...s.all, [window.id]: window } }));
  return () =>
    useToolWindows.setState((s) => {
      if (s.all[window.id] !== window) return s;
      const { [window.id]: _, ...all } = s.all;
      const { [window.id]: __, ...badges } = s.badges;
      return { all, badges };
    });
}

function persist() {
  const { open, size } = useToolWindows.getState();
  updateWorkspaceState({ toolWindows: { open, size } });
}

/** Brings back how a vault's windows were. */
export function restoreToolWindows(saved: unknown) {
  const { open, size } = (saved ?? {}) as Partial<Pick<ToolWindowState, "open" | "size">>;
  useToolWindows.setState({ open: { ...DEFAULT_OPEN, ...open }, size: { ...DEFAULT_SIZE, ...size }, stashed: null });
}

export function resetToolWindows() {
  useToolWindows.setState({ open: DEFAULT_OPEN, size: DEFAULT_SIZE, stashed: null });
  persist();
}

function set(side: Side, id: string | null) {
  useToolWindows.setState((s) => ({ open: { ...s.open, [side]: id }, stashed: null }));
  persist();
}

/** The element a window's content is in, marked with its id. */
function elementOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tool-window="${CSS.escape(id)}"]`);
}

/** Gives the keyboard to a window. Whether it is drawn already. */
function focusIn(id: string): boolean {
  const element = elementOf(id);
  const target = element?.querySelector<HTMLElement>("[data-autofocus], [role=tree], input, textarea, [tabindex='0']") ?? element;
  target?.focus();
  return !!target;
}

export function showToolWindow(id: string, focus = true) {
  const window = useToolWindows.getState().all[id];
  if (!window) return;
  // Drawn right away, so no key is lost on its way to the window.
  flushSync(() => set(window.side, id));
  if (!focus || focusIn(id)) return;
  // Asked for while React was drawing something else. By the next frame the
  // keyboard may be a dialog's, and stays there.
  requestAnimationFrame(() => {
    if (!keymapHeld()) focusIn(id);
  });
}

export function hideToolWindow(id: string) {
  const window = useToolWindows.getState().all[id];
  if (window && useToolWindows.getState().open[window.side] === id) {
    const had = !!elementOf(id)?.contains(document.activeElement);
    set(window.side, null);
    if (had) focusEditor();
  }
}

/** As IntelliJ's ⌘1: shows and focuses, or hides if it already has the keyboard. */
export function toggleToolWindow(id: string) {
  const { all, open } = useToolWindows.getState();
  const window = all[id];
  if (!window) return;
  const isOpen = open[window.side] === id;
  if (isOpen && elementOf(id)?.contains(document.activeElement)) hideToolWindow(id);
  else showToolWindow(id);
}

/** A click on its button in the stripe: it has no keyboard to take into account. */
export function clickToolWindow(id: string) {
  const { all, open } = useToolWindows.getState();
  const window = all[id];
  if (!window) return;
  if (open[window.side] === id) hideToolWindow(id);
  else showToolWindow(id);
}

/** The window holding the keyboard. */
export function focusedToolWindow(): string | null {
  return document.activeElement?.closest<HTMLElement>("[data-tool-window]")?.dataset.toolWindow ?? null;
}

/** Hides every window, or brings them back: more room to write. */
export function toggleAllToolWindows() {
  const { open, stashed } = useToolWindows.getState();
  const anyOpen = Object.values(open).some(Boolean);
  if (anyOpen) {
    useToolWindows.setState({ open: { left: null, right: null, bottom: null }, stashed: open });
    focusEditor();
  } else {
    useToolWindows.setState({ open: stashed ?? DEFAULT_OPEN, stashed: null });
  }
  persist();
}

export function resizeToolWindow(side: Side, size: number) {
  useToolWindows.setState((s) => ({ size: { ...s.size, [side]: size } }));
  persist();
}

export function setToolWindowBadge(id: string, text: string | null) {
  useToolWindows.setState((s) => {
    const { [id]: _, ...others } = s.badges;
    return { badges: text ? { ...others, [id]: text } : others };
  });
}
