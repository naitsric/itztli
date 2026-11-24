import type { Dispose, Plugin } from "@itztli/plugin-api";

/** The lines of the paragraph a line is in. */
export function paragraphAround(lineText: (n: number) => string, lines: number, at: number): { first: number; last: number } {
  const blank = (n: number) => !lineText(n).trim();
  let first = at;
  let last = at;
  if (blank(at)) return { first, last };
  while (first > 1 && !blank(first - 1)) first--;
  while (last < lines && !blank(last + 1)) last++;
  return { first, last };
}

const plugin: Plugin = {
  activate(ctx) {
    const { Decoration, EditorView, ViewPlugin } = ctx.modules["@codemirror/view"];
    const { RangeSetBuilder } = ctx.modules["@codemirror/state"];
    const dim = Decoration.line({ class: "itztli-dimmed" });

    const decorate = (view: any) => {
      const { doc, selection } = view.state;
      const { first, last } = paragraphAround((n) => doc.line(n).text, doc.lines, doc.lineAt(selection.main.head).number);
      const builder = new RangeSetBuilder();
      for (const range of view.visibleRanges) {
        for (let n = doc.lineAt(range.from).number; n <= doc.lineAt(range.to).number; n++) {
          if (n < first || n > last) builder.add(doc.line(n).from, doc.line(n).from, dim);
        }
      }
      return builder.finish();
    };

    const dimming = ViewPlugin.fromClass(
      class {
        decorations: unknown;
        constructor(view: unknown) {
          this.decorations = decorate(view);
        }
        update(update: any) {
          if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = decorate(update.view);
        }
      },
      { decorations: (p: { decorations: unknown }) => p.decorations },
    );
    const typewriter = EditorView.updateListener.of((update: any) => {
      if (!update.selectionSet && !update.docChanged) return;
      if (update.transactions.some((tr: any) => tr.isUserEvent("select.pointer"))) return;
      const head = update.state.selection.main.head;
      queueMicrotask(() => update.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }));
    });

    ctx.ui.addStyles(".itztli-dimmed { opacity: 0.32; transition: opacity 120ms; }");
    let stop: Dispose | null = null;
    const start = () => {
      stop = ctx.editor.registerExtension(ctx.settings.get<boolean>("typewriter") ? [dimming, typewriter] : [dimming]);
    };
    ctx.commands.register({
      id: "toggle",
      title: "Toggle Focus Mode",
      keywords: ["zen", "typewriter", "distraction"],
      async run() {
        if (stop) {
          stop();
          stop = null;
        } else start();
        await ctx.storage.set("on", stop !== null);
      },
    });
    ctx.settings.onChange(() => {
      if (!stop) return;
      stop();
      start();
    });
    if (ctx.storage.get<boolean>("on")) start();
  },
};

export default plugin;
