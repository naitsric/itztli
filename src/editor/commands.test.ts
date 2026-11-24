// @vitest-environment happy-dom
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

vi.mock("../backend/host", () => ({ host: { listen: () => () => {}, call: vi.fn(), ask: vi.fn(), desktop: false } }));
const c = await import("./commands");
const { noteLanguage } = await import("./syntax");
const { formatTable, splitRow } = await import("./tables");

/** An editor over text with `|` at the caret, or around the selection. */
function editor(marked: string) {
  const at = marked.indexOf("|");
  const end = marked.indexOf("|", at + 1);
  const doc = marked.replaceAll("|", "");
  const state = EditorState.create({
    doc,
    selection: { anchor: at, head: end < 0 ? at : end - 1 },
    extensions: [noteLanguage(), c.selectionStack],
  });
  const view = new EditorView({ state });
  forceParsing(view, doc.length, 1000);
  return view;
}

function shown(view: EditorView): string {
  const { from, to, empty } = view.state.selection.main;
  const text = view.state.doc.toString();
  return empty ? `${text.slice(0, from)}|${text.slice(from)}` : `${text.slice(0, from)}|${text.slice(from, to)}|${text.slice(to)}`;
}

const after = (marked: string, run: (view: EditorView) => void) => {
  const view = editor(marked);
  run(view);
  return shown(view);
};

describe("toggleWrap", () => {
  const bold = (v: EditorView) => c.toggleWrap(v, "**");
  const italic = (v: EditorView) => c.toggleWrap(v, "*");
  it("wraps the selection or the word, and back", () => {
    expect(after("a |bc| d", bold)).toBe("a **|bc|** d");
    expect(after("a **|bc|** d", bold)).toBe("a |bc| d");
    expect(after("a |**bc**| d", bold)).toBe("a |bc| d");
    expect(after("a b|c d", bold)).toBe("a **b|c** d");
    expect(after("a **b|c** d", bold)).toBe("a b|c d");
    expect(after("|", bold)).toBe("**|**");
  });
  it("does not mistake bold for italics", () => {
    expect(after("**|b|**", italic)).toBe("***|b|***");
    expect(after("***|b|***", italic)).toBe("**|b|**");
    expect(after("*|b|*", italic)).toBe("|b|");
  });
});

describe("lines", () => {
  it("sets and takes off headings", () => {
    expect(after("a|b", (v) => c.setHeading(v, 2))).toBe("## a|b");
    expect(after("## a|b", (v) => c.setHeading(v, 2))).toBe("a|b");
    expect(after("# a|b", (v) => c.setHeading(v, 3))).toBe("### a|b");
    expect(after("# a|b", (v) => c.changeHeadingLevel(v, 1))).toBe("## a|b");
    expect(after("# a|b", (v) => c.changeHeadingLevel(v, -1))).toBe("# a|b");
  });
  it("toggles lists and quotes", () => {
    expect(after("|a\nb|", (v) => c.toggleList(v, "bullet"))).toBe("- |a\n- b|");
    expect(after("- a\n- |b", (v) => c.toggleList(v, "bullet"))).toBe("- a\n|b");
    expect(after("|- a\n- b|", (v) => c.toggleList(v, "ordered"))).toBe("|1. a\n2. b|");
    expect(after("a|", (v) => c.toggleList(v, "quote"))).toBe("> a|");
    expect(after("> a|", (v) => c.toggleList(v, "quote"))).toBe("a|");
  });
  it("toggles tasks", () => {
    expect(after("a|b", c.toggleTask)).toBe("- [ ] a|b");
    expect(after("- a|b", c.toggleTask)).toBe("- [ ] a|b");
    expect(after("- [ ] a|b", c.toggleTask)).toBe("- [x] a|b");
    expect(after("  1. [x] a|b", c.toggleTask)).toBe("  1. [ ] a|b");
  });
  it("joins lines without their markers", () => {
    expect(after("a|\n  b", c.joinLines)).toBe("a|  b".replace("  ", " "));
    expect(after("- a|\n- [ ] b", c.joinLines)).toBe("- a| b");
    expect(after("a|", c.joinLines)).toBe("a|");
  });
});

describe("selection", () => {
  it("extends outwards and retraces its steps", () => {
    const view = editor("# T\n\n## A\n\na **bo|ld** c\nd\n\n## B\n\ntwo");
    const steps: string[] = [];
    while (c.extendSelection(view)) {
      steps.push(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to));
    }
    expect(steps).toEqual([
      "bold",
      "**bold**",
      "a **bold** c",
      "a **bold** c\nd",
      "## A\n\na **bold** c\nd\n\n",
      "# T\n\n## A\n\na **bold** c\nd\n\n## B\n\ntwo",
    ]);
    for (let i = 0; i < 4; i++) c.shrinkSelection(view);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("**bold**");
    c.shrinkSelection(view);
    c.shrinkSelection(view);
    expect(view.state.selection.main.empty).toBe(true);
    expect(c.shrinkSelection(view)).toBe(false);
  });
});

describe("moveStatement", () => {
  const up = (v: EditorView) => c.moveStatement(v, -1);
  const down = (v: EditorView) => c.moveStatement(v, 1);
  it("moves list items with what they hold", () => {
    expect(after("- a\n- |b\n  - c\n- d", up)).toBe("- |b\n  - c\n- a\n- d");
    expect(after("- a\n- |b\n  - c\n- d", down)).toBe("- a\n- d\n- |b\n  - c");
    expect(after("- |a\n- b", up)).toBe("- |a\n- b");
  });
  it("moves sections among their siblings", () => {
    const doc = "# T\n\n## |A\n\na\n\n### A1\n\n## B\n\nb\n\n# U\n\n## C\n";
    expect(after(doc, down)).toBe("# T\n\n## B\n\nb\n\n## |A\n\na\n\n### A1\n\n# U\n\n## C\n");
    expect(after("# T\n\n## A\n\n## |B\n\n# U\n\n## C\n", down)).toBe("# T\n\n## A\n\n## |B\n\n# U\n\n## C\n");
    expect(after("# T\n\n# U\n\n## |C\n\n## D", up)).toBe("# T\n\n# U\n\n## |C\n\n## D");
  });
  it("leaves other lines to someone else", () => {
    expect(c.moveStatement(editor("text|"), 1)).toBe(false);
  });
});

describe("tables", () => {
  it("splits rows minding escapes and code", () => {
    expect(splitRow("| a | b \\| c | `d | e` |")).toEqual(["a", "b \\| c", "`d | e`"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
    expect(splitRow("| a | |")).toEqual(["a", ""]);
  });
  it("aligns columns", () => {
    expect(formatTable("|a|b|c|\n|--|:-:|-:|\n|long one|x|1|\n|é|📚|22")).toBe(
      ["| a        |  b  |   c |", "| -------- | :-: | --: |", "| long one |  x  |   1 |", "| é        | 📚  |  22 |"].join("\n"),
    );
    expect(formatTable("a\nb")).toBeNull();
  });
  it("reformats in place, as one change", () => {
    const view = editor("|t\n\n");
    view.dispatch({ changes: { from: view.state.doc.length, insert: "|a|b|\n|-|-|\n|long|2|\n" } });
    forceParsing(view, view.state.doc.length, 1000);
    expect(c.reformat(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("t\n\n| a    | b   |\n| ---- | --- |\n| long | 2   |\n");
    expect(c.reformat(view)).toBe(false);
  });
});
