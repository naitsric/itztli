import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { linkAt, markdownLink, relativePath, splitTarget, tagAt, wikiLink } from "./links";
import { noteLanguage } from "./syntax";

function at(marked: string) {
  const pos = marked.indexOf("|>");
  const doc = marked.replace("|>", "");
  const state = EditorState.create({ doc, extensions: noteLanguage() });
  ensureSyntaxTree(state, doc.length, 5000);
  return { state, pos };
}

const link = (marked: string) => {
  const { state, pos } = at(marked);
  return linkAt(state, pos);
};

describe("linkAt", () => {
  it("reads every kind of link", () => {
    expect(link("a [[No|>te#H|shown]] b")).toMatchObject({ kind: "wiki", target: "Note", subpath: "H", display: "shown", relative: false });
    expect(link("![[im|>g.png|300]]")).toMatchObject({ kind: "embed", target: "img.png", display: "300" });
    expect(link("[te|>xt](../a%20b.md#x%20y)")).toMatchObject({ kind: "markdown", target: "../a b.md", subpath: "x y", display: "text", relative: true });
    expect(link("![a|>lt](p.png)")).toMatchObject({ kind: "image", target: "p.png" });
    expect(link("[w](https://x|>.y)")).toMatchObject({ kind: "url", target: "https://x.y" });
    expect(link("see https://x.y/z|>")).toMatchObject({ kind: "url", target: "https://x.y/z" });
    expect(link("<https://x|>.y>")).toMatchObject({ kind: "url", target: "https://x.y" });
  });

  it("works at both ends and not beyond", () => {
    expect(link("a |>[[b]] c")).toMatchObject({ target: "b" });
    expect(link("a [[b]]|> c")).toMatchObject({ target: "b" });
    expect(link("a [[b]] |>c")).toBeNull();
    expect(link("`[[b|>]]`")).toBeNull();
  });

  it("finds links in the frontmatter", () => {
    expect(link('---\nup: "[[Ho|>me|h]]"\n---\n')).toMatchObject({ target: "Home", display: "h" });
    expect(link("---\nup: |>x\n---\n")).toBeNull();
  });
});

describe("tagAt", () => {
  it("is the tag without its hash", () => {
    const { state, pos } = at("a #work/q|>4 b");
    expect(tagAt(state, pos)).toBe("work/q4");
  });
});

describe("writing links", () => {
  it("round trips", () => {
    expect(splitTarget("A#b#c")).toEqual({ target: "A", subpath: "b#c" });
    expect(wikiLink("A", "b", "c")).toBe("[[A#b|c]]");
    expect(markdownLink("a b (1).md", "x y", "t")).toBe("[t](a%20b%20%281%29.md#x%20y)");
    expect(relativePath("a/b/n.md", "a/c/x.md")).toBe("../c/x.md");
    expect(relativePath("n.md", "a/x.md")).toBe("a/x.md");
  });
});
