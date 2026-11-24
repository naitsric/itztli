import type { Plugin } from "@itztli/plugin-api";

const pad = (n: number) => String(n).padStart(2, "0");

/** A template's text with its placeholders filled in, and where the caret goes. */
export function fill(template: string, title: string, now: Date): { text: string; cursor: number | null } {
  const values: Record<string, string> = {
    title,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
  const filled = template.replace(/\{\{\s*(title|date|time)\s*\}\}/g, (_, key: string) => values[key]!);
  const at = filled.search(/\{\{\s*cursor\s*\}\}/);
  return { text: filled.replace(/\{\{\s*cursor\s*\}\}/g, ""), cursor: at < 0 ? null : at };
}

const plugin: Plugin = {
  activate(ctx) {
    const folder = () => String(ctx.settings.get("folder") ?? "").replace(/^\/+|\/+$/g, "");
    ctx.commands.register({
      id: "insert",
      title: "Insert Template…",
      keybinding: "$mod+KeyJ",
      keywords: ["live template", "snippet"],
      enabled: () => ctx.editor.active() !== null,
      async run() {
        const templates = ctx.vault.list(folder()).filter((e) => !e.folder && /\.md$/i.test(e.path));
        if (!folder() || templates.length === 0) {
          ctx.ui.notify(`There are no templates in “${folder() || "/"}”. Write a note there to have one.`);
          return;
        }
        const editor = ctx.editor.active();
        const path = await ctx.ui.pick(
          templates.map((e) => ({ title: e.path.slice(folder().length + 1, -3), value: e.path })),
          { title: "Insert Template" },
        );
        if (!path || !editor) return;
        const { from } = editor.selection();
        const { text, cursor } = fill(await ctx.vault.read(path), editor.name, new Date());
        editor.replaceSelection(text);
        if (cursor !== null) editor.select(from + cursor);
        editor.focus();
      },
    });
  },
};

export default plugin;
