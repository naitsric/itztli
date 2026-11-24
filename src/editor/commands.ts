import { insertNewlineAndIndent } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { toggleTaskAt } from "./livePreview";
import { formatTable } from "./tables";

/** Editing commands CodeMirror doesn't have, or has with another meaning. */

/** Puts markup around each selection (or the word at each caret), or takes it off. */
export function toggleWrap(view: EditorView, open: string, close = open): boolean {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const word = range.empty ? state.wordAt(range.head) : null;
      const { from, to } = word ?? range;
      const text = state.sliceDoc(from, to);
      const before = state.sliceDoc(Math.max(0, from - open.length), from);
      const after = state.sliceDoc(to, to + close.length);

      if (before === open && after === close && !isLonger(state, from - open.length, to + close.length, open)) {
        const changes: ChangeSpec[] = [
          { from: from - open.length, to: from },
          { from: to, to: to + close.length },
        ];
        const shift = open.length;
        return { changes, range: EditorSelection.range(range.anchor - shift, range.head - shift) };
      }
      if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
        const inner = text.slice(open.length, text.length - close.length);
        return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) };
      }
      const changes: ChangeSpec[] = [
        { from, insert: open },
        { from: to, insert: close },
      ];
      return { changes, range: EditorSelection.range(range.anchor + open.length, range.head + open.length) };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
}

/** `*` inside `**` is not italics to take off. */
function isLonger(state: EditorState, from: number, to: number, open: string): boolean {
  if (open.length !== 1) return false;
  return state.sliceDoc(from - 1, from) === open && state.sliceDoc(to, to + 1) === open && state.sliceDoc(from - 2, from - 1) !== open;
}

/** The lines the selection touches, each once. */
function selectedLines(state: EditorState) {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b).map((n) => state.doc.line(n));
}

function changeLines(view: EditorView, change: (text: string, index: number) => string): boolean {
  const lines = selectedLines(view.state);
  const changes = lines
    .map((line, i) => ({ from: line.from, to: line.to, text: line.text, insert: change(line.text, i) }))
    .filter((c) => c.insert !== c.text)
    .map(({ from, to, text, insert }) => {
      // Only what differs at the start, so the caret stays in the words.
      let tail = 0;
      const shortest = Math.min(text.length, insert.length);
      while (tail < shortest && text[text.length - 1 - tail] === insert[insert.length - 1 - tail]) tail++;
      return { from, to: to - tail, insert: insert.slice(0, insert.length - tail) };
    });
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
  return true;
}

const LEAD = /^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

/** Makes lines a heading of a level, or plain text again. 0 takes it off. */
export function setHeading(view: EditorView, level: number): boolean {
  return changeLines(view, (text) => {
    const rest = text.replace(/^\s*#{1,6}\s+/, "");
    const current = /^#{1,6}(?=\s)/.exec(text)?.[0].length ?? 0;
    return level === 0 || current === level ? rest : `${"#".repeat(level)} ${rest}`;
  });
}

export function changeHeadingLevel(view: EditorView, by: 1 | -1): boolean {
  return changeLines(view, (text) => {
    const match = /^(#{1,6})(\s+.*)$/.exec(text);
    if (!match) return text;
    const level = Math.min(6, Math.max(1, match[1]!.length + by));
    return "#".repeat(level) + match[2];
  });
}

export function toggleList(view: EditorView, kind: "bullet" | "ordered" | "quote"): boolean {
  const lines = selectedLines(view.state).filter((l) => l.text.trim());
  const is = { bullet: /^\s*[-*+]\s/, ordered: /^\s*\d+[.)]\s/, quote: /^\s*>/ }[kind];
  const all = lines.length > 0 && lines.every((l) => is.test(l.text));
  let n = 0;
  return changeLines(view, (text) => {
    if (kind === "quote") return all ? text.replace(/^(\s*)>\s?/, "$1") : `> ${text}`;
    if (!text.trim() && lines.length > 1) return text;
    if (all) return text.replace(LEAD, "$1");
    const lead = kind === "bullet" ? "- " : `${++n}. `;
    return text.replace(LEAD, `$1${lead}`);
  });
}

/** Checks and unchecks tasks; makes a task of what isn't one. */
export function toggleTask(view: EditorView): boolean {
  const lines = selectedLines(view.state);
  if (lines.length === 1 && toggleTaskAt(view, lines[0]!.from)) return true;
  return changeLines(view, (text) => {
    const task = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(text);
    if (task) return task[1] + (task[2] === " " ? "x" : " ") + task[3];
    if (!text.trim() && lines.length > 1) return text;
    const item = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(text);
    if (item) return `${item[1]}[ ] ${item[2]}`;
    return text.replace(/^(\s*)/, "$1- [ ] ");
  });
}

/** Joins the next line to this one, dropping its list marker or indent. */
export function joinLines(view: EditorView): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    const last = range.empty ? first.number + 1 : state.doc.lineAt(range.to).number;
    for (let n = first.number; n < Math.min(last, state.doc.lines); n++) {
      const line = state.doc.line(n);
      const next = state.doc.line(n + 1);
      const lead = /^\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/.exec(next.text)![0].length;
      const trailing = /\s*$/.exec(line.text)![0].length;
      changes.push({ from: line.to - trailing, to: next.from + lead, insert: line.text.trim() && next.text.length > lead ? " " : "" });
    }
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "delete.join", scrollIntoView: true });
  return true;
}

/** Opens a line below, wherever the caret is in this one. */
export function startNewLine(view: EditorView): boolean {
  const { state } = view;
  view.dispatch({ selection: EditorSelection.create(state.selection.ranges.map((r) => EditorSelection.cursor(state.doc.lineAt(r.head).to)), state.selection.mainIndex) });
  return insertNewlineAndIndent(view);
}

// ── Extend and shrink selection ────────────────────────────────────────────

const pushSelection = StateEffect.define<EditorSelection>();
const popSelection = StateEffect.define<null>();

/** The selections extended from, so shrinking retraces the same steps. */
export const selectionStack = StateField.define<readonly EditorSelection[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(pushSelection)) return [...value, effect.value];
      if (effect.is(popSelection)) return value.slice(0, -1);
    }
    return tr.docChanged || tr.selection ? [] : value;
  },
});

/** What a selection may grow to, inside out: markup, line, paragraph, sections, all. */
function* enclosing(state: EditorState, from: number, to: number): Generator<Span> {
  const line = state.doc.lineAt(from);
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (node.from >= line.from && node.to <= line.to) yield node;
  }
  yield line;

  const blank = (n: number) => !state.doc.line(n).text.trim();
  let first = line.number;
  let last = state.doc.lineAt(to).number;
  // A selection of whole lines ends where the next one starts.
  if (to > from && state.doc.line(last).from === to) last--;
  while (first > 1 && !blank(first) && !blank(first - 1)) first--;
  while (last < state.doc.lines && !blank(last) && !blank(last + 1)) last++;
  yield { from: state.doc.line(first).from, to: state.doc.line(last).to };

  const headings: { from: number; level: number }[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (match) headings.push({ from: node.from, level: Number(match[1]) });
  }
  let level = 7;
  for (let i = headings.length - 1; i >= 0; i--) {
    const heading = headings[i]!;
    if (heading.from > from || heading.level >= level) continue;
    level = heading.level;
    const next = headings.slice(i + 1).find((h) => h.level <= level);
    yield { from: heading.from, to: next ? next.from : state.doc.length };
  }
  yield { from: 0, to: state.doc.length };
}

export function extendSelection(view: EditorView): boolean {
  const { state } = view;
  const before = state.selection;
  const ranges = before.ranges.map((range) => {
    const word = range.empty ? state.wordAt(range.head) : null;
    if (word) return EditorSelection.range(word.from, word.to);
    for (const span of enclosing(state, range.from, range.to)) {
      const larger = span.from <= range.from && span.to >= range.to && (span.from < range.from || span.to > range.to);
      if (larger) return EditorSelection.range(span.from, span.to);
    }
    return range;
  });
  const selection = EditorSelection.create(ranges, before.mainIndex);
  if (selection.eq(before)) return false;
  view.dispatch({ selection, effects: pushSelection.of(before), userEvent: "select" });
  return true;
}

export function shrinkSelection(view: EditorView): boolean {
  const stack = view.state.field(selectionStack, false);
  const last = stack?.[stack.length - 1];
  if (!last) return false;
  view.dispatch({ selection: last, effects: popSelection.of(null), userEvent: "select" });
  return true;
}

// ── Move Statement: a list item or a section, with all it holds ────────────

interface Span {
  from: number;
  to: number;
}

/** The sections of a note at a level, by their lines. Ends where the next starts. */
function sectionSpans(state: EditorState, level: number, around: number): Span[] {
  const spans: Span[] = [];
  let current: number | null = null;
  const close = (to: number) => {
    if (current !== null) spans.push({ from: current, to });
    current = null;
  };
  syntaxTree(state).topNode.cursor().iterate((node) => {
    const match = /^ATXHeading(\d)$/.exec(node.name);
    if (!match) return node.name === "Document";
    const found = Number(match[1]);
    if (found <= level) close(node.from);
    if (found === level) current = node.from;
    // Sections of another parent are not siblings.
    if (found < level && node.from <= around) spans.length = 0;
    if (found < level && node.from > around) spans.push({ from: Infinity, to: Infinity });
    return false;
  });
  close(state.doc.length);
  const stop = spans.findIndex((s) => s.from === Infinity);
  return stop < 0 ? spans : spans.slice(0, stop);
}

function movable(state: EditorState, pos: number): { spans: Span[]; index: number } | null {
  const line = state.doc.lineAt(pos);
  const heading = /^(#{1,6})\s/.exec(line.text);
  if (heading) {
    const spans = sectionSpans(state, heading[1]!.length, line.from);
    const index = spans.findIndex((s) => s.from === line.from);
    return index < 0 ? null : { spans, index };
  }
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.to, -1); node; node = node.parent) {
    if (node.name !== "ListItem" || !node.parent) continue;
    const item = node;
    const items = node.parent.getChildren("ListItem");
    // Whole lines, so the indent goes along.
    const spans = items.map((each, i) => {
      const from = state.doc.lineAt(each.from).from;
      const next = items[i + 1];
      const to = next ? state.doc.lineAt(next.from).from : Math.min(state.doc.length, state.doc.lineAt(each.to).to + 1);
      return { from, to };
    });
    return { spans, index: items.findIndex((other) => other.from === item.from) };
  }
  return null;
}

export function moveStatement(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const found = movable(state, head);
  if (!found) return false;
  const other = found.spans[found.index + direction];
  const mine = found.spans[found.index]!;
  if (!other) return true;
  const [first, second] = direction < 0 ? [other, mine] : [mine, other];
  const ensureBreak = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
  const a = state.sliceDoc(first.from, first.to);
  const b = state.sliceDoc(second.from, second.to);
  const atEnd = second.to === state.doc.length && !b.endsWith("\n");
  let swapped = ensureBreak(b) + a;
  if (atEnd) swapped = swapped.replace(/\n$/, "");
  const start = direction < 0 ? first.from : first.from + ensureBreak(b).length;
  view.dispatch({
    changes: { from: first.from, to: second.to, insert: swapped },
    selection: { anchor: Math.min(start + (head - mine.from), first.from + swapped.length) },
    userEvent: "move.statement",
    scrollIntoView: true,
  });
  return true;
}

// ── Reformat ───────────────────────────────────────────────────────────────

/** Aligns the tables in the selection, or in the whole note. */
export function reformat(view: EditorView): boolean {
  const { state } = view;
  const { from, to, empty } = state.selection.main;
  const changes: ChangeSpec[] = [];
  syntaxTree(state).iterate({
    from: empty ? 0 : from,
    to: empty ? state.doc.length : to,
    enter(node) {
      if (node.name !== "Table") return;
      const text = state.sliceDoc(node.from, node.to);
      const formatted = formatTable(text);
      if (formatted !== null && formatted !== text) changes.push({ from: node.from, to: node.to, insert: formatted });
      return false;
    },
  });
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "input.reformat" });
  return true;
}
