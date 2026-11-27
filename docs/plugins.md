# Writing plugins

A plugin is a folder with two files. No build step, no account, no approval.

```
my-plugin/
  plugin.json     what it is
  main.js         what it does
  styles.css      optional
  assets/         optional: images, fonts, data
```

## In one minute

1. Run **New Plugin…** from Find Action (⇧⌘A), and name it.
2. Choose **Enable for development**.
3. Edit `main.js` in any editor. It reloads every time you save.

What you get is a working plugin with a command, a tool window, a setting and
`itztli.d.ts`, the API's types: your editor completes and checks `main.js` with
it, without installing anything.

```js
export default {
  activate(ctx) {
    ctx.commands.register({
      id: "hello",
      title: "Say Hello",
      keybinding: "$mod+Alt+KeyH",
      run: () => ctx.ui.notify("Hello"),
    });
  },
};
```

Whatever is registered through `ctx` is undone when the plugin stops, so most
plugins need no `deactivate`.

## `plugin.json`

```json
{
  "id": "word-cloud",
  "name": "Word Cloud",
  "version": "1.0.0",
  "api": 1,
  "description": "Draws the words of a note.",
  "author": "You",
  "homepage": "https://example.com",
  "main": "main.js",
  "styles": "styles.css",
  "network": ["https://api.example.com"],
  "settings": [
    { "key": "max", "title": "Words to show", "type": "number", "default": 50 }
  ]
}
```

- `id`: lowercase letters, digits and dashes. The folder has the same name.
- `api`: the version of the API it is written for. Now, `1`.
- `network`: the origins it connects to. Shown before enabling it; nothing else
  can be reached. Plain `http` only for `localhost`.
- `settings`: become a page in Settings. Types: `boolean`, `string`, `text`,
  `number` and `select` (with `options: [{ value, label }]`).

## Where plugins live

- In a vault, `.itztli/plugins/<id>`: travels with it.
- In the app, for every vault: Settings → Plugins → Install from Disk.

An installed plugin hides a vault's with the same id.

## What `ctx` offers

The whole API, documented, is
[`packages/plugin-api/index.d.ts`](../packages/plugin-api/index.d.ts). In short:

| | |
| --- | --- |
| `ctx.commands` | actions, with keys: Find Action, keymap, menu bar |
| `ctx.toolWindows` | windows on the sides of the workbench |
| `ctx.editor` | the note being written, CodeMirror extensions, completions |
| `ctx.markdown` | code block renderers, post-processing previews |
| `ctx.contextActions` | entries of ⌥⏎ |
| `ctx.fileViewers` | showing other kinds of files |
| `ctx.vault` | reading, writing, moving, hearing of changes |
| `ctx.notes` | what notes say: links (and the property each is in), backlinks, type, tags, tasks, search |
| `ctx.workspace` | what is open, opening things |
| `ctx.ui` | notifications, questions, status bar, menus, styles |
| `ctx.themes` | themes, as changes to the app's colors |
| `ctx.settings`, `ctx.storage` | settings and data, saved in the vault |
| `ctx.net` | the network, for the origins in the manifest |
| `ctx.modules` | the app's CodeMirror and Lezer |

### Draw a code block

```js
ctx.markdown.registerCodeBlock("progress", (source, element) => {
  const bar = document.createElement("progress");
  bar.max = 100;
  bar.value = Number(source);
  element.append(bar);
});
```

### A tool window

```js
const recent = ctx.toolWindows.register({
  id: "recent",
  title: "Recently Changed",
  icon: "clock",
  side: "right",
  mount(element) {
    const render = () => {
      const notes = ctx.vault.list().filter((e) => e.path.endsWith(".md"));
      notes.sort((a, b) => b.modified - a.modified);
      element.replaceChildren(...notes.slice(0, 20).map(({ path }) => {
        const row = document.createElement("div");
        row.textContent = path;
        row.onclick = () => ctx.workspace.open(path);
        return row;
      }));
    };
    render();
    return ctx.vault.onChange(render); // undone when the window closes
  },
});
recent.setBadge("3");
```

`icon` is an `<svg>…</svg>`, or one of: activity, alert, archive, at-sign,
backlinks, bell, book, book-open, bookmark, bot, brain, bug, calendar,
calendar-days, chart, check, circle-check, clock, cloud, code, columns,
database, eye, file, file-text, filter, flag, flame, folder, folder-open, gauge,
git-branch, globe, grid, hash, heart, home, image, inbox, info, kanban, key,
keyboard, languages, lightbulb, link, list, list-checks, list-tree, lock, mail,
map, message, moon, music, network, palette, panel-bottom, panel-left,
panel-right, pen, pin, play, puzzle, quote, refresh, rss, search, settings,
share, sparkles, star, sun, table, tag, terminal, timer, type, user, users,
wand, warning, zap.

### Change notes safely

```js
await ctx.vault.modify("Inbox.md", (text) => text + "\n- one more thing");
```

`modify` reads, changes and writes, and starts again if someone else wrote in
between. If the note is open it changes there, and can be undone. Whatever is
replaced stays in Local History.

### Extend the editor

Use the app's CodeMirror, from `ctx.modules`; a copy of your own would not work
with it.

```js
const { ViewPlugin, Decoration, MatchDecorator } = ctx.modules["@codemirror/view"];
const todo = new MatchDecorator({ regexp: /TODO/g, decoration: Decoration.mark({ class: "my-todo" }) });

ctx.editor.registerExtension(
  ViewPlugin.define(
    (view) => ({
      deco: todo.createDeco(view),
      update(u) { this.deco = todo.updateDeco(u, this.deco); },
    }),
    { decorations: (v) => v.deco },
  ),
);
ctx.ui.addStyles(".my-todo { color: var(--warning); font-weight: 600; }");
```

### A theme

```js
ctx.themes.register({
  id: "mine",
  name: "Mine",
  appearance: "dark",
  colors: { "bg-panel": "#101418", accent: "#ff8800", link: "#ffb366" },
});
```

The variables are in [`src/styles/app.css`](../src/styles/app.css). Styles that
use them (`color: var(--fg-muted)`) follow any theme.

## TypeScript and npm packages

Bundle to one `main.js`. Modules the app shares have to stay the app's:

```js
import { build } from "esbuild";
import { sharedModules } from "@itztli/plugin-api/esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "esm",
  plugins: [sharedModules()],
});
```

Only `plugin.json`, the main and styles files, and `assets/` are loaded; sources
and `node_modules` next to them are ignored.

## Trust

A plugin sees your notes. So:

- One that comes with a vault stays off until you enable it, on each computer.
- Enabling it is for the files as they are. If they change, it stops until you
  review it.
- *Enable for development* trusts the folder instead, so it can reload as you
  write. Only for code you are writing.
- If a plugin hangs the app while starting, the next start leaves it out.
  **Restart in Safe Mode** starts without any.

What plugins can and can't do is in [SECURITY.md](../SECURITY.md).

## Sharing

Put the folder in a repository and have people install it from disk. There is no
directory of plugins yet.
