import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { api } from "../backend/api";
import { parentOf } from "../vault/paths";
import { notePath } from "./note";
import { outline } from "./outline";

/** A source plugins add: see `Editor.registerCompletion` in the plugin API. */
export type PluginCompletion = (request: {
  path: string;
  before: string;
  position: number;
  explicit: boolean;
}) => Promise<{ replace: number; options: { label: string; detail?: string; insert?: string }[] } | null> | null | { replace: number; options: { label: string; detail?: string; insert?: string }[] };

const pluginSources = new Set<PluginCompletion>();

export function registerCompletion(source: PluginCompletion): () => void {
  pluginSources.add(source);
  return () => void pluginSources.delete(source);
}

const LIMIT = 40;

/** Writes what was chosen, and closes the brackets once. */
function applyLink(text: string) {
  return (view: EditorView, _: Completion, from: number, to: number) => {
    const after = view.state.sliceDoc(to, to + 2);
    const closing = after === "]]" ? 2 : 0;
    view.dispatch({
      changes: { from, to: to + closing, insert: `${text}]]` },
      selection: { anchor: from + text.length + 2 },
      userEvent: "input.complete",
    });
  };
}

/** Inside `[[…`: notes, then their headings after `#`. */
async function links(context: CompletionContext): Promise<CompletionResult | null> {
  const open = context.matchBefore(/!?\[\[[^[\]\n]*$/);
  if (!open) return null;
  const inner = open.text.replace(/^!?\[\[/, "");
  if (inner.includes("|")) return null;
  const from = context.pos - inner.length;
  const path = context.state.facet(notePath);

  const hash = inner.indexOf("#");
  if (hash >= 0) {
    const target = inner.slice(0, hash);
    const headings = target
      ? await api.linkResolve(path, target).then(async (to) => (to ? ((await api.noteMeta(to))?.headings ?? []) : []))
      : outline(context.state);
    if (context.aborted) return null;
    return {
      from: from + hash + 1,
      validFor: /^[^[\]|\n]*$/,
      options: headings.map((h) => {
        const clean = h.text.replace(/[#^|[\]]/g, " ").replace(/\s+/g, " ").trim();
        return { label: clean, detail: "#".repeat(h.level), type: "heading", apply: applyLink(clean) };
      }),
    };
  }

  const found = await api.suggestLinks(path, inner, LIMIT);
  if (context.aborted) return null;
  return {
    from,
    // The backend already matched and ranked them.
    filter: false,
    options: found.map((s, i): Completion => {
      const folder = s.path ? parentOf(s.path) : "";
      const label = s.alias ?? s.insert;
      return {
        label,
        detail: s.path === null ? "not created yet" : s.alias ? s.insert : folder,
        boost: -i,
        type: "note",
        apply: applyLink(s.alias && s.alias !== s.insert ? `${s.insert}|${s.alias}` : s.insert),
      };
    }),
  };
}

async function tags(context: CompletionContext): Promise<CompletionResult | null> {
  const typed = context.matchBefore(/(?:^|\s)#[\p{L}\p{N}_/-]*$/u);
  if (!typed) return null;
  const from = typed.from + typed.text.indexOf("#") + 1;
  const query = context.state.sliceDoc(from, context.pos);
  const line = context.state.doc.lineAt(from);
  // `# ` starts a heading.
  if (!query && !context.explicit && from - 1 === line.from) return null;
  const found = await api.tags();
  if (context.aborted) return null;
  return {
    from,
    validFor: /^[\p{L}\p{N}_/-]*$/u,
    options: found.map((t) => ({ label: t.name, detail: String(t.notes), type: "tag" })),
  };
}

const CALLOUTS = ["note", "tip", "info", "warning", "danger", "question", "success", "example", "quote", "bug"];

function callouts(context: CompletionContext): CompletionResult | null {
  const typed = context.matchBefore(/^\s*>\s*\[!\w*$/);
  if (!typed) return null;
  const from = typed.from + typed.text.indexOf("!") + 1;
  return {
    from,
    validFor: /^\w*$/,
    options: CALLOUTS.map((c) => ({ label: c, apply: context.state.sliceDoc(context.pos, context.pos + 1) === "]" ? c : `${c}] ` })),
  };
}

async function fromPlugins(context: CompletionContext): Promise<CompletionResult | null> {
  if (pluginSources.size === 0) return null;
  const line = context.state.doc.lineAt(context.pos);
  const request = {
    path: context.state.facet(notePath),
    before: context.state.sliceDoc(line.from, context.pos),
    position: context.pos,
    explicit: context.explicit,
  };
  for (const source of pluginSources) {
    try {
      const list = await source(request);
      if (context.aborted) return null;
      if (!list || list.options.length === 0) continue;
      return {
        from: Math.max(line.from, context.pos - list.replace),
        options: list.options.map((o) => ({ label: o.label, detail: o.detail, apply: o.insert ?? o.label })),
      };
    } catch (e) {
      console.error("a plugin's completion failed", e);
    }
  }
  return null;
}

/** Nothing of a note's is completed inside its code. */
function outsideCode(source: (context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>) {
  return (context: CompletionContext) => {
    for (let node = syntaxTree(context.state).resolveInner(context.pos, -1).node; node.parent; node = node.parent) {
      if (["FencedCode", "CodeBlock", "InlineCode"].includes(node.name)) return null;
    }
    return source(context);
  };
}

export function noteCompletion(): Extension {
  return autocompletion({
    override: [outsideCode(links), outsideCode(tags), outsideCode(callouts), outsideCode(fromPlugins)],
    icons: false,
    defaultKeymap: true,
    closeOnBlur: true,
    maxRenderedOptions: LIMIT,
    activateOnTypingDelay: 40,
  });
}
