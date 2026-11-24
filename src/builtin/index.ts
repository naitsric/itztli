import type { Plugin } from "@itztli/plugin-api";
import type { PluginManifest, PluginSetting } from "../backend/api";

/**
 * Features of the app that are plugins, written against the same API as
 * anyone's: what they need, every plugin has. They import nothing from the
 * rest of the app but the API's types.
 */
export interface BuiltinPlugin {
  manifest: PluginManifest;
  load: () => Promise<Plugin>;
}

function manifest(id: string, name: string, description: string, settings: Partial<PluginSetting>[] = []): PluginManifest {
  return {
    id,
    name,
    description,
    version: "1.0.0",
    api: 1,
    author: "Itztli",
    homepage: null,
    main: "",
    styles: null,
    network: [],
    settings: settings.map((s) => ({ description: "", type: "string", default: null, key: "", title: "", ...s })),
  };
}

export const BUILTINS: readonly BuiltinPlugin[] = [
  {
    manifest: manifest("daily-notes", "Daily Notes", "A note per day, opened with one key.", [
      { key: "folder", title: "Folder", description: "Where daily notes go.", default: "Daily" },
      { key: "template", title: "Template", description: "A note to start from, e.g. Templates/Day.md.", default: "" },
      { key: "openOnStart", title: "Open today's note on start", type: "boolean", default: false },
    ]),
    load: async () => (await import("./dailyNotes")).default,
  },
  {
    manifest: manifest("templates", "Templates", "Insert the notes of a folder as text, with the date, the time and the title filled in.", [
      { key: "folder", title: "Folder", description: "Where templates are.", default: "Templates" },
    ]),
    load: async () => (await import("./templates")).default,
  },
  {
    manifest: manifest("tasks", "Tasks", "Every unfinished task of the vault in one tool window.", [
      { key: "showDone", title: "Show finished tasks", type: "boolean", default: false },
    ]),
    load: async () => (await import("./tasks")).default,
  },
  {
    manifest: manifest("word-count", "Word Count", "Words and characters of the note, or of the selection, in the status bar.", [
      { key: "characters", title: "Count characters too", type: "boolean", default: false },
    ]),
    load: async () => (await import("./wordCount")).default,
  },
  {
    manifest: manifest("focus-mode", "Focus Mode", "Dims everything but the paragraph you are in, and keeps it in the middle.", [
      { key: "typewriter", title: "Keep the caret in the middle", type: "boolean", default: true },
    ]),
    load: async () => (await import("./focusMode")).default,
  },
];
