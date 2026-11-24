import { foldable, foldedRanges, foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { drawEmbed, renderMarkdown } from "../preview/render";
import { codeBlockRenderer, drawCodeBlock, useCodeBlocks, type CodeBlockRenderer } from "./codeBlocks";
import { readLink, type LinkRef } from "./links";
import { notePath } from "./note";
import { resolver, resolvedLink, resolvedLinks } from "./resolver";

/**
 * Markdown shown as what it means, with its markup only where one is
 * writing: at the caret. Only what is on screen is looked at, so the size of
 * the note doesn't matter.
 */

// ── Widgets ────────────────────────────────────────────────────────────────

class TextWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly className: string,
  ) {
    super();
  }
  override eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent() {
    return false;
  }
}

class RuleWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-rule";
    return span;
  }
  override ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", "Done");
    box.tabIndex = -1;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(box));
    });
    return box;
  }
}

/** Checks or unchecks the task on the line of a position. */
export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const match = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(line.text);
  if (!match) return false;
  const at = line.from + match[1]!.length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: match[2] === " " ? "x" : " " }, userEvent: "input.toggle" });
  return true;
}

class EmbedWidget extends WidgetType {
  private dispose: (() => void) | null = null;
  private gone = false;
  constructor(
    private readonly link: LinkRef,
    private readonly source: string,
    /** Where it leads: drawn again when that changes. */
    private readonly resolved: string | null | undefined,
  ) {
    super();
  }
  override eq(other: EmbedWidget) {
    const a = this.link;
    const b = other.link;
    return (
      a.target === b.target &&
      a.subpath === b.subpath &&
      a.display === b.display &&
      a.relative === b.relative &&
      this.source === other.source &&
      this.resolved === other.resolved
    );
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.addEventListener("mousedown", (e) => {
      if ((e.target as Element).closest(".cm-embed-note")) e.preventDefault();
    });
    const { target, subpath, display, relative } = this.link;
    void drawEmbed(span, { source: this.source, target, subpath, display: display ?? "", relative, depth: 0 }).then((dispose) => {
      if (this.gone) return dispose();
      this.dispose = dispose;
      view.requestMeasure();
      for (const img of span.querySelectorAll("img")) img.addEventListener("load", () => view.requestMeasure());
    });
    return span;
  }
  override destroy() {
    this.gone = true;
    this.dispose?.();
  }
  override ignoreEvent(event: Event) {
    return event.type !== "mousedown" || !!(event.target as Element).closest("a, input, .cm-embed-note");
  }
}

class RemoteImageWidget extends WidgetType {
  private dispose: (() => void) | null = null;
  constructor(
    private readonly link: LinkRef,
    private readonly source: string,
  ) {
    super();
  }
  override eq(other: RemoteImageWidget) {
    return other.link.target === this.link.target && other.link.display === this.link.display;
  }
  toDOM() {
    const span = document.createElement("span");
    this.dispose = renderMarkdown(`![${this.link.display ?? ""}](<${this.link.target}>)`, span, { path: this.source });
    return span;
  }
  override destroy() {
    this.dispose?.();
  }
}

/**
 * A click in what a widget draws is for it: left alone, the browser would put
 * the caret next to it, and the caret shows the source.
 */
function keepCaret(dom: HTMLElement) {
  dom.addEventListener("mousedown", (e) => {
    const field = (e.target as Element).closest("input, textarea, select, button, [contenteditable=true]");
    // The note itself is editable, and around it.
    if (!field || !dom.contains(field)) e.preventDefault();
  });
}

/** Puts the caret in the source of a block that is drawn. */
function editSource(view: EditorView, dom: HTMLElement, line: number) {
  const first = view.state.doc.lineAt(view.posAtDOM(dom));
  const to = view.state.doc.line(Math.min(view.state.doc.lines, first.number + line));
  view.dispatch({ selection: { anchor: to.from + Math.min(2, to.length) } });
  view.focus();
}

/** A table, drawn. Clicking a row puts the caret in it. */
class TableWidget extends WidgetType {
  private dispose: (() => void) | null = null;
  constructor(
    private readonly source: string,
    private readonly path: string,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.source === this.source && other.path === this.path;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "cm-block-widget";
    this.dispose = renderMarkdown(this.source, div, { path: this.path });
    div.addEventListener("mousedown", (e) => {
      const target = e.target as Element;
      if (target.closest("a")) return;
      e.preventDefault();
      const row = target.closest("tr");
      const index = row ? [...div.querySelectorAll("tr")].indexOf(row) : 0;
      // The second line of the source is the ruler, which isn't drawn.
      editSource(view, div, index > 0 ? index + 1 : 0);
    });
    return div;
  }
  override destroy() {
    this.dispose?.();
  }
  override get estimatedHeight() {
    return this.source.split("\n").length * 28;
  }
}

/** A code block a plugin draws. */
class CodeBlockWidget extends WidgetType {
  private dispose: (() => void) | null = null;
  constructor(
    private readonly renderer: CodeBlockRenderer,
    private readonly source: string,
    private readonly path: string,
  ) {
    super();
  }
  override eq(other: CodeBlockWidget) {
    return other.renderer === this.renderer && other.source === this.source && other.path === this.path;
  }
  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "cm-block-widget";
    const body = document.createElement("div");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-edit-block";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editSource(view, div, 1));
    div.append(body, edit);
    this.dispose = drawCodeBlock(this.renderer, this.source, body, this.path);
    keepCaret(div);
    return div;
  }
  override destroy() {
    this.dispose?.();
  }
}

/** Folds what is under a heading. Shows on hovering it, or while folded. */
class FoldWidget extends WidgetType {
  constructor(private readonly folded: boolean) {
    super();
  }
  override eq(other: FoldWidget) {
    return other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = this.folded ? "cm-fold-toggle cm-folded" : "cm-fold-toggle";
    span.textContent = this.folded ? "›" : "⌄";
    span.title = this.folded ? "Unfold" : "Fold";
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(span));
      const range = foldable(view.state, line.from, line.to);
      if (range) view.dispatch({ effects: (this.folded ? unfoldEffect : foldEffect).of(range) });
    });
    return span;
  }
}

// ── Inline ─────────────────────────────────────────────────────────────────

const hide = Decoration.replace({});
const mark = (className: string) => Decoration.mark({ class: className });
const marks = {
  markup: mark("cm-markup"),
  url: mark("cm-url"),
  em: mark("cm-em"),
  strong: mark("cm-strong"),
  strike: mark("cm-strike"),
  highlight: mark("cm-mark"),
  code: mark("cm-inline-code"),
  comment: mark("cm-comment-text"),
  tag: mark("cm-tag"),
  blockId: mark("cm-block-id"),
  done: mark("cm-task-done"),
  link: mark("cm-link-text"),
  missing: mark("cm-link-text cm-link-missing"),
};

const CALLOUT_LINE = /^(\s*(?:>\s?)+)\[!([\w-]+)\][+-]?[ \t]*/;

/** How far list items are set in, per level. */
const LIST_STEP_EM = 1.65;

class Builder {
  readonly ranges: Range<Decoration>[] = [];
  private readonly lines = new Map<number, { classes: Set<string>; attributes: Record<string, string> }>();

  constructor(
    private readonly view: EditorView,
    private readonly state: EditorState,
    private readonly focused: boolean,
  ) {}

  /** Whether the caret or selection touches a range: its markup shows. */
  touched(from: number, to: number): boolean {
    return this.focused && this.state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  }

  lineTouched(pos: number): boolean {
    const line = this.state.doc.lineAt(pos);
    return this.touched(line.from, line.to);
  }

  add(decoration: Decoration, from: number, to: number) {
    if (from < to) this.ranges.push(decoration.range(from, to));
  }

  line(pos: number, className: string, attributes: Record<string, string> = {}) {
    const from = this.state.doc.lineAt(pos).from;
    const line = this.lines.get(from) ?? { classes: new Set(), attributes: {} };
    className.split(" ").forEach((c) => line.classes.add(c));
    Object.assign(line.attributes, attributes);
    this.lines.set(from, line);
  }

  finish(): DecorationSet {
    for (const [from, { classes, attributes }] of this.lines) {
      this.ranges.push(Decoration.line({ class: [...classes].join(" "), attributes }).range(from));
    }
    return Decoration.set(this.ranges, true);
  }

  /** The lines of a node that are on screen. */
  eachLine(node: { from: number; to: number }, range: { from: number; to: number }, visit: (line: { from: number; to: number; text: string; number: number }) => void) {
    const last = this.state.doc.lineAt(Math.min(node.to, range.to)).number;
    for (let n = this.state.doc.lineAt(Math.max(node.from, range.from)).number; n <= last; n++) {
      visit(this.state.doc.line(n));
    }
  }

  node(node: SyntaxNode, range: { from: number; to: number }): boolean {
    const { state } = this;
    const { name, from, to } = node;

    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
    if (heading) {
      this.eachLine(node, range, (line) => this.line(line.from, `cm-heading cm-h${heading[1]}`));
      const at = state.doc.lineAt(from);
      if (at.from >= range.from && foldable(state, at.from, at.to)) {
        let folded = false;
        foldedRanges(state).between(at.to, at.to, (start) => void (folded ||= start === at.to));
        this.ranges.push(Decoration.widget({ widget: new FoldWidget(folded), side: -1 }).range(at.from));
      }
      for (const markNode of node.getChildren("HeaderMark")) {
        if (this.lineTouched(markNode.from)) this.add(marks.markup, markNode.from, markNode.to);
        else if (markNode.from === from && name.startsWith("ATX")) {
          const space = /^[ \t]*/.exec(state.sliceDoc(markNode.to, to))![0].length;
          this.add(hide, markNode.from, markNode.to + space);
        } else if (name.startsWith("ATX")) this.add(hide, markNode.from, markNode.to);
        else this.add(marks.markup, markNode.from, markNode.to);
      }
      return true;
    }

    switch (name) {
      case "Emphasis":
        return this.wrapped(node, marks.em, "EmphasisMark");
      case "StrongEmphasis":
        return this.wrapped(node, marks.strong, "EmphasisMark");
      case "Strikethrough":
        return this.wrapped(node, marks.strike, "StrikethroughMark");
      case "Highlight":
        return this.wrapped(node, marks.highlight, "HighlightMark");
      case "InlineCode":
        return this.wrapped(node, marks.code, "CodeMark");
      case "NoteComment":
        this.add(marks.comment, from, to);
        return false;
      case "Tag":
        this.add(marks.tag, from, to);
        return false;
      case "BlockId":
        this.add(marks.blockId, from, to);
        return false;
      case "Escape":
        if (!this.touched(from, to)) this.add(hide, from, from + 1);
        return false;
      case "WikiLink":
      case "Link":
        return this.link(node);
      case "Embed":
      case "Image":
        return this.embed(node);
      case "Autolink":
      case "URL": {
        const link = readLink(state, node);
        if (!link) return false;
        const shown = this.touched(from, to);
        for (const m of node.getChildren("LinkMark")) this.add(shown ? marks.markup : hide, m.from, m.to);
        this.add(marks.link, from, to);
        return false;
      }
      case "HorizontalRule":
        if (this.lineTouched(from)) this.add(marks.markup, from, to);
        else if (to > from) this.ranges.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
        return false;
      case "Blockquote":
        if (node.parent?.name !== "Blockquote") this.quote(node, range);
        return true;
      case "QuoteMark": {
        if (this.lineTouched(from)) this.add(marks.markup, from, to);
        else this.add(hide, from, to + (state.sliceDoc(to, to + 1) === " " ? 1 : 0));
        return false;
      }
      case "ListItem":
        this.listItem(node, range);
        return true;
      case "FencedCode":
      case "CodeBlock":
        this.code(node, range);
        return false;
      case "Frontmatter":
        this.eachLine(node, range, (line) => {
          this.line(line.from, "cm-frontmatter");
          if (line.from === from) this.line(line.from, "cm-frontmatter-first");
          if (line.to >= to) this.line(line.from, "cm-frontmatter-last");
        });
        return true;
      case "FrontmatterMark":
        this.add(marks.markup, from, to);
        return false;
      case "TableDelimiter":
        this.add(marks.markup, from, to);
        return false;
    }
    return true;
  }

  private wrapped(node: SyntaxNode, decoration: Decoration, markName: string): boolean {
    const shown = this.touched(node.from, node.to);
    this.add(decoration, node.from, node.to);
    for (const m of node.getChildren(markName)) this.add(shown ? marks.markup : hide, m.from, m.to);
    return true;
  }

  private linkMark(link: LinkRef): Decoration {
    if (link.kind === "url" || (!link.target && link.subpath)) return marks.link;
    this.view.plugin(resolver)?.want(link);
    return resolvedLink(this.view, link) === null ? marks.missing : marks.link;
  }

  private link(node: SyntaxNode): boolean {
    const link = readLink(this.state, node);
    if (!link) return true;
    const decoration = this.linkMark(link);
    const { from, to } = node;
    if (this.touched(from, to)) {
      this.add(decoration, from, to);
      for (const m of [...node.getChildren("LinkMark"), ...node.getChildren("WikiLinkMark")]) this.add(marks.markup, m.from, m.to);
      for (const url of node.getChildren("URL")) this.add(marks.url, url.from, url.to);
      return node.name === "Link";
    }
    if (node.name === "WikiLink") {
      const target = node.getChild("WikiLinkTarget")!;
      const shown = node.getChild("WikiLinkText") ?? target;
      this.add(hide, from, shown.from);
      this.add(decoration, shown.from, shown.to);
      this.add(hide, shown.to, to);
      return false;
    }
    const [open, close] = node.getChildren("LinkMark");
    if (!open || !close || close.from === open.to) {
      this.add(decoration, from, to);
      return false;
    }
    this.add(hide, open.from, open.to);
    this.add(decoration, open.to, close.from);
    this.add(hide, close.from, to);
    return true;
  }

  private embed(node: SyntaxNode): boolean {
    const link = readLink(this.state, node);
    if (!link) return false;
    const { from, to } = node;
    if (this.touched(from, to)) {
      this.add(this.linkMark(link), from, to);
      return false;
    }
    const source = this.state.facet(notePath);
    let widget: WidgetType;
    if (link.kind === "url") widget = new RemoteImageWidget(link, source);
    else {
      this.view.plugin(resolver)?.want(link);
      widget = new EmbedWidget(link, source, resolvedLink(this.view, link));
    }
    this.ranges.push(Decoration.replace({ widget }).range(from, to));
    return false;
  }

  private quote(node: SyntaxNode, range: { from: number; to: number }) {
    const first = this.state.doc.lineAt(node.from);
    const callout = CALLOUT_LINE.exec(first.text);
    const kind = callout?.[2]!.toLowerCase();
    const attributes: Record<string, string> = kind ? { "data-callout": kind } : {};
    const lastLine = this.state.doc.lineAt(node.to).number;
    this.eachLine(node, range, (line) => {
      this.line(line.from, kind ? "cm-quote cm-callout" : "cm-quote", attributes);
      if (kind && line.number === first.number) this.line(line.from, "cm-callout-title");
      if (kind && line.number === lastLine) this.line(line.from, "cm-callout-end");
    });
    if (!callout || !kind || this.lineTouched(first.from)) return;
    const from = first.from + callout[1]!.length;
    const to = first.from + callout[0].length;
    const titled = to < first.to;
    this.ranges.push(
      titled
        ? hide.range(from, to)
        : Decoration.replace({ widget: new TextWidget(kind[0]!.toUpperCase() + kind.slice(1), "") }).range(from, to),
    );
  }

  private listItem(node: SyntaxNode, range: { from: number; to: number }) {
    const { state } = this;
    const listMark = node.getChild("ListMark");
    if (!listMark) return;
    let depth = 0;
    for (let p = node.parent; p; p = p.parent) if (p.name === "ListItem") depth++;
    const lead = (depth + 1) * LIST_STEP_EM;
    const style = `padding-left: calc(var(--line-inset) + ${lead}em); text-indent: -${lead}em`;

    const task = node.getChild("Task");
    const marker = task?.getChild("TaskMarker");
    const bullet = node.parent?.name === "BulletList";

    // Its own lines; those of nested items are theirs.
    const nested = [...node.getChildren("BulletList"), ...node.getChildren("OrderedList")];
    const isNested = (pos: number) => nested.some((n) => pos >= state.doc.lineAt(n.from).from && pos <= n.to);
    this.eachLine(node, range, (line) => {
      if (isNested(line.from) || (line.from > node.from && /^\s*(>|```|~~~)/.test(line.text))) return;
      const inQuote = /^\s*>/.test(line.text);
      if (inQuote) return;
      const indent = /^[ \t]*/.exec(line.text)![0].length;
      const isFirst = line.from <= listMark.from && listMark.from <= line.to;
      if (!isFirst && indent === 0) return;
      this.line(line.from, "cm-list-line", { style });
      // Boxes of a fixed width, so what wraps lines up with the text.
      const box = (from: number, to: number, width: number) =>
        this.add(
          Decoration.mark({ class: "cm-list-lead", attributes: { style: `min-width: ${width}em` }, inclusive: false }),
          from,
          to,
        );
      if (!isFirst) return box(line.from, line.from + indent, lead);
      const end = listMark.to + (state.sliceDoc(listMark.to, listMark.to + 1) === " " ? 1 : 0);
      box(line.from, listMark.from, lead - LIST_STEP_EM);
      // A checkbox or a bullet stands in for all of it, with a width of its own.
      if (task && marker && !this.touched(listMark.from, marker.to)) return;
      if (bullet && !(task && marker) && !this.lineTouched(listMark.from)) {
        this.ranges.push(Decoration.replace({ widget: new TextWidget("•", "cm-bullet") }).range(listMark.from, end));
      } else box(listMark.from, end, LIST_STEP_EM);
    });

    if (task && marker) {
      const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
      if (!this.touched(listMark.from, marker.to)) {
        const space = state.sliceDoc(marker.to, marker.to + 1) === " " ? 1 : 0;
        this.ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(listMark.from, marker.to + space));
      }
      if (checked) this.add(marks.done, marker.to, Math.min(task.to, state.doc.lineAt(marker.to).to));
      return;
    }
    if (!bullet || this.lineTouched(listMark.from)) this.add(marks.markup, listMark.from, listMark.to);
  }

  private code(node: SyntaxNode, range: { from: number; to: number }) {
    const { state } = this;
    const first = state.doc.lineAt(node.from).number;
    const last = state.doc.lineAt(node.to).number;
    this.eachLine(node, range, (line) => {
      this.line(line.from, "cm-code-line");
      if (line.number === first) this.line(line.from, "cm-code-first");
      if (line.number === last) this.line(line.from, "cm-code-last");
    });
    if (node.name !== "FencedCode") return;
    const shown = this.touched(node.from, node.to);
    const [open, close] = node.getChildren("CodeMark");
    const info = node.getChild("CodeInfo");
    if (open) this.add(shown ? marks.markup : hide, open.from, open.to);
    if (info) this.add(marks.markup, info.from, info.to);
    if (close) this.add(shown ? marks.markup : hide, close.from, close.to);
  }
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const builder = new Builder(view, state, view.hasFocus);
  const tree = syntaxTree(state);
  const blocks = state.field(blockWidgets, false);
  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        // Drawn whole by a widget: nothing inside to style.
        if (blocks?.shown.some((b) => ref.from >= b.from && ref.to <= b.to && ref.to > ref.from)) return false;
        return builder.node(ref.node, range);
      },
    });
  }
  return builder.finish();
}

const inline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.field(resolvedLinks) !== update.state.field(resolvedLinks) ||
        foldedRanges(update.startState) !== foldedRanges(update.state) ||
        update.startState.facet(notePath) !== update.state.facet(notePath) ||
        update.startState.field(blockWidgets, false)?.shown !== update.state.field(blockWidgets, false)?.shown
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ── Blocks drawn whole: tables, and code a plugin draws ────────────────────

interface Block {
  from: number;
  to: number;
  kind: "table" | "code";
  source: string;
  renderer?: CodeBlockRenderer;
}

interface Blocks {
  all: Block[];
  shown: Block[];
  decorations: DecorationSet;
}

function findBlocks(state: EditorState): Block[] {
  const found: Block[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Table") {
      found.push({ from: node.from, to: node.to, kind: "table", source: state.sliceDoc(node.from, node.to) });
    } else if (node.name === "FencedCode") {
      const info = node.getChild("CodeInfo");
      const renderer = info && codeBlockRenderer(state.sliceDoc(info.from, info.to).split(/\s/)[0]!);
      if (!renderer) continue;
      const text = node.getChildren("CodeText");
      const source = text.length ? state.sliceDoc(text[0]!.from, text[text.length - 1]!.to) : "";
      found.push({ from: node.from, to: node.to, kind: "code", source, renderer });
    }
  }
  return found;
}

function showBlocks(state: EditorState, all: Block[], focused: boolean): Blocks {
  const shown = all.filter((b) => !focused || !state.selection.ranges.some((r) => r.from <= b.to && r.to >= b.from));
  const path = state.facet(notePath);
  const decorations = Decoration.set(
    shown.map((b) => {
      const widget = b.renderer ? new CodeBlockWidget(b.renderer, b.source, path) : new TableWidget(b.source, path);
      return Decoration.replace({ widget, block: true }).range(b.from, state.doc.lineAt(b.to).to);
    }),
  );
  return { all, shown, decorations };
}

const setFocused = StateEffect.define<boolean>();

/** Whether the editor has focus, for what can't ask the view. */
const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFocused)) value = effect.value;
    return value;
  },
});

const redrawBlocks = StateEffect.define<null>();

const blockWidgets = StateField.define<Blocks>({
  create: (state) => showBlocks(state, findBlocks(state), false),
  update(value, tr) {
    const parsed = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const focused = tr.state.field(focusField);
    const moved = tr.selection || focused !== tr.startState.field(focusField);
    const redraw = tr.effects.some((e) => e.is(redrawBlocks)) || tr.startState.facet(notePath) !== tr.state.facet(notePath);
    if (tr.docChanged || parsed || redraw) return showBlocks(tr.state, findBlocks(tr.state), focused);
    if (!moved || value.all.length === 0) return value;
    const next = showBlocks(tr.state, value.all, focused);
    const same = next.shown.length === value.shown.length && next.shown.every((b, i) => b === value.shown[i]);
    return same ? value : next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const followRenderers = ViewPlugin.fromClass(
  class {
    private readonly stop: () => void;
    constructor(view: EditorView) {
      this.stop = useCodeBlocks.subscribe(() => view.dispatch({ effects: redrawBlocks.of(null) }));
    }
    destroy() {
      this.stop();
    }
  },
);

export function livePreview(): Extension {
  return [
    focusField,
    EditorView.focusChangeEffect.of((_, focusing) => setFocused.of(focusing)),
    blockWidgets,
    followRenderers,
    inline,
  ];
}
