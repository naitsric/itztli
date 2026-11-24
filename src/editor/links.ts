import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/** A link in the text: where it is and where it leads. */
export interface LinkRef {
  kind: "wiki" | "embed" | "markdown" | "image" | "url";
  from: number;
  to: number;
  /** The file part; the whole address for `url`. */
  target: string;
  subpath: string | null;
  /** What is shown instead of the target, if anything. */
  display: string | null;
  /** The target is a path from the note, as in plain Markdown. */
  relative: boolean;
}

const EXTERNAL = /^([a-z][a-z0-9+.-]+:|\/\/)/i;

export function isExternal(target: string): boolean {
  return EXTERNAL.test(target);
}

/** `Note#Heading` in two. */
export function splitTarget(raw: string): { target: string; subpath: string | null } {
  const at = raw.indexOf("#");
  if (at < 0) return { target: raw.trim(), subpath: null };
  return { target: raw.slice(0, at).trim(), subpath: raw.slice(at + 1).trim() || null };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Reads a link node of the syntax tree. `null` for what leads nowhere. */
export function readLink(state: EditorState, node: SyntaxNode): LinkRef | null {
  const text = (n: SyntaxNode | null) => (n ? state.sliceDoc(n.from, n.to) : null);
  const at = { from: node.from, to: node.to };
  switch (node.name) {
    case "WikiLink":
    case "Embed": {
      const raw = text(node.getChild("WikiLinkTarget"));
      if (!raw) return null;
      const display = text(node.getChild("WikiLinkText"))?.trim() || null;
      return { ...at, kind: node.name === "Embed" ? "embed" : "wiki", ...splitTarget(raw), display, relative: false };
    }
    case "Link":
    case "Image": {
      const url = text(node.getChild("URL"))?.replace(/^<|>$/g, "");
      if (!url) return null;
      const marks = node.getChildren("LinkMark");
      const display = marks.length >= 2 ? state.sliceDoc(marks[0]!.to, marks[1]!.from) : null;
      if (isExternal(url)) return { ...at, kind: "url", target: url, subpath: null, display, relative: false };
      const { target, subpath } = splitTarget(url);
      const kind = node.name === "Image" ? "image" : "markdown";
      return { ...at, kind, target: decode(target), subpath: subpath && decode(subpath), display, relative: true };
    }
    case "Autolink": {
      const url = text(node.getChild("URL"));
      return url ? { ...at, kind: "url", target: url, subpath: null, display: null, relative: false } : null;
    }
    case "URL": {
      // A bare address; inside a link it is that link's.
      if (["Link", "Image", "Autolink"].includes(node.parent?.name ?? "")) return null;
      const url = text(node)!;
      const target = EXTERNAL.test(url) ? url : url.includes("@") ? `mailto:${url}` : `https://${url}`;
      return { ...at, kind: "url", target, subpath: null, display: null, relative: false };
    }
  }
  return null;
}

/** Wiki links in the frontmatter, which the syntax tree sees as plain text. */
function frontmatterLink(state: EditorState, pos: number): LinkRef | null {
  const line = state.doc.lineAt(pos);
  for (const match of line.text.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos < from || pos > to) continue;
    const [raw, display] = match[1]!.split("|");
    return { kind: "wiki", from, to, ...splitTarget(raw!), display: display?.trim() || null, relative: false };
  }
  return null;
}

/** The link at a position, its ends included. */
export function linkAt(state: EditorState, pos: number): LinkRef | null {
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "Frontmatter") return frontmatterLink(state, pos);
      const link = readLink(state, node);
      if (link) return link;
    }
  }
  return null;
}

/** The tag at a position, without its `#`. */
export function tagAt(state: EditorState, pos: number): string | null {
  for (const side of [-1, 1] as const) {
    const node = syntaxTree(state).resolveInner(pos, side);
    if (node.name === "Tag") return state.sliceDoc(node.from + 1, node.to);
  }
  return null;
}

/** How to write a link. `target` is what goes inside the brackets. */
export function wikiLink(target: string, subpath: string | null, display: string | null): string {
  return `[[${target}${subpath ? `#${subpath}` : ""}${display ? `|${display}` : ""}]]`;
}

export function markdownLink(path: string, subpath: string | null, display: string): string {
  const encode = (text: string) => text.replace(/[ ()<>%#?"\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[${display}](${encode(path)}${subpath ? `#${encode(subpath)}` : ""})`;
}

/** The reference that leads from a note to a file. */
export function relativePath(fromNote: string, to: string): string {
  const from = fromNote.split("/").slice(0, -1);
  const parts = to.split("/");
  let shared = 0;
  while (shared < from.length && shared < parts.length - 1 && from[shared] === parts[shared]) shared++;
  return [...from.slice(shared).map(() => ".."), ...parts.slice(shared)].join("/");
}
