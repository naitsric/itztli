import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { LanguageSupport } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import { styleTags, tags as t } from "@lezer/highlight";
import type { BlockContext, DelimiterType, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * What notes add to Markdown: wiki links, embeds, tags, highlights, comments,
 * block ids and frontmatter. The backend reads the same syntax with its own
 * parser (crates/itztli-core/src/note.rs); they must agree on what a link is.
 */

const CLOSING = /^---\s*$/;
/** Frontmatter longer than this is not recognized. */
const MAX_FRONTMATTER_LINES = 500;

/** Where a document's frontmatter ends, if it has any: the offset after its closing line. */
export function frontmatterEnd(doc: Text): number | null {
  if (doc.line(1).text !== "---") return null;
  const last = Math.min(doc.lines, MAX_FRONTMATTER_LINES);
  for (let n = 2; n <= last; n++) {
    const line = doc.line(n);
    if (CLOSING.test(line.text)) return line.to;
  }
  return null;
}

const frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true },
    { name: "FrontmatterMark" },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || line.text !== "---") return false;
        // The parser only offers one line of lookahead; this is what it does itself.
        const scanner = cx as unknown as { to: number; scanLine(start: number): { text: string; end: number } };
        let at = 4;
        for (let lines = 0; ; lines++) {
          if (at > scanner.to || lines > MAX_FRONTMATTER_LINES) return false;
          const next = scanner.scanLine(at);
          if (CLOSING.test(next.text)) break;
          at = next.end + 1;
        }
        const start = cx.lineStart;
        const marks = [cx.elt("FrontmatterMark", start, start + 3)];
        while (cx.nextLine()) {
          if (CLOSING.test(line.text)) {
            marks.push(cx.elt("FrontmatterMark", cx.lineStart, cx.lineStart + 3));
            const end = cx.lineStart + line.text.length;
            cx.nextLine();
            cx.addElement(cx.elt("Frontmatter", start, end, marks));
            return true;
          }
        }
        cx.addElement(cx.elt("Frontmatter", start, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

const wikiLinks: MarkdownConfig = {
  defineNodes: [
    "WikiLink",
    "Embed",
    "WikiLinkMark",
    { name: "WikiLinkTarget", style: t.link },
    { name: "WikiLinkText", style: t.link },
  ],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number) {
        const embed = next === 33 /* ! */;
        const open = embed ? pos + 1 : pos;
        if (cx.char(open) !== 91 /* [ */ || cx.char(open + 1) !== 91) return -1;
        const inner = open + 2;
        const text = cx.slice(inner, Math.min(cx.end, inner + 1000));
        const close = text.search(/\]\]|\n/);
        if (close <= 0 || text[close] === "\n" || /\[\[/.test(text.slice(0, close))) return -1;
        const pipe = text.slice(0, close).indexOf("|");
        const end = inner + close;
        const children = [cx.elt("WikiLinkMark", pos, inner)];
        if (pipe >= 0) {
          // A table needs the pipe escaped.
          const escaped = pipe > 0 && text[pipe - 1] === "\\" ? 1 : 0;
          if (pipe - escaped > 0) children.push(cx.elt("WikiLinkTarget", inner, inner + pipe - escaped));
          children.push(cx.elt("WikiLinkMark", inner + pipe - escaped, inner + pipe + 1));
          if (pipe + 1 < close) children.push(cx.elt("WikiLinkText", inner + pipe + 1, end));
        } else {
          children.push(cx.elt("WikiLinkTarget", inner, end));
        }
        children.push(cx.elt("WikiLinkMark", end, end + 2));
        return cx.addElement(cx.elt(embed ? "Embed" : "WikiLink", pos, end + 2, children));
      },
    },
  ],
};

const HighlightDelimiter: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

const highlight: MarkdownConfig = {
  defineNodes: ["Highlight", "HighlightMark"],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61 || cx.char(pos - 1) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const open = !!after && !/\s/.test(after);
        const close = !!before && !/\s/.test(before);
        if (!open && !close) return -1;
        return cx.addDelimiter(HighlightDelimiter, pos, pos + 2, open, close);
      },
    },
  ],
};

/** The same characters `is_tag_char` accepts in the backend. */
const TAG = /^#((?:[\p{L}\p{N}_/-]|[\u{2190}-\u{2bff}]|[\u{1f000}-\u{1faff}]|‍|️)+)/u;

const tags: MarkdownConfig = {
  defineNodes: ["Tag"],
  parseInline: [
    {
      name: "Tag",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 35 /* # */) return -1;
        if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1;
        const match = TAG.exec(cx.slice(pos, Math.min(cx.end, pos + 200)));
        const name = match?.[1]?.replace(/\/+$/, "");
        if (!name || /^[\p{N}/]+$/u.test(name)) return -1;
        return cx.addElement(cx.elt("Tag", pos, pos + 1 + name.length));
      },
    },
  ],
};

const comments: MarkdownConfig = {
  defineNodes: [{ name: "NoteComment", style: t.comment }],
  parseInline: [
    {
      name: "NoteComment",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 37 /* % */ || cx.char(pos + 1) !== 37) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf("%%");
        if (close < 0) return -1;
        return cx.addElement(cx.elt("NoteComment", pos, pos + 2 + close + 2));
      },
    },
  ],
};

const blockIds: MarkdownConfig = {
  defineNodes: ["BlockId"],
  parseInline: [
    {
      name: "BlockId",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 94 /* ^ */) return -1;
        if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1;
        const match = /^\^[A-Za-z0-9-]+(?=\n|$)/.exec(cx.slice(pos, Math.min(cx.end, pos + 100)));
        return match ? cx.addElement(cx.elt("BlockId", pos, pos + match[0].length)) : -1;
      },
    },
  ],
};

const styles: MarkdownConfig = {
  props: [
    styleTags({
      "WikiLinkMark HighlightMark FrontmatterMark": t.processingInstruction,
      Tag: t.labelName,
    }),
  ],
};

/** A new instance each time, so reconfiguring with one parses afresh. */
export function noteLanguage(): LanguageSupport {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
    completeHTMLTags: false,
    extensions: [frontmatter, wikiLinks, highlight, tags, comments, blockIds, styles],
  });
}
