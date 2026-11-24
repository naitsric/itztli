// @ts-check
/// <reference path="./itztli.d.ts" />

/** @type {import("@itztli/plugin-api").Plugin} */
const plugin = {
  activate(ctx) {
    // A command: it shows up in Find Action, the keymap and the Tools menu.
    ctx.commands.register({
      id: "greet",
      title: "{{name}}: Insert Greeting",
      keybinding: "$mod+Alt+Shift+KeyG",
      enabled: () => ctx.editor.active() !== null,
      run() {
        const editor = ctx.editor.active();
        editor?.replaceSelection(`${ctx.settings.get("greeting")}, ${editor.name}!`);
      },
    });

    // A tool window: anything you can build in an element.
    ctx.toolWindows.register({
      id: "main",
      title: "{{name}}",
      icon: "puzzle",
      side: "right",
      mount(element) {
        const list = document.createElement("div");
        list.className = "{{id}}-panel";
        element.append(list);
        const render = () => {
          const path = ctx.workspace.activePath();
          list.textContent = path ? `You are in ${path}` : "No note is open.";
        };
        render();
        // Whatever is registered inside is cleaned up by the returned function.
        return ctx.workspace.onActiveNoteChange(render);
      },
    });
  },
};

export default plugin;
