import * as autocomplete from "@codemirror/autocomplete";
import * as cmCommands from "@codemirror/commands";
import * as language from "@codemirror/language";
import * as lint from "@codemirror/lint";
import * as cmSearch from "@codemirror/search";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type * as Api from "@itztli/plugin-api";
import * as lezerCommon from "@lezer/common";
import * as lezerHighlight from "@lezer/highlight";
import * as lezerMarkdown from "@lezer/markdown";
import { moveEntry } from "../actions";
import { useApp } from "../appInfo";
import { api, errorMessage, type PluginManifest } from "../backend/api";
import { host } from "../backend/host";
import { executeCommand, registerCommands } from "../commands/registry";
import { confirm, input, pick } from "../dialogs/ask";
import { useActiveEditor, type MountedEditor } from "../editor/active";
import { registerCodeBlock } from "../editor/codeBlocks";
import { registerCompletion } from "../editor/completion";
import { registerContextActions } from "../editor/contextActions";
import { documentAt, modifyNote, readNote } from "../editor/documents";
import { registerEditorExtension } from "../editor/extensions";
import { registerPostProcessor, renderMarkdown } from "../preview/render";
import { registerTheme, useTheme } from "../theme";
import { drawIcon } from "../ui/icons";
import { notify } from "../ui/notifications";
import { displayName, isNote, isWithin } from "../vault/paths";
import { onFileChange, useVault } from "../vault/store";
import { openPath, openPaths, useEditorArea } from "../workbench/editorArea";
import { registerFileViewer } from "../workbench/fileViewers";
import { addStatusItem } from "../workbench/statusItems";
import { hideToolWindow, registerToolWindow, setToolWindowBadge, showToolWindow } from "../workbench/toolWindows";
import { addFileMenuItem } from "./fileMenu";

/** The shared libraries, for plugins: one copy, the app's. */
export const MODULES: Api.Modules = {
  "@codemirror/autocomplete": autocomplete,
  "@codemirror/commands": cmCommands,
  "@codemirror/language": language,
  "@codemirror/lint": lint,
  "@codemirror/search": cmSearch,
  "@codemirror/state": cmState,
  "@codemirror/view": cmView,
  "@lezer/common": lezerCommon,
  "@lezer/highlight": lezerHighlight,
  "@lezer/markdown": lezerMarkdown,
};

/** A plugin's own file in the vault: its settings and its data. */
export interface PluginData {
  settings: Record<string, unknown>;
  storage: Record<string, unknown>;
}

export interface PluginInstance {
  context: Api.PluginContext;
  /** Undoes everything registered through the context. */
  dispose: () => void;
  /** Settings changed in the app. */
  settingChanged: (key: string, value: unknown) => void;
}

interface Options {
  manifest: PluginManifest;
  data: PluginData;
  save: (data: PluginData) => Promise<void>;
  /** The address of one of its files, and the key to the network; none for built-in ones. */
  token: string | null;
  /** Something of the plugin's failed. */
  onError: (doing: string, error: unknown) => void;
}

/** Makes the `ctx` a plugin works with. See `packages/plugin-api/index.d.ts`. */
export function createContext({ manifest, data, save, token, onError }: Options): PluginInstance {
  const { id } = manifest;
  const disposers = new Set<() => void>();
  let disposed = false;

  /** Remembers how to undo something, once. */
  const track = (undo: () => void): (() => void) => {
    const once = () => {
      if (disposers.delete(once)) undo();
    };
    if (disposed) {
      // Registered after it stopped, by something it left running.
      undo();
      return () => {};
    }
    disposers.add(once);
    return once;
  };

  /** Calls into the plugin: its failures are its own. */
  function guard<A extends unknown[], R>(doing: string, fn: (...args: A) => R): (...args: A) => R | undefined {
    return (...args) => {
      try {
        const result = fn(...args);
        if (result instanceof Promise) result.catch((e) => onError(doing, e));
        return result;
      } catch (e) {
        onError(doing, e);
        return undefined;
      }
    };
  }

  const scoped = (name: string) => `${id}.${name}`;

  // ── Editor ──
  const facade = (editor: MountedEditor | null): Api.ActiveEditor | null => {
    if (!editor || !isNote(editor.path)) return null;
    const { view, path } = editor;
    return {
      path,
      name: displayName(path),
      view,
      text: () => view.state.doc.toString(),
      setText: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.plugin" }),
      selection() {
        const { from, to } = view.state.selection.main;
        return { from, to, text: view.state.sliceDoc(from, to) };
      },
      replaceSelection: (text) => view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.plugin", scrollIntoView: true }),
      insert: (at, text) => view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.plugin" }),
      replace: (from, to, text) => view.dispatch({ changes: { from, to, insert: text }, userEvent: "input.plugin" }),
      lineAt(position) {
        const line = view.state.doc.lineAt(position);
        return { number: line.number - 1, from: line.from, to: line.to, text: line.text };
      },
      select: (from, to = from) => view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true, userEvent: "select" }),
      focus: () => view.focus(),
    };
  };

  const onEditor = (kind: "selection" | "document", listener: (editor: Api.ActiveEditor) => void) => {
    const call = guard(`reacting to the ${kind}`, listener);
    const extension = EditorView.updateListener.of((update) => {
      if (kind === "document" ? !update.docChanged : !update.selectionSet) return;
      const active = facade(useActiveEditor.getState().editor);
      // After the editor is done: the listener may want to change it.
      if (active?.view === update.view) queueMicrotask(() => !disposed && call(active));
    });
    return track(registerEditorExtension(extension));
  };

  // ── Settings and storage ──
  const settingListeners = new Set<(key: string, value: unknown) => void>();
  const defaults = new Map(manifest.settings.map((s) => [s.key, s.default ?? null]));
  const settingChanged = (key: string, value: unknown) => {
    data.settings[key] = value;
    for (const listener of [...settingListeners]) listener(key, value);
  };

  const entryOf = (path: string): Api.FileEntry | null => {
    const entry = useVault.getState().entries.get(path);
    return entry ? { ...entry } : null;
  };

  const context: Api.PluginContext = {
    id,
    manifest: manifest as unknown as Api.Manifest,
    app: { version: useApp.getState().info?.version ?? "", platform: useApp.getState().info?.platform ?? "" },
    modules: MODULES,
    asset: (file) => (token ? host.pluginUrl(token, `assets/${file}`) : ""),
    onDispose: (dispose) => void track(guard("cleaning up", dispose)),

    commands: {
      register: (command) =>
        track(
          registerCommands([
            {
              id: scoped(command.id),
              title: command.title,
              category: manifest.name,
              keybinding: command.keybinding,
              context: command.context,
              keywords: command.keywords,
              plugin: id,
              enabled: command.enabled && (() => guard(`${command.title}: enabled`, command.enabled!)() ?? false),
              run: () => command.run(),
            },
          ]),
        ),
      execute: executeCommand,
    },

    toolWindows: {
      register(definition) {
        const windowId = scoped(definition.id);
        const commandId = `view.toolWindow.${windowId}`;
        const undoWindow = registerToolWindow({
          id: windowId,
          title: definition.title,
          icon: definition.icon,
          side: definition.side,
          order: 100,
          commandId,
          mount: (element) => definition.mount(element),
        });
        const undoCommand = registerCommands([
          { id: commandId, title: definition.title, category: "Tool Windows", plugin: id, run: () => showToolWindow(windowId) },
        ]);
        const dispose = track(() => {
          hideToolWindow(windowId);
          undoWindow();
          undoCommand();
        });
        return {
          show: () => showToolWindow(windowId),
          hide: () => hideToolWindow(windowId),
          setBadge: (text) => setToolWindowBadge(windowId, text),
          dispose,
        };
      },
    },

    editor: {
      active: () => facade(useActiveEditor.getState().editor),
      registerExtension: (extension) => track(registerEditorExtension(extension as Extension)),
      registerCompletion: (source) => track(registerCompletion(async (request) => (await guard("completing", source)(request)) ?? null)),
      onSelectionChange: (listener) => onEditor("selection", listener),
      onDocumentChange: (listener) => onEditor("document", listener),
    },

    markdown: {
      registerCodeBlock: (lang, render) => track(registerCodeBlock(lang, render)),
      registerPostProcessor: (process) => track(registerPostProcessor(guard("processing a preview", process))),
      render: (markdown, element, info) => track(renderMarkdown(markdown, element, { path: info?.path ?? "" })),
    },

    contextActions: {
      register: (provider) =>
        track(
          registerContextActions(({ view, path, line, selection, link }) => {
            const editor = facade({ panelId: "", path, view });
            if (!editor) return [];
            const shown = link && link.kind !== "url" ? { target: link.target, subpath: link.subpath, path: link.path } : null;
            return guard("offering actions", provider)({ editor, line, selection, link: shown }) ?? [];
          }),
        ),
    },

    fileViewers: {
      register: (viewer) =>
        track(
          registerFileViewer({
            id: scoped(viewer.id),
            extensions: viewer.extensions.map((e) => e.toLowerCase().replace(/^\./, "")),
            mount: (element, path) =>
              viewer.mount(element, {
                path,
                url: host.vaultUrl(path),
                read: () => readNote(path),
                write: async (text) => void (await api.noteWrite(path, text)),
                onChange: (listener) =>
                  track(onFileChange((change) => change.kind === "put" && change.path === path && guard("reacting to a change", listener)())),
              }),
          }),
        ),
    },

    vault: {
      get name() {
        return useVault.getState().info?.name ?? "";
      },
      list: (folder = "") =>
        [...useVault.getState().entries.values()].filter((e) => isWithin(e.path, folder) && e.path !== folder).map((e) => ({ ...e })),
      get: entryOf,
      read: readNote,
      async write(path, text) {
        // An open note changes where it is open, so nothing typed is lost.
        if (documentAt(path)) await modifyNote(path, () => text);
        else await api.noteWrite(path, text);
      },
      modify: modifyNote,
      create: (path, text = "") => api.noteCreate(path, text),
      createFolder: (path) => api.folderCreate(path),
      move: async (from, to) => void (await moveEntry(from, to)),
      trash: (path) => api.entryTrash(path),
      url: (path) => host.vaultUrl(path),
      onChange(listener) {
        const call = guard("reacting to a change", listener);
        return track(
          onFileChange((change) => {
            if (change.kind === "put") call({ kind: "put", path: change.path, created: change.created });
            else call(change);
          }),
        );
      },
    },

    notes: {
      meta: (path) => api.noteMeta(path),
      backlinks: async (path) =>
        (await api.usages(path)).map((u) => ({
          path: u.path,
          links: u.links.map((l) => ({ line: l.line, col: l.col, context: l.context, relation: l.relation })),
        })),
      resolve: (target, source) => api.linkResolve(source, target),
      linkText: (path, source) => api.linkText(source, path),
      tags: () => api.tags(),
      withTag: (tag) => api.notesWithTag(tag),
      tasks: () => api.tasks(),
      find: async (query, limit = 50) => (await api.findFiles(query, "files", limit)).map(({ path, alias }) => ({ path, alias })),
      search: async (text, options = {}) =>
        (await api.searchText({ text, limit: 1000, ...options })).files.map((f) => ({
          path: f.path,
          matches: f.matches.map(({ line, col, len, preview }) => ({ line, col, len, preview })),
        })),
    },

    workspace: {
      activePath: () => useEditorArea.getState().activePath,
      onActiveNoteChange(listener) {
        const call = guard("reacting to the active note", listener);
        return track(useEditorArea.subscribe((s, before) => s.activePath !== before.activePath && call(s.activePath)));
      },
      open: (path, options) => openPath(path, options),
      openPaths,
    },

    ui: {
      notify: (message, options) =>
        notify(message, {
          kind: options?.kind,
          actions: options?.actions?.map((a) => ({ title: a.title, run: () => void guard(a.title, a.run)() })),
        }),
      input: (options) => input(options),
      pick: (items, options) => pick(items, options),
      confirm: (options) => confirm(options),
      statusBar(options) {
        const item = addStatusItem({
          side: options.side ?? "right",
          title: options.title,
          onClick: options.onClick && (() => void guard("a status bar click", options.onClick!)()),
        });
        return { setText: item.setText, dispose: track(item.dispose) };
      },
      fileMenu: (item) =>
        track(
          addFileMenuItem({
            key: `${id}:${item.title}`,
            title: item.title,
            when: item.when && ((entry) => guard(`${item.title}: when`, item.when!)({ ...entry }) ?? false),
            run: (entry) => void guard(item.title, item.run)({ ...entry }),
          }),
        ),
      addStyles(css) {
        const style = document.createElement("style");
        style.dataset.plugin = id;
        style.textContent = css;
        document.head.append(style);
        return track(() => style.remove());
      },
      setIcon: (element, icon) => drawIcon(element, icon),
    },

    themes: {
      register: (theme) => track(registerTheme({ ...theme, id: scoped(theme.id) })),
      isDark: () => useTheme.getState().appearance === "dark",
      onChange(listener) {
        const call = guard("reacting to the theme", listener);
        return track(useTheme.subscribe(() => call()));
      },
    },

    settings: {
      get: <T,>(key: string) => (key in data.settings ? data.settings[key] : defaults.get(key)) as T,
      async set(key, value) {
        settingChanged(key, value);
        await save(data);
      },
      onChange(listener) {
        const call = guard("reacting to a setting", listener);
        settingListeners.add(call);
        return track(() => settingListeners.delete(call));
      },
    },

    storage: {
      get: <T,>(key: string) => data.storage[key] as T | undefined,
      async set(key, value) {
        data.storage[key] = value;
        await save(data);
      },
      async delete(key) {
        delete data.storage[key];
        await save(data);
      },
    },

    net: {
      async fetch(url, options = {}) {
        if (!token) throw new Error("this plugin has no network access");
        const response = await api.pluginFetch(token, { url, ...options }).catch((e) => {
          throw new Error(errorMessage(e));
        });
        return {
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          headers: response.headers,
          text: () => response.body,
          json: () => JSON.parse(response.body),
        };
      },
    },
  };

  return {
    context,
    settingChanged,
    dispose() {
      disposed = true;
      // Last registered, first undone.
      for (const undo of [...disposers].reverse()) {
        try {
          undo();
        } catch (e) {
          onError("cleaning up", e);
        }
      }
      disposers.clear();
    },
  };
}
