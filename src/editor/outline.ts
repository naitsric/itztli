import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface OutlineItem {
  level: number;
  text: string;
  /** Zero-based. */
  line: number;
  from: number;
}

/** The headings of a note as it is now, saved or not. */
export function outline(state: EditorState): OutlineItem[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  const found: OutlineItem[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const match = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!match) continue;
    const line = state.doc.lineAt(node.from);
    const text = line.text.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "").replace(/\s\^[A-Za-z0-9-]+$/, "");
    found.push({ level: Number(match[2]), text: plainText(text), line: line.number - 1, from: node.from });
  }
  return found;
}

/** Inline Markdown as it reads. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==|`)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
    .trim();
}

/** The same way the backend compares them (crates/itztli-core/src/section.rs). */
function headingKey(text: string): string {
  return text.replace(/[#^|[\]\\:]/g, " ").split(/\s+/).filter(Boolean).join(" ").normalize("NFC").toLowerCase();
}

/** The line a `Heading`, `Heading#Sub` or `^block` is at. */
export function lineOfSubpath(state: EditorState, subpath: string): number | null {
  if (subpath.startsWith("^")) {
    const id = subpath.slice(1).toLowerCase();
    for (let n = 1; n <= state.doc.lines; n++) {
      const match = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(state.doc.line(n).text);
      if (match?.[1]!.toLowerCase() === id) return n - 1;
    }
    return null;
  }
  const headings = outline(state);
  let from = 0;
  let found: OutlineItem | null = null;
  for (const part of subpath.split("#").filter((p) => p.trim())) {
    const at = headings.findIndex((h, i) => i >= from && headingKey(h.text) === headingKey(plainText(part)));
    if (at < 0) return found?.line ?? null;
    found = headings[at]!;
    from = at + 1;
  }
  return found?.line ?? null;
}
