# Example plugins

Plugins to read, change and start from. To try one: Settings → Plugins →
Install from Disk…, choose its folder, and enable it.

- **csv-table**: a code block renderer and a file viewer.
- **volcan-theme**: two themes.
- **local-llm**: the network (a model on your own computer), settings, context
  actions and the editor.

The app's own plugins, in [`src/builtin`](../../src/builtin), are written
against the same API: commands, tool windows, the status bar, CodeMirror
extensions, storage.
