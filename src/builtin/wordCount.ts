import type { ActiveEditor, Plugin } from "@itztli/plugin-api";

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

const plugin: Plugin = {
  activate(ctx) {
    const item = ctx.ui.statusBar({ side: "right", title: "Words in the note, or in the selection" });
    let timer = 0;
    const show = (editor: ActiveEditor | null) => {
      window.clearTimeout(timer);
      // Counting a long note on every key would be felt.
      timer = window.setTimeout(() => {
        if (!editor || editor.path !== ctx.workspace.activePath()) return item.setText(null);
        const selected = editor.selection().text;
        const text = selected || editor.text().replace(/^---\n[\s\S]*?\n---\n/, "");
        const words = `${countWords(text).toLocaleString()} words`;
        const characters = ctx.settings.get<boolean>("characters") ? `, ${text.length.toLocaleString()} characters` : "";
        item.setText(words + characters);
      }, 120);
    };
    const refresh = () => show(ctx.editor.active());
    ctx.editor.onDocumentChange(show);
    ctx.editor.onSelectionChange(show);
    ctx.workspace.onActiveNoteChange(() => window.setTimeout(refresh, 60));
    ctx.settings.onChange(refresh);
    ctx.onDispose(() => window.clearTimeout(timer));
    refresh();
  },
};

export default plugin;
