---
tags: [guide, guide/plugins]
---
# Plugins

A plugin is a folder with two files: `plugin.json` and `main.js`. No build
step, no account, no approval.

1. Run **New Plugin…** from Find Action (⇧⌘A).
2. Enable it for development.
3. Edit `main.js`. It reloads every time you save.

```js
export default {
  activate(ctx) {
    ctx.commands.register({
      id: "hello",
      title: "Say Hello",
      run: () => ctx.ui.notify("Hello from my plugin"),
    });
  },
};
```

Plugins can add commands, tool windows, editor behavior, completions, context
actions, code block renderers, file viewers, themes and settings. Several of
Itztli's own features are plugins written against the same API.

> [!warning] Plugins are code
> A plugin sees your notes. Plugins that come with a vault stay off until you
> enable them, and one that changes is reviewed again before it runs.

Back to [[Welcome]].
