# Contributing to Itztli

Itztli is a Tauri 2 app: a React + TypeScript UI over a Rust core. This guide
covers running it, testing it and how the code is organized. To write a plugin
you need none of this: see [docs/plugins.md](docs/plugins.md).

## Requirements

- macOS 13+ with Xcode Command Line Tools, or Linux with
  [Tauri's dependencies](https://tauri.app/start/prerequisites/)
- Rust (`rustup`), Node 22+ and pnpm

## Develop

```sh
pnpm install
pnpm app                      # the app, with hot reload
pnpm dev:web ~/some/vault     # the UI alone, in a browser, on a real vault
```

`dev:web` runs the same backend behind a local HTTP server
(`crates/itztli-devserver`) instead of Tauri. It is the quickest way to work on
the UI. Files deleted there go to `target/dev-web/trash`.

## Test

```sh
pnpm typecheck
pnpm test          # UI unit tests (vitest)
pnpm test:rust     # the backend
pnpm test:e2e      # the real UI in WebKit against the real backend
```

The end-to-end tests need `cargo build -p itztli-devserver` and
`pnpm exec playwright install webkit` once. `pnpm test:e2e rename` runs those
with “rename” in their name; screenshots of failures go to `e2e/output`.

## Project layout

```
src/                 React UI
  backend/           typed commands, and the host they run on (desktop or browser)
  commands/          command registry, keymap, app commands
  menu/              native menu bar model, built from the command registry
  vault/             the open vault: entries, session, what is remembered about it
  editor/            documents and the CodeMirror 6 editor: syntax, live preview,
                     links, completion, context actions, editing commands
  preview/           Markdown outside the editor: previews, embeds
  workbench/         window chrome, tabs, tool windows, navigation
  toolwindows/       what is in them
  search/            Search Everywhere, Find in Files, popups
  plugins/           the plugin host, and the `ctx` plugins work with
  builtin/           features of the app that are plugins
  mcp/               the MCP server's UI: activity, clients and their access,
                     the dialog that approves changes
  settings/          settings, their dialog and the keymap
packages/plugin-api/ the plugin API's types: its contract
examples/plugins/    plugins to learn from
src-tauri/           the desktop host: window, native dialogs, custom protocols
crates/
  itztli-core/       notes as data: paths, links, tags, headings, tasks
  itztli-vault/      a vault on disk: confined paths, safe writes, watching
  itztli-index/      the index: resolution, search, graph, link-preserving moves
  itztli-history/    local history (SQLite, outside the vault)
  itztli-plugins/    plugins on disk: manifests, consent, what may be loaded
  itztli-backend/    everything above behind one `call(command, args)`
  itztli-mcp/        the MCP server: tools, access, approvals, audit log, and the
                     stdio bridge to it (`itztli mcp-bridge`)
  itztli-devserver/  the backend over HTTP, for development and the e2e tests
```

## Architecture notes

**Commands.** Every user action is a registered command
(`src/commands/registry.ts`) with an id, a title, a category and optionally a
keybinding and a focus context. Registering it is enough for it to appear in
Search Everywhere, the keymap settings and the native menu bar. Plugins'
commands are the same thing. Several commands may share a key when they declare
different contexts, or when only one is enabled (⌘B follows a link, or is bold).

**One backend, two hosts.** `Backend::call` runs every command. The Tauri app
and the development server are thin hosts over it, so what the end-to-end tests
drive is what ships. A new command goes in
`crates/itztli-backend/src/commands.rs` and, typed, in `src/backend/api.ts`.

**What is not a command.** Plugins run in the same page as the UI, so any
command is theirs to call. What widens what the page may do (opening a folder
the user never picked, enabling a plugin, loading images from the web) is
therefore a method the host calls only after asking in a *native* dialog, which
the page can't answer. Keep it that way: see `src-tauri/src/consent.rs`.

**Links.** The backend parses notes with `pulldown-cmark`; the editor with
Lezer. They must agree on what a link or a tag is: change both, and the tests
next to each. Positions cross the boundary as zero-based lines and UTF-16
columns.

**Moving files.** `Index::move_entry` has one rule: every link that led to a
file still leads to it. It notes where links lead, applies the move, and
rewrites only those that now lead elsewhere. Its tests check exactly that, for
every link of the vault.

**Documents.** One per path, however many editors show it
(`src/editor/documents.ts`). Saving sends the revision the change is based on,
and the backend refuses if the file holds another.

**The index** has no database: parsing a vault takes less than opening one
would, and what is never stored is never stale. The watcher only says *where*
something may have changed; `Workspace::reconcile` looks at the disk.

**Plugins.** `src/plugins/context.ts` implements the API; everything it
registers is tracked and undone when the plugin stops, and every call into a
plugin is guarded. Consent is bound to a fingerprint of the plugin's files,
which are read once, checked and served from memory. The API's version is
`API_VERSION` in `crates/itztli-plugins`: adding to the API is fine; changing
what is there needs a new version that keeps running the old one.

**MCP.** `crates/itztli-mcp` serves the open vault to MCP clients over
Streamable HTTP on `127.0.0.1`, with the official SDK (rmcp). Each host gives
it a `Host` and two commands: `mcp`, which looks and answers approvals, and
`mcp_change`, which is everything that changes who may do what. A `Change` that
gives a program more than it had comes with a `Question`, and the host asks it
in a native dialog; `McpServer::change` is the only way to make one. A tool
that reads implements `ReadTool`; one that writes implements `WriteTool`, whose
`plan` works out the change the user sees, made later on exactly that (or at
once, for a client the user lets change notes without asking). Every call
leaves one row in the audit log, whatever happens to it. Its settings, clients
and log are in `mcp.db`, in the app's data folder.

Clients that only launch stdio servers run the app's own executable as
`itztli mcp-bridge --port <port>`, with the token in `ITZTLI_MCP_TOKEN`.
`src-tauri/src/main.rs` checks for it before building Tauri, so no window
appears. To try the server without the desktop app, run `pnpm dev:web`, connect
a client from the MCP tool window, and
`claude mcp add --transport http itztli http://127.0.0.1:7413/mcp --header "Authorization: Bearer <token>"`.

**Security model**: see [SECURITY.md](SECURITY.md).

## Pull requests

- Keep each PR focused; describe what changed, why, and how it was tested.
- `pnpm typecheck`, `pnpm test`, `pnpm test:rust`, `pnpm test:e2e`,
  `cargo fmt --check` and clippy without warnings must pass; CI checks the same.
- Behavior gets a test where it lives: pure functions in vitest, the backend in
  Rust, what spans both in `e2e/run.mjs`.
