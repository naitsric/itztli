import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { frontmatterEnd, noteLanguage } from "./syntax";

/** The nodes of a kind, by the text they cover. */
function nodes(doc: string, ...names: string[]): string[] {
  const state = EditorState.create({ doc, extensions: noteLanguage() });
  const found: string[] = [];
  ensureSyntaxTree(state, doc.length, 5000)!.iterate({
    enter: (node) => {
      if (names.includes(node.name)) found.push(state.sliceDoc(node.from, node.to));
    },
  });
  return found;
}

describe("wiki links", () => {
  it("finds targets and what they show", () => {
    expect(nodes("a [[B]] c [[D#e|f]] ![[g.png|300]]", "WikiLink", "Embed")).toEqual(["[[B]]", "[[D#e|f]]", "![[g.png|300]]"]);
    expect(nodes("[[D#e|f]] ![[g.png|300]]", "WikiLinkTarget")).toEqual(["D#e", "g.png"]);
    expect(nodes("[[D#e|f]]", "WikiLinkText")).toEqual(["f"]);
  });

  it("leaves code and broken links alone", () => {
    expect(nodes("`[[no]]` [[a\nb]] [[]] [[x [[ok]]", "WikiLink")).toEqual(["[[ok]]"]);
    expect(nodes("```\n[[no]]\n```", "WikiLink")).toEqual([]);
  });

  it("works in tables, where the pipe is escaped", () => {
    const doc = "| a | b |\n|---|---|\n| [[T\\|text]] | x |";
    expect(nodes(doc, "WikiLinkTarget")).toEqual(["T"]);
    expect(nodes(doc, "WikiLinkText")).toEqual(["text"]);
  });

  it("does not take plain Markdown links", () => {
    expect(nodes("[a](b.md) [c][d] ![e](f.png)", "WikiLink", "Embed")).toEqual([]);
    expect(nodes("[a](b.md) ![e](f.png)", "Link", "Image")).toEqual(["[a](b.md)", "![e](f.png)"]);
  });
});

describe("tags", () => {
  it("agrees with the backend on what a tag is", () => {
    expect(nodes("#one and #two/three, #año_2 #🚀 #2026 #y2026", "Tag")).toEqual(["#one", "#two/three", "#año_2", "#🚀", "#y2026"]);
    expect(nodes("`#code` a#b \\#escaped", "Tag")).toEqual([]);
    expect(nodes("- #list\n\n> #quote\n\n## Heading #in", "Tag")).toEqual(["#list", "#quote", "#in"]);
    expect(nodes("#trailing/ x", "Tag")).toEqual(["#trailing"]);
  });

  it("leaves headings as headings", () => {
    expect(nodes("# Title", "Tag")).toEqual([]);
    expect(nodes("# Title", "ATXHeading1")).toEqual(["# Title"]);
  });
});

describe("the rest", () => {
  it("highlights, comments and block ids", () => {
    expect(nodes("a ==b c== d == e == f", "Highlight")).toEqual(["==b c=="]);
    expect(nodes("a %%b [[c]]%% d", "NoteComment")).toEqual(["%%b [[c]]%%"]);
    expect(nodes("a %%b [[c]]%% d", "WikiLink")).toEqual([]);
    expect(nodes("text ^id-1\n\nnot ^this one", "BlockId")).toEqual(["^id-1"]);
  });

  it("reads frontmatter only at the top, and only when closed", () => {
    expect(nodes("---\na: 1\n---\n# T", "Frontmatter")).toEqual(["---\na: 1\n---"]);
    expect(nodes("---\n---\ntext", "Frontmatter")).toEqual(["---\n---"]);
    expect(nodes("---\na: 1\n\n\n", "Frontmatter")).toEqual([]);
    expect(nodes("text\n\n---\na: 1\n---\n", "Frontmatter")).toEqual([]);
    expect(nodes("---\n\n\n\nb: 1\n---\n# T", "Frontmatter")).toEqual(["---\n\n\n\nb: 1\n---"]);
  });

  it("knows where frontmatter ends without parsing", () => {
    const end = (doc: string) => frontmatterEnd(EditorState.create({ doc }).doc);
    expect(end("---\na: 1\n---\n# T")).toBe(12);
    expect(end("---\na: 1")).toBeNull();
    expect(end("# T")).toBeNull();
    expect(end("")).toBeNull();
  });
});
