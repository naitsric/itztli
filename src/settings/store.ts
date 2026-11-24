import { create } from "zustand";
import { api } from "../backend/api";
import { useCommands } from "../commands/registry";
import { setTheme } from "../theme";
import { notifyError } from "../ui/notifications";

export interface Settings {
  appearance: {
    /** `system`, `light`, `dark` or a plugin's theme. */
    theme: string;
    translucent: boolean;
  };
  editor: {
    font: "ui" | "serif" | "mono";
    size: number;
    /** In pixels; 0 for as wide as the window. */
    width: number;
    livePreview: boolean;
    lineNumbers: boolean;
    spellcheck: boolean;
    /** A plain click follows a link; ⌘-click always does. */
    clickOpensLinks: boolean;
  };
  files: {
    newNoteLocation: "current" | "root" | "folder";
    newNoteFolder: string;
    attachmentsFolder: string;
    singleClickOpens: boolean;
    /** The vault tree follows the file in front. */
    followOpenFile: boolean;
    showAttachments: boolean;
  };
  /** The user's keys by command; `null` takes a key off. */
  keymap: Record<string, string | null>;
}

export const DEFAULTS: Settings = {
  appearance: { theme: "system", translucent: true },
  editor: {
    font: "ui",
    size: 15,
    width: 760,
    livePreview: true,
    lineNumbers: false,
    spellcheck: false,
    clickOpensLinks: true,
  },
  files: {
    newNoteLocation: "current",
    newNoteFolder: "",
    attachmentsFolder: "attachments",
    singleClickOpens: true,
    followOpenFile: true,
    showAttachments: true,
  },
  keymap: {},
};

export const useSettings = create<Settings>(() => DEFAULTS);

export function settings(): Settings {
  return useSettings.getState();
}

/** Saved settings over the defaults: what is missing or of another type falls back. */
export function mergeSettings(saved: unknown): Settings {
  const source = isObject(saved) ? saved : {};
  const section = <K extends "appearance" | "editor" | "files">(key: K): Settings[K] => {
    const defaults = DEFAULTS[key] as Record<string, unknown>;
    const values = isObject(source[key]) ? source[key] : {};
    const merged = Object.entries(defaults).map(([name, value]) => [name, typeof values[name] === typeof value ? values[name] : value]);
    return Object.fromEntries(merged) as Settings[K];
  };
  const keymap = isObject(source.keymap) ? source.keymap : {};
  return {
    appearance: section("appearance"),
    editor: section("editor"),
    files: section("files"),
    keymap: Object.fromEntries(
      Object.entries(keymap).filter(([, v]) => v === null || typeof v === "string"),
    ) as Settings["keymap"],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apply({ appearance, keymap }: Settings) {
  setTheme({ preference: appearance.theme, translucent: appearance.translucent });
  useCommands.setState({ overrides: keymap });
}

export async function loadSettings(): Promise<void> {
  useSettings.setState(mergeSettings(await api.stateGet("settings").catch(() => null)));
  apply(settings());
}

let timer = 0;

export function updateSettings(change: { [K in keyof Settings]?: Partial<Settings[K]> }) {
  const current = settings();
  const next: Settings = {
    appearance: { ...current.appearance, ...change.appearance },
    editor: { ...current.editor, ...change.editor },
    files: { ...current.files, ...change.files },
    keymap: (change.keymap as Settings["keymap"] | undefined) ?? current.keymap,
  };
  useSettings.setState(next);
  apply(next);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void api.stateSet("settings", next).catch((e) => notifyError(e, "Settings are not saved")), 300);
}

/** Changes one command's key. `undefined` goes back to its own. */
export function setKeybinding(commandId: string, binding: string | null | undefined) {
  const { [commandId]: _, ...others } = settings().keymap;
  updateSettings({ keymap: binding === undefined ? others : { ...others, [commandId]: binding } });
}
