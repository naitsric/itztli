/**
 * Itztli's plugin API, version 1.
 *
 * A plugin is a folder with `plugin.json` and `main.js`, an ES module whose
 * default export is a `Plugin`:
 *
 *     export default {
 *       activate(ctx) {
 *         ctx.commands.register({ id: "hello", title: "Say Hello", run: () => ctx.ui.notify("Hello") });
 *       },
 *     };
 *
 * Whatever is registered through `ctx` is undone when the plugin stops, so
 * most plugins need no `deactivate`. Every `register` also returns a function
 * that undoes it earlier.
 *
 * Paths are relative to the vault and use `/`: `Projects/Plan.md`.
 */
declare module "@itztli/plugin-api" {
  export interface Plugin {
    activate(ctx: PluginContext): void | Promise<void>;
    /** For what wasn't registered through `ctx`. */
    deactivate?(): void | Promise<void>;
  }

  export type Dispose = () => void;
  type Awaitable<T> = T | Promise<T>;

  export interface PluginContext {
    readonly id: string;
    readonly manifest: Manifest;
    readonly app: { readonly version: string; readonly platform: string };

    readonly commands: Commands;
    readonly toolWindows: ToolWindows;
    readonly editor: Editor;
    readonly markdown: Markdown;
    readonly contextActions: ContextActions;
    readonly fileViewers: FileViewers;
    readonly vault: Vault;
    readonly notes: Notes;
    readonly workspace: Workspace;
    readonly ui: UI;
    readonly themes: Themes;
    readonly settings: Settings;
    readonly storage: Storage;
    readonly net: Net;
    /** The app's own copies of the libraries the editor is made of. */
    readonly modules: Modules;

    /** Address of a file in the plugin's `assets` folder: `asset("logo.svg")`. */
    asset(file: string): string;
    /** Runs when the plugin stops. */
    onDispose(dispose: Dispose): void;
  }

  export interface Manifest {
    id: string;
    name: string;
    version: string;
    api: number;
    description: string;
    author: string;
    homepage: string | null;
    network: string[];
    settings: SettingDefinition[];
  }

  export interface SettingDefinition {
    key: string;
    title: string;
    description?: string;
    type: "boolean" | "string" | "text" | "number" | "select";
    default?: unknown;
    options?: { value: string; label: string }[];
  }

  // ── Commands ────────────────────────────────────────────────────────────

  export interface Commands {
    /**
     * Adds an action. It shows up in Find Action, the keymap settings and
     * the menu bar.
     */
    register(command: CommandDefinition): Dispose;
    /** Runs any command of the app or of a plugin: `"file.newNote"`, `"my-plugin.hello"`. */
    execute(id: string): void;
  }

  export interface CommandDefinition {
    /** Unique in the plugin; elsewhere it is known as `<plugin id>.<id>`. */
    id: string;
    title: string;
    /**
     * Keys, as `"$mod+Shift+KeyD"`. `$mod` is ⌘ on macOS. The user can
     * change it, and the app's own keys win.
     */
    keybinding?: string;
    /** Only bind the keys while the caret is in a note. */
    context?: "editor";
    keywords?: string[];
    enabled?(): boolean;
    run(): Awaitable<void>;
  }

  // ── Tool windows ────────────────────────────────────────────────────────

  export interface ToolWindows {
    /** Adds a window on a side of the workbench, with its button in the stripe. */
    register(toolWindow: ToolWindowDefinition): ToolWindowHandle;
  }

  export interface ToolWindowDefinition {
    id: string;
    title: string;
    /** An icon's name (see docs/plugins.md) or an `<svg>`. */
    icon: string;
    side: "left" | "right" | "bottom";
    /** Called when it is first shown; whatever it returns runs when it closes. */
    mount(element: HTMLElement): Dispose | void;
  }

  export interface ToolWindowHandle {
    show(): void;
    hide(): void;
    /** A short text on its button, such as a count. */
    setBadge(text: string | null): void;
    dispose: Dispose;
  }

  // ── Editor ──────────────────────────────────────────────────────────────

  export interface Editor {
    /** The editor with the caret, or the last one that had it. */
    active(): ActiveEditor | null;
    /**
     * Extends every note editor with a CodeMirror 6 extension, made with
     * `ctx.modules`. Extensions can be swapped at any time: register the new
     * one and dispose of the old.
     */
    registerExtension(extension: CodeMirrorExtension): Dispose;
    /** Offers completions while typing. */
    registerCompletion(source: CompletionSource): Dispose;
    onSelectionChange(listener: (editor: ActiveEditor) => void): Dispose;
    onDocumentChange(listener: (editor: ActiveEditor) => void): Dispose;
  }

  /** Any CodeMirror `Extension`. */
  export type CodeMirrorExtension = object | readonly CodeMirrorExtension[];

  export interface ActiveEditor {
    readonly path: string;
    /** The note's name, without folder or extension. */
    readonly name: string;
    text(): string;
    /** Replaces the whole text, as one change that can be undone. */
    setText(text: string): void;
    selection(): { from: number; to: number; text: string };
    replaceSelection(text: string): void;
    insert(at: number, text: string): void;
    replace(from: number, to: number, text: string): void;
    /** The line of a position, zero-based, with its text. */
    lineAt(position: number): { number: number; from: number; to: number; text: string };
    select(from: number, to?: number): void;
    focus(): void;
    /** The CodeMirror `EditorView`, for anything else. */
    readonly view: any;
  }

  /** Called with the text of the line up to the caret. */
  export type CompletionSource = (request: {
    path: string;
    before: string;
    position: number;
    /** Whether it was asked for with ⌃Space rather than by typing. */
    explicit: boolean;
  }) => Awaitable<CompletionList | null>;

  export interface CompletionList {
    /** How many characters before the caret the options replace. */
    replace: number;
    options: { label: string; detail?: string; insert?: string }[];
  }

  // ── Markdown ────────────────────────────────────────────────────────────

  export interface Markdown {
    /**
     * Draws the fenced code blocks of a language, in the editor (while the
     * caret is elsewhere) and in previews. Whatever it returns runs when the
     * drawing is removed. Throwing shows the message in its place.
     */
    registerCodeBlock(
      language: string,
      render: (source: string, element: HTMLElement, info: { path: string }) => Dispose | void,
    ): Dispose;
    /** Changes what previews show, once drawn. */
    registerPostProcessor(process: (element: HTMLElement, info: { path: string }) => void): Dispose;
    /** Markdown as it shows in previews. */
    render(markdown: string, element: HTMLElement, info?: { path: string }): Dispose;
  }

  // ── Context actions (⌥⏎) ────────────────────────────────────────────────

  export interface ContextActions {
    /** Offers actions for where the caret is. */
    register(provider: (context: ActionContext) => ContextAction[]): Dispose;
  }

  export interface ActionContext {
    readonly editor: ActiveEditor;
    readonly line: string;
    readonly selection: string;
    /** The link under the caret, if there is one. */
    readonly link: { target: string; subpath: string | null; path: string | null } | null;
  }

  export interface ContextAction {
    title: string;
    run(): Awaitable<void>;
  }

  // ── File viewers ────────────────────────────────────────────────────────

  export interface FileViewers {
    /** Shows files the app doesn't: by extension, without the dot. */
    register(viewer: {
      id: string;
      extensions: string[];
      mount(element: HTMLElement, file: ViewedFile): Dispose | void;
    }): Dispose;
  }

  export interface ViewedFile {
    readonly path: string;
    /** An address for the file, for images, audio and video. */
    readonly url: string;
    read(): Promise<string>;
    write(text: string): Promise<void>;
    onChange(listener: () => void): Dispose;
  }

  // ── Vault ───────────────────────────────────────────────────────────────

  export interface Vault {
    readonly name: string;
    /** Every file and folder; hidden ones are not part of the vault. */
    list(folder?: string): FileEntry[];
    get(path: string): FileEntry | null;
    read(path: string): Promise<string>;
    /** Replaces a file's text. What it replaces stays in Local History. */
    write(path: string, text: string): Promise<void>;
    /**
     * Reads a file, changes its text and writes it, again if someone else
     * wrote it meanwhile. Prefer it to `read` and `write`.
     */
    modify(path: string, change: (text: string) => string): Promise<void>;
    /** Fails if it exists. Creates the folders it needs. */
    create(path: string, text?: string): Promise<void>;
    createFolder(path: string): Promise<void>;
    /** Moves or renames, keeping every link to it working. */
    move(from: string, to: string): Promise<void>;
    /** Moves to the system trash. */
    trash(path: string): Promise<void>;
    /** An address for a file, for `<img>` and the like. */
    url(path: string): string;
    onChange(listener: (change: VaultChange) => void): Dispose;
  }

  export interface FileEntry {
    path: string;
    folder: boolean;
    size: number;
    /** Milliseconds since the epoch. */
    modified: number;
  }

  export type VaultChange =
    | { kind: "put"; path: string; created: boolean }
    | { kind: "remove"; path: string }
    | { kind: "move"; from: string; to: string };

  // ── Notes: what they say ────────────────────────────────────────────────

  export interface Notes {
    /** `null` for what is not a note. */
    meta(path: string): Promise<NoteMeta | null>;
    /** Notes that link to one, with the line of each link. */
    backlinks(path: string): Promise<{ path: string; links: { line: number; col: number; context: string }[] }[]>;
    /** The file a link in `source` leads to, or `null`. */
    resolve(target: string, source: string): Promise<string | null>;
    /** What to write in a wiki link from `source` to reach `path`. */
    linkText(path: string, source: string): Promise<string>;
    tags(): Promise<{ name: string; notes: number }[]>;
    withTag(tag: string): Promise<string[]>;
    tasks(): Promise<{ path: string; line: number; done: boolean; text: string }[]>;
    /** Finds files by name, as Go to Note does. */
    find(query: string, limit?: number): Promise<{ path: string; alias: string | null }[]>;
    /** Finds text in notes, as Find in Files does. */
    search(text: string, options?: { regex?: boolean; matchCase?: boolean; folder?: string; limit?: number }): Promise<
      { path: string; matches: { line: number; col: number; len: number; preview: string }[] }[]
    >;
  }

  export interface NoteMeta {
    title: string | null;
    frontmatter: Record<string, unknown> | null;
    aliases: string[];
    tags: { name: string; line: number; col: number }[];
    headings: { level: number; text: string; line: number }[];
    links: { kind: string; target: string; subpath: string | null; display: string | null; line: number; col: number; len: number }[];
    tasks: { done: boolean; text: string; line: number }[];
    words: number;
  }

  // ── Workspace ───────────────────────────────────────────────────────────

  export interface Workspace {
    /** The open note or file that is in front. */
    activePath(): string | null;
    onActiveNoteChange(listener: (path: string | null) => void): Dispose;
    open(path: string, options?: { line?: number; col?: number; split?: boolean; focus?: boolean }): void;
    /** Lines are zero-based everywhere in this API. */
    openPaths(): string[];
  }

  // ── UI ──────────────────────────────────────────────────────────────────

  export interface UI {
    notify(message: string, options?: { kind?: "info" | "warning" | "error"; actions?: { title: string; run(): void }[] }): void;
    /** Asks for a line of text. `null` when cancelled. */
    input(options: { title: string; placeholder?: string; value?: string; validate?(value: string): string | null }): Promise<string | null>;
    /** Asks to choose one, with fuzzy search. `null` when cancelled. */
    pick<T>(items: { title: string; detail?: string; value: T }[], options?: { title?: string; placeholder?: string }): Promise<T | null>;
    confirm(options: { title: string; message?: string; action?: string; danger?: boolean }): Promise<boolean>;
    /** Adds an item to the status bar. */
    statusBar(options: { side?: "left" | "right"; title?: string; onClick?(): void }): StatusBarItem;
    /** Adds an item to the menu of files and folders. */
    fileMenu(item: { title: string; when?(entry: FileEntry): boolean; run(entry: FileEntry): Awaitable<void> }): Dispose;
    /** Adds styles while the plugin runs; `styles.css` needs no call. */
    addStyles(css: string): Dispose;
    /** Fills an element with one of the app's icons. */
    setIcon(element: HTMLElement, icon: string): void;
  }

  export interface StatusBarItem {
    setText(text: string | null): void;
    dispose: Dispose;
  }

  // ── Themes ──────────────────────────────────────────────────────────────

  export interface Themes {
    /** Offers a theme in Settings → Appearance. */
    register(theme: ThemeDefinition): Dispose;
    /** Whether the theme in use is dark. */
    isDark(): boolean;
    onChange(listener: () => void): Dispose;
  }

  export interface ThemeDefinition {
    id: string;
    name: string;
    appearance: "dark" | "light";
    /** The CSS variables it changes, without the dashes: `{ accent: "#ff8800" }`. */
    colors: Record<string, string>;
  }

  // ── Settings, storage and network ───────────────────────────────────────

  export interface Settings {
    /** A setting from the manifest, or its default. */
    get<T = any>(key: string): T;
    set(key: string, value: unknown): Promise<void>;
    onChange(listener: (key: string, value: unknown) => void): Dispose;
  }

  /** The plugin's own data, saved as JSON in the vault. */
  export interface Storage {
    get<T = any>(key: string): T | undefined;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  }

  export interface Net {
    /** Requests an address at one of the origins in the manifest's `network`. */
    fetch(url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<NetResponse>;
  }

  export interface NetResponse {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    text(): string;
    json<T = any>(): T;
  }

  export interface Modules {
    "@codemirror/autocomplete": any;
    "@codemirror/commands": any;
    "@codemirror/language": any;
    "@codemirror/lint": any;
    "@codemirror/search": any;
    "@codemirror/state": any;
    "@codemirror/view": any;
    "@lezer/common": any;
    "@lezer/highlight": any;
    "@lezer/markdown": any;
  }
}
