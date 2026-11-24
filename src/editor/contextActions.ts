import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createMissingNote, extractToNote, openLink } from "../actions";
import { api } from "../backend/api";
import { displayName, isNote } from "../vault/paths";
import { changeHeadingLevel, reformat, toggleTask, toggleWrap } from "./commands";
import { splitRow } from "./tables";
import { linkAt, markdownLink, relativePath, wikiLink, type LinkRef } from "./links";
import { notePath } from "./note";

export interface ContextAction {
  title: string;
  run: () => void | Promise<void>;
}

export interface ActionContext {
  view: EditorView;
  path: string;
  line: string;
  selection: string;
  link: (LinkRef & { path: string | null }) | null;
}

type Provider = (context: ActionContext) => ContextAction[];

const pluginProviders = new Set<Provider>();

export function registerContextActions(provider: Provider): () => void {
  pluginProviders.add(provider);
  return () => void pluginProviders.delete(provider);
}

function replace(view: EditorView, from: number, to: number, insert: string) {
  view.dispatch({ changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length), userEvent: "input.action" });
  view.focus();
}

const aboutLinks: Provider = ({ view, path, link }) => {
  if (!link || link.kind === "url") return [];
  const actions: ContextAction[] = [];
  const set = (text: string) => replace(view, link.from, link.to, text);
  const shown = link.display ?? "";

  if (!link.path && link.target) {
    actions.push({ title: `Create note “${link.target}”`, run: () => createMissingNote(path, link.target) });
  } else {
    actions.push({ title: "Open in a split", run: () => openLink(path, link, { split: true }) });
  }
  if (link.kind === "wiki") {
    actions.push({ title: "Embed it here", run: () => set(`!${wikiLink(link.target, link.subpath, null)}`) });
    if (link.path) {
      const to = link.path;
      actions.push({
        title: "Convert to a Markdown link",
        run: () => set(markdownLink(relativePath(path, to), link.subpath, shown || link.subpath || displayName(to))),
      });
    }
    if (link.display) {
      actions.push({ title: "Show the note's name", run: () => set(wikiLink(link.target, link.subpath, null)) });
    }
  }
  if (link.kind === "embed") {
    actions.push({ title: "Link instead of embedding", run: () => set(wikiLink(link.target, link.subpath, null)) });
    if (link.path && isNote(link.path)) {
      actions.push({
        title: "Inline what it embeds",
        run: async () => {
          const excerpt = await api.excerpt(path, link.target, link.subpath, link.relative);
          set(excerpt.text.replace(/^---\n[\s\S]*?\n---\n/, "").trim());
        },
      });
    }
  }
  if (link.kind === "markdown" && link.path) {
    const to = link.path;
    actions.push({
      title: "Convert to a wiki link",
      run: async () => {
        const text = await api.linkText(path, to);
        set(wikiLink(text, link.subpath, shown && shown !== text ? shown : null));
      },
    });
  }
  return actions;
};

const aboutSelection: Provider = ({ view, path, selection }) => {
  if (!selection.trim()) return [];
  const { from, to } = view.state.selection.main;
  const actions: ContextAction[] = [
    {
      title: "Extract to a new note",
      run: async () => {
        const made = await extractToNote(path, selection);
        if (made) replace(view, from, to, made.link);
      },
    },
  ];
  if (!selection.includes("\n")) {
    actions.push(
      { title: "Make it a link", run: () => replace(view, from, to, `[[${selection}]]`) },
      { title: "Highlight it", run: () => void toggleWrap(view, "==") },
    );
  }
  return actions;
};

const aboutLine: Provider = ({ view, path, line }) => {
  const actions: ContextAction[] = [];
  const at = view.state.doc.lineAt(view.state.selection.main.head);

  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const level = heading[1]!.length;
    actions.push({
      title: "Extract section to a new note",
      run: async () => {
        let last = at.number;
        while (last < view.state.doc.lines) {
          const next = /^(#{1,6})\s/.exec(view.state.doc.line(last + 1).text);
          if (next && next[1]!.length <= level) break;
          last++;
        }
        const to = view.state.doc.line(last).to;
        const made = await extractToNote(path, view.state.sliceDoc(at.from, to));
        if (made) replace(view, at.from, to, `${made.link}\n`);
      },
    });
    if (level > 1) actions.push({ title: "Raise heading level", run: () => void changeHeadingLevel(view, -1) });
    if (level < 6) actions.push({ title: "Lower heading level", run: () => void changeHeadingLevel(view, 1) });
  }
  if (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) {
    actions.push({ title: /\[ \]/.test(line) ? "Mark as done" : "Mark as not done", run: () => void toggleTask(view) });
  } else if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
    actions.push({ title: "Make it a task", run: () => void toggleTask(view) });
  }
  if (line.includes("|") && splitRow(line).length > 1 && /^\s*\|/.test(line)) {
    actions.push({ title: "Align table", run: () => void reformat(view) });
  }
  return actions;
};

/** Words that are another note's name: link them. */
async function aboutMention(context: ActionContext): Promise<ContextAction[]> {
  const { view, path, link, selection } = context;
  if (link || selection) return [];
  const word = view.state.wordAt(view.state.selection.main.head);
  if (!word) return [];
  const text = view.state.sliceDoc(word.from, word.to);
  if (text.length < 3) return [];
  const to = await api.linkResolve(path, text).catch(() => null);
  if (!to || to === path || !isNote(to)) return [];
  return [{ title: `Link to “${displayName(to)}”`, run: () => replace(view, word.from, word.to, `[[${text}]]`) }];
}

/** What can be done where the caret is. */
export async function contextActions(view: EditorView): Promise<ContextAction[]> {
  const { state } = view;
  const { from, to, head } = state.selection.main;
  const path = state.facet(notePath);
  const link = linkAt(state, head);
  const context: ActionContext = {
    view,
    path,
    line: state.doc.lineAt(head).text,
    selection: state.sliceDoc(from, to),
    link: link && {
      ...link,
      path: link.kind === "url" ? null : await api.linkResolve(path, link.target, link.relative).catch(() => null),
    },
  };
  const own = [aboutLinks, aboutSelection, aboutLine].flatMap((provider) => provider(context));
  const mention = await aboutMention(context);
  const plugins = [...pluginProviders].flatMap((provider) => {
    try {
      return provider(context);
    } catch (e) {
      console.error("a plugin's context actions failed", e);
      return [];
    }
  });
  return [...mention, ...own, ...plugins];
}
