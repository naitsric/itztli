import { copyLineDown, deleteLine, moveLineDown, moveLineUp, redo, undo } from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { findNext, findPrevious, openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import {
  copyLink,
  copyText,
  duplicateEntry,
  extractToNote,
  moveToFolder,
  newFolder,
  newNote,
  openExternally,
  renameEntry,
  revealInFileManager,
  trashEntry,
} from "../actions";
import { api } from "../backend/api";
import { host } from "../backend/host";
import { input } from "../dialogs/ask";
import { showLocalHistory } from "../dialogs/LocalHistoryDialog";
import { activeView } from "../editor/active";
import * as edit from "../editor/commands";
import { saveAll } from "../editor/documents";
import { followAt } from "../editor/extensions";
import { linkAt, tagAt } from "../editor/links";
import { openWithReplace } from "../editor/findPanel";
import { showQuickDoc } from "../editor/quickDoc";
import { goToProblem } from "../editor/problems";
import { refreshPlugins, reloadPlugin, usePlugins } from "../plugins/host";
import { useFindResults } from "../search/findState";
import { showPopup } from "../search/popupState";
import { useSearchEverywhere } from "../search/searchState";
import { showSettings } from "../settings/dialogState";
import { installPlugin, newPlugin } from "../settings/PluginsPage";
import { settings, updateSettings } from "../settings/store";
import { toggleBookmark } from "../toolwindows/bookmarks";
import { showTag } from "../toolwindows/tagSelection";
import { revealInVault, useVaultSelection } from "../toolwindows/vaultReveal";
import { folderOfSelection } from "../toolwindows/VaultWindow";
import { notify } from "../ui/notifications";
import { displayName, isNote } from "../vault/paths";
import { closeVault, pickVault, prepareToQuit } from "../vault/session";
import { entryAt, useVault } from "../vault/store";
import {
  closeActiveTab,
  closeAllTabs,
  closeOtherTabs,
  cycleTab,
  focusEditor,
  goBack,
  goForward,
  hasTabs,
  splitActive,
  useEditorArea,
} from "../workbench/editorArea";
import { focusedToolWindow, hideToolWindow, resetToolWindows, toggleAllToolWindows, toggleToolWindow, showToolWindow } from "../workbench/toolWindows";
import { focusContext, registerCommands, type Command } from "./registry";

const hasVault = () => useVault.getState().info !== null;
const activePath = () => useEditorArea.getState().activePath;
const hasEditor = () => activeView() !== null;

/** The file an action is about: the one selected in the vault tree, if it has the keyboard; else the one in front. */
function target(): string | null {
  if (focusContext() === "vault" || focusedToolWindow() === "vault") return useVaultSelection.getState().path;
  return activePath() ?? useVaultSelection.getState().path;
}
const hasTarget = () => {
  const path = target();
  return path !== null && entryAt(path) !== undefined;
};
const onTarget = (action: (path: string) => void | Promise<void>) => () => {
  const path = target();
  if (path) return action(path);
};

/** A command of the editor: bound only there, and run on the one with the caret. */
function editing(command: Omit<Command, "run" | "enabled" | "context"> & { run: (view: EditorView) => unknown; global?: boolean }): Command {
  const { run, global, ...rest } = command;
  return {
    ...rest,
    context: global ? undefined : "editor",
    enabled: hasEditor,
    run: async () => {
      const view = activeView();
      if (!view) return;
      // Before, not after: a command may give the keyboard to something else,
      // and no key may land in the note on the way there.
      view.focus();
      await run(view);
    },
  };
}

const toolWindow = (id: string, title: string, digit: number): Command => ({
  id: `view.toolWindow.${id}`,
  title,
  category: "Tool Windows",
  keybinding: `$mod+Digit${digit}`,
  enabled: hasVault,
  run: () => toggleToolWindow(id),
});

async function findUsages(path: string) {
  const usages = await api.usages(path);
  useFindResults.setState({ results: { kind: "usages", title: `usages of ${displayName(path)}`, usages } });
  showToolWindow("find");
}

async function extract(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const source = activePath();
  if (from === to || !source) return notify("Select what to extract first");
  const made = await extractToNote(source, view.state.sliceDoc(from, to));
  if (made) view.dispatch({ changes: { from, to, insert: made.link }, selection: { anchor: from + made.link.length }, userEvent: "input.extract" });
}

async function quit() {
  if (await prepareToQuit()) await api.appQuit();
}

/** Every app-wide command. Panels only render; behavior lives here and in actions.ts. */
export function registerAppCommands(): () => void {
  const commands: Command[] = [
    // ── Navigate ──
    { id: "search.everywhere", title: "Search Everywhere", category: "Navigate", enabled: hasVault, run: () => useSearchEverywhere.getState().show("all") },
    { id: "search.findAction", title: "Find Action", category: "Navigate", keybinding: "$mod+Shift+KeyA", keywords: ["command palette"], run: () => useSearchEverywhere.getState().show("actions") },
    { id: "navigate.note", title: "Go to Note", category: "Navigate", keybinding: "$mod+KeyO", keywords: ["open", "quick switcher"], enabled: hasVault, run: () => useSearchEverywhere.getState().show("notes") },
    { id: "navigate.file", title: "Go to File", category: "Navigate", keybinding: "$mod+Shift+KeyO", enabled: hasVault, run: () => useSearchEverywhere.getState().show("files") },
    { id: "navigate.heading", title: "Go to Heading", category: "Navigate", keybinding: "$mod+Alt+KeyO", keywords: ["symbol"], enabled: hasVault, run: () => useSearchEverywhere.getState().show("headings") },
    { id: "navigate.recent", title: "Recent Files", category: "Navigate", keybinding: "$mod+KeyE", enabled: hasVault, run: () => showPopup("recentFiles") },
    { id: "navigate.structure", title: "File Structure", category: "Navigate", keybinding: "$mod+F12", keywords: ["outline", "headings"], enabled: hasEditor, run: () => showPopup("structure") },
    { id: "navigate.back", title: "Back", category: "Navigate", keybinding: "$mod+BracketLeft", enabled: () => useEditorArea.getState().canGoBack, run: goBack },
    { id: "navigate.forward", title: "Forward", category: "Navigate", keybinding: "$mod+BracketRight", enabled: () => useEditorArea.getState().canGoForward, run: goForward },
    // On a link, ⌘B goes where it leads, as in IntelliJ; elsewhere it is bold, as in any text.
    {
      ...editing({
        id: "navigate.declaration",
        title: "Go to Declaration",
        category: "Navigate",
        keybinding: "$mod+KeyB",
        keywords: ["follow link", "open link"],
        run: (view) => followAt(view, view.state.selection.main.head, { onTag: showTag }),
      }),
      enabled: canFollow,
    },
    editing({ id: "navigate.declarationSplit", title: "Open Link in a Split", category: "Navigate", keybinding: "$mod+Shift+KeyB", run: (view) => followAt(view, view.state.selection.main.head, { split: true, onTag: showTag }) }),
    { id: "navigate.findUsages", title: "Find Usages", category: "Navigate", keybinding: "Alt+F7", keywords: ["backlinks", "references"], enabled: hasTarget, run: onTarget(findUsages) },
    editing({ id: "navigate.quickDoc", title: "Quick Documentation", category: "Navigate", keybinding: "F1", keywords: ["preview", "peek"], run: (view) => showQuickDoc(view) }),
    { id: "navigate.selectInVault", title: "Select in Vault", category: "Navigate", keybinding: "Alt+F1", enabled: () => activePath() !== null, run: () => revealInVault(activePath()!) },
    editing({ id: "navigate.line", title: "Go to Line", category: "Navigate", keybinding: "$mod+KeyL", run: goToLine }),
    editing({ id: "navigate.nextProblem", title: "Next Problem", category: "Navigate", keybinding: "F2", run: (view) => goToProblem(view, 1) }),
    editing({ id: "navigate.previousProblem", title: "Previous Problem", category: "Navigate", keybinding: "Shift+F2", run: (view) => goToProblem(view, -1) }),
    editing({
      id: "navigate.bookmark",
      title: "Toggle Bookmark",
      category: "Navigate",
      keybinding: "F3",
      run: (view) => {
        const path = activePath();
        if (!path) return;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const first = line.number === 1;
        const added = toggleBookmark(first ? { path } : { path, line: line.number - 1, text: line.text.trim().slice(0, 80) });
        notify(added ? "Bookmarked" : "Bookmark removed");
      },
    }),

    // ── File ──
    { id: "file.newNote", title: "New Note…", category: "File", keybinding: "$mod+KeyN", enabled: hasVault, run: () => (focusContext() === "vault" ? newNote(folderOfSelection()) : newNote()) },
    { id: "file.newFolder", title: "New Folder…", category: "File", enabled: hasVault, run: () => newFolder(folderOfSelection()) },
    { id: "file.save", title: "Save All", category: "File", keybinding: "$mod+KeyS", enabled: hasVault, run: saveAll },
    { id: "file.localHistory", title: "Local History…", category: "File", keywords: ["revisions", "versions", "restore"], enabled: () => hasTarget() && isNote(target()!), run: onTarget(showLocalHistory) },
    { id: "file.copyLink", title: "Copy Link", category: "File", enabled: () => hasTarget() && !entryAt(target()!)?.folder, run: onTarget(copyLink) },
    { id: "file.copyPath", title: "Copy Path", category: "File", keybinding: "$mod+Shift+KeyC", enabled: hasTarget, run: onTarget(copyText) },
    { id: "file.reveal", title: "Show in Folder", category: "File", keywords: ["finder", "explorer"], enabled: hasTarget, run: onTarget(revealInFileManager) },
    { id: "file.openExternally", title: "Open with Its App", category: "File", enabled: () => hasTarget() && !entryAt(target()!)?.folder, run: onTarget(openExternally) },

    // ── Vault ──
    { id: "vault.open", title: "Open Folder as Vault…", category: "Vault", run: () => pickVault() },
    { id: "vault.new", title: "New Vault with a Tour…", category: "Vault", run: () => pickVault(true) },
    { id: "vault.reveal", title: "Show Vault in Folder", category: "Vault", enabled: hasVault, run: () => revealInFileManager("") },
    { id: "vault.close", title: "Close Vault", category: "Vault", enabled: hasVault, run: closeVault },

    // ── Find ──
    editing({ id: "search.find", title: "Find…", category: "Find", keybinding: "$mod+KeyF", run: (view) => openFind(view, false) }),
    editing({ id: "search.replace", title: "Replace…", category: "Find", keybinding: "$mod+KeyR", run: (view) => openFind(view, true) }),
    editing({ id: "search.next", title: "Find Next", category: "Find", keybinding: "$mod+KeyG", run: findNext }),
    editing({ id: "search.previous", title: "Find Previous", category: "Find", keybinding: "$mod+Shift+KeyG", run: findPrevious }),
    { id: "search.findInFiles", title: "Find in Files…", category: "Find", keybinding: "$mod+Shift+KeyF", keywords: ["grep", "search"], enabled: hasVault, run: () => showPopup("findInFiles") },

    // ── Edit ──
    editing({ id: "edit.contextActions", title: "Show Context Actions", category: "Edit", keybinding: "Alt+Enter", keywords: ["intentions", "quick fix"], run: () => showPopup("contextActions") }),
    editing({ id: "edit.duplicate", title: "Duplicate Line or Selection", category: "Edit", keybinding: "$mod+KeyD", run: duplicate }),
    editing({ id: "edit.deleteLine", title: "Delete Line", category: "Edit", keybinding: "$mod+Backspace", run: deleteLine }),
    editing({ id: "edit.moveLineUp", title: "Move Line Up", category: "Edit", keybinding: "Alt+Shift+ArrowUp", run: moveLineUp }),
    editing({ id: "edit.moveLineDown", title: "Move Line Down", category: "Edit", keybinding: "Alt+Shift+ArrowDown", run: moveLineDown }),
    editing({ id: "edit.moveStatementUp", title: "Move Statement Up", category: "Edit", keybinding: "$mod+Shift+ArrowUp", keywords: ["section", "list item"], run: (view) => edit.moveStatement(view, -1) || moveLineUp(view) }),
    editing({ id: "edit.moveStatementDown", title: "Move Statement Down", category: "Edit", keybinding: "$mod+Shift+ArrowDown", keywords: ["section", "list item"], run: (view) => edit.moveStatement(view, 1) || moveLineDown(view) }),
    editing({ id: "edit.extendSelection", title: "Extend Selection", category: "Edit", keybinding: "Alt+ArrowUp", run: edit.extendSelection }),
    editing({ id: "edit.shrinkSelection", title: "Shrink Selection", category: "Edit", keybinding: "Alt+ArrowDown", run: edit.shrinkSelection }),
    editing({ id: "edit.nextOccurrence", title: "Add Next Occurrence", category: "Edit", keybinding: "Control+KeyG", keywords: ["multiple cursors"], run: selectNextOccurrence }),
    editing({ id: "edit.allOccurrences", title: "Select All Occurrences", category: "Edit", keybinding: "Control+$mod+KeyG", keywords: ["multiple cursors"], run: selectSelectionMatches }),
    editing({ id: "edit.joinLines", title: "Join Lines", category: "Edit", keybinding: "Control+Shift+KeyJ", run: edit.joinLines }),
    editing({ id: "edit.startNewLine", title: "Start New Line", category: "Edit", keybinding: "Shift+Enter", run: edit.startNewLine }),
    editing({ id: "edit.toggleTask", title: "Toggle Task", category: "Edit", keybinding: "$mod+Enter", keywords: ["checkbox", "todo"], run: edit.toggleTask }),
    editing({ id: "edit.comment", title: "Comment Out", category: "Edit", keybinding: "$mod+Slash", run: (view) => edit.toggleWrap(view, "%%") }),
    editing({ id: "edit.undo", title: "Undo in Note", category: "Edit", run: undo }),
    editing({ id: "edit.redo", title: "Redo in Note", category: "Edit", run: redo }),

    // ── Format ──
    editing({ id: "format.bold", title: "Bold", category: "Format", keybinding: "$mod+KeyB", run: (view) => edit.toggleWrap(view, "**") }),
    editing({ id: "format.italic", title: "Italic", category: "Format", keybinding: "$mod+KeyI", run: (view) => edit.toggleWrap(view, "*") }),
    editing({ id: "format.strike", title: "Strikethrough", category: "Format", keybinding: "$mod+Shift+KeyS", run: (view) => edit.toggleWrap(view, "~~") }),
    editing({ id: "format.highlight", title: "Highlight", category: "Format", keybinding: "$mod+Shift+KeyH", run: (view) => edit.toggleWrap(view, "==") }),
    editing({ id: "format.code", title: "Code", category: "Format", keybinding: "$mod+Alt+KeyC", run: (view) => edit.toggleWrap(view, "`") }),
    editing({ id: "format.wikiLink", title: "Wiki Link", category: "Format", keybinding: "$mod+KeyK", keywords: ["insert link"], run: (view) => edit.toggleWrap(view, "[[", "]]") }),
    ...[1, 2, 3, 4, 5, 6].map((level) =>
      editing({ id: `format.heading${level}`, title: `Heading ${level}`, category: "Format", keybinding: `Control+Digit${level}`, run: (view) => edit.setHeading(view, level) }),
    ),
    editing({ id: "format.bullet", title: "Bulleted List", category: "Format", run: (view) => edit.toggleList(view, "bullet") }),
    editing({ id: "format.ordered", title: "Numbered List", category: "Format", run: (view) => edit.toggleList(view, "ordered") }),
    editing({ id: "format.quote", title: "Quote", category: "Format", run: (view) => edit.toggleList(view, "quote") }),
    editing({ id: "format.reformat", title: "Reformat Tables", category: "Format", keybinding: "$mod+Alt+KeyL", keywords: ["align", "reformat code"], run: (view) => edit.reformat(view) || notify("Nothing to reformat") }),

    // ── Refactor ──
    { id: "refactor.rename", title: "Rename…", category: "Refactor", keybinding: "Shift+F6", enabled: hasTarget, run: onTarget(renameEntry) },
    { id: "refactor.move", title: "Move…", category: "Refactor", keybinding: "F6", enabled: hasTarget, run: onTarget(moveToFolder) },
    { id: "refactor.duplicate", title: "Copy…", category: "Refactor", keybinding: "F5", enabled: () => hasTarget() && !entryAt(target()!)?.folder, run: onTarget(duplicateEntry) },
    editing({ id: "refactor.extract", title: "Extract to Note…", category: "Refactor", keybinding: "$mod+Alt+KeyM", keywords: ["extract method"], run: extract }),
    { id: "refactor.delete", title: "Move to Trash…", category: "Refactor", keybinding: "$mod+Backspace", context: "vault", enabled: hasTarget, run: onTarget(trashEntry) },

    // ── Tool windows ──
    toolWindow("vault", "Vault", 1),
    toolWindow("bookmarks", "Bookmarks", 2),
    toolWindow("find", "Find", 3),
    toolWindow("backlinks", "Backlinks", 4),
    toolWindow("tags", "Tags", 5),
    toolWindow("problems", "Problems", 6),
    toolWindow("structure", "Structure", 7),
    toolWindow("graph", "Graph", 8),
    { id: "view.hideToolWindow", title: "Hide Active Tool Window", category: "Tool Windows", keybinding: "Shift+Escape", enabled: () => focusedToolWindow() !== null, run: () => hideToolWindow(focusedToolWindow()!) },
    { id: "view.hideAllToolWindows", title: "Hide All Tool Windows", category: "Tool Windows", keybinding: "$mod+Shift+F12", enabled: hasVault, run: toggleAllToolWindows },
    { id: "view.resetLayout", title: "Restore Default Layout", category: "Tool Windows", enabled: hasVault, run: resetToolWindows },
    { id: "view.focusEditor", title: "Focus Editor", category: "Tool Windows", keybinding: "Escape", enabled: () => focusedToolWindow() !== null && !isTyping(), run: focusEditor },

    // ── Tabs ──
    { id: "tabs.close", title: "Close Tab", category: "Tabs", keybinding: "$mod+KeyW", enabled: hasTabs, run: closeActiveTab },
    { id: "tabs.closeOthers", title: "Close Other Tabs", category: "Tabs", enabled: hasTabs, run: closeOtherTabs },
    { id: "tabs.closeAll", title: "Close All Tabs", category: "Tabs", enabled: hasTabs, run: closeAllTabs },
    { id: "tabs.next", title: "Next Tab", category: "Tabs", keybinding: "$mod+Shift+BracketRight", enabled: hasTabs, run: () => cycleTab(1) },
    { id: "tabs.previous", title: "Previous Tab", category: "Tabs", keybinding: "$mod+Shift+BracketLeft", enabled: hasTabs, run: () => cycleTab(-1) },
    { id: "tabs.splitRight", title: "Split Right", category: "Tabs", enabled: () => activePath() !== null, run: () => splitActive("right") },
    { id: "tabs.splitDown", title: "Split Down", category: "Tabs", enabled: () => activePath() !== null, run: () => splitActive("below") },

    // ── View ──
    { id: "view.livePreview", title: "Toggle Live Preview", category: "View", keybinding: "$mod+Shift+KeyP", keywords: ["source mode", "markdown"], run: () => updateSettings({ editor: { livePreview: !settings().editor.livePreview } }) },
    { id: "view.lineNumbers", title: "Toggle Line Numbers", category: "View", run: () => updateSettings({ editor: { lineNumbers: !settings().editor.lineNumbers } }) },
    { id: "view.spellcheck", title: "Toggle Spelling", category: "View", run: () => updateSettings({ editor: { spellcheck: !settings().editor.spellcheck } }) },
    { id: "view.attachments", title: "Toggle Attachments in Vault", category: "View", run: () => updateSettings({ files: { showAttachments: !settings().files.showAttachments } }) },
    editing({ id: "view.fold", title: "Fold", category: "View", keybinding: "$mod+Minus", run: foldCode }),
    editing({ id: "view.unfold", title: "Unfold", category: "View", keybinding: "$mod+Equal", run: unfoldCode }),
    editing({ id: "view.foldAll", title: "Fold All", category: "View", keybinding: "$mod+Shift+Minus", run: foldAll }),
    editing({ id: "view.unfoldAll", title: "Unfold All", category: "View", keybinding: "$mod+Shift+Equal", run: unfoldAll }),
    { id: "view.larger", title: "Increase Font Size", category: "View", run: () => resizeText(1) },
    { id: "view.smaller", title: "Decrease Font Size", category: "View", run: () => resizeText(-1) },

    // ── Appearance ──
    ...(["system", "light", "dark"] as const).map(
      (theme): Command => ({
        id: `appearance.theme.${theme}`,
        title: `Theme: ${theme[0]!.toUpperCase()}${theme.slice(1)}`,
        category: "Appearance",
        run: () => updateSettings({ appearance: { theme } }),
      }),
    ),
    {
      id: "appearance.translucent",
      title: "Toggle Translucent Frame",
      category: "Appearance",
      enabled: () => host.desktop,
      run: () => updateSettings({ appearance: { translucent: !settings().appearance.translucent } }),
    },

    // ── Plugins ──
    { id: "plugins.manage", title: "Plugins…", category: "Plugins", run: () => showSettings("plugins") },
    { id: "plugins.new", title: "New Plugin…", category: "Plugins", keywords: ["create", "develop"], enabled: hasVault, run: newPlugin },
    { id: "plugins.install", title: "Install Plugin from Disk…", category: "Plugins", run: installPlugin },
    {
      id: "plugins.reload",
      title: "Reload Plugins in Development",
      category: "Plugins",
      enabled: hasVault,
      run: async () => {
        await refreshPlugins();
        for (const p of usePlugins.getState().plugins) if (p.info?.development) await reloadPlugin(p.id);
      },
    },
    { id: "plugins.safeMode", title: "Restart in Safe Mode", category: "Plugins", keywords: ["without plugins"], enabled: () => host.desktop, run: async () => ((await prepareToQuit()) ? api.appRestart(true) : undefined) },

    // ── Application ──
    { id: "app.settings", title: "Settings…", category: "Application", keybinding: "$mod+Comma", keywords: ["preferences"], run: () => showSettings() },
    { id: "app.keymap", title: "Keymap…", category: "Application", keywords: ["shortcuts", "keys"], run: () => showSettings("keymap") },
    { id: "app.quit", title: "Quit Itztli", category: "Application", keybinding: "$mod+KeyQ", enabled: () => host.desktop, run: quit },
  ];
  return registerCommands(commands);
}

function duplicate(view: EditorView) {
  const { state } = view;
  if (state.selection.ranges.every((r) => r.empty)) return copyLineDown(view);
  view.dispatch(
    state.update({
      changes: state.selection.ranges.filter((r) => !r.empty).map((r) => ({ from: r.to, insert: state.sliceDoc(r.from, r.to) })),
      userEvent: "input.duplicate",
      scrollIntoView: true,
    }),
  );
  return true;
}

function openFind(view: EditorView, replace: boolean) {
  openWithReplace(replace);
  openSearchPanel(view);
  view.dom.querySelector<HTMLInputElement>(".cm-find-panel [main-field]")?.focus();
}

async function goToLine(view: EditorView) {
  const answer = await input({
    title: "Go to Line",
    placeholder: `1–${view.state.doc.lines}, or line:column`,
    action: "Go",
    validate: (value) => (/^\d+(:\d+)?$/.test(value.trim()) ? null : "A number, or line:column"),
  });
  if (!answer) return;
  const [line, col = 1] = answer.trim().split(":").map(Number);
  const to = view.state.doc.line(Math.min(Math.max(line!, 1), view.state.doc.lines));
  view.dispatch({ selection: { anchor: Math.min(to.from + col - 1, to.to) }, scrollIntoView: true });
}

function resizeText(by: number) {
  updateSettings({ editor: { size: Math.min(40, Math.max(9, settings().editor.size + by)) } });
}

/** Escape is first for what is being typed: a field, or a tree's speed search. */
function isTyping(): boolean {
  return !!document.activeElement?.closest("input, textarea, [contenteditable=true], [data-speed-search]");
}

/** Whether there is something at the caret to go to. Selected text is for formatting. */
function canFollow(): boolean {
  const view = activeView();
  if (!view || !view.state.selection.main.empty) return false;
  const head = view.state.selection.main.head;
  return linkAt(view.state, head) !== null || tagAt(view.state, head) !== null;
}
