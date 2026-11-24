import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, codeFolding, foldKeymap, indentOnInput, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches } from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension, type StateEffect } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { openLink } from "../actions";
import { api } from "../backend/api";
import { settings, useSettings, type Settings } from "../settings/store";
import { notifyError } from "../ui/notifications";
import { isNote, nameOf } from "../vault/paths";
import { attachments } from "./attachments";
import { selectionStack } from "./commands";
import { noteCompletion } from "./completion";
import { findPanel } from "./findPanel";
import { flashField } from "./flash";
import { linkAt, tagAt } from "./links";
import { livePreview } from "./livePreview";
import { notePath } from "./note";
import { quickDoc } from "./quickDoc";
import { linkResolution } from "./resolver";
import { frontmatterEnd, noteLanguage } from "./syntax";
import { editorHighlighting, editorTheme } from "./theme";
import { publishUpdates } from "./updates";

// ── Extensions from plugins ────────────────────────────────────────────────

let pluginExtensions: readonly Extension[] = [];
const pluginCompartment = new Compartment();
const views = new Set<EditorView>();

function applyPlugins() {
  for (const view of views) reconfigurePlugins(view);
}

function reconfigurePlugins(view: EditorView) {
  try {
    view.dispatch({ effects: pluginCompartment.reconfigure([...pluginExtensions]) });
  } catch (e) {
    console.error("a plugin's editor extension was rejected", e);
    view.dispatch({ effects: pluginCompartment.reconfigure([]) });
  }
}

/** Adds a CodeMirror extension to every note editor, open or to come. */
export function registerEditorExtension(extension: Extension): () => void {
  // Refused here, where the plugin hears of it, rather than in an editor.
  EditorState.create({ extensions: [extension] });
  const entry = [extension];
  pluginExtensions = [...pluginExtensions, entry];
  applyPlugins();
  return () => {
    pluginExtensions = pluginExtensions.filter((e) => e !== entry);
    applyPlugins();
  };
}

// ── Following links ────────────────────────────────────────────────────────

/** Shows the pointer over links while ⌘ is held. */
const modHeld = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      window.addEventListener("keydown", this.onKey, true);
      window.addEventListener("keyup", this.onKey, true);
      window.addEventListener("blur", this.clear);
    }
    private readonly onKey = (e: KeyboardEvent) => this.view.dom.classList.toggle("cm-mod-held", e.metaKey || e.ctrlKey);
    private readonly clear = () => this.view.dom.classList.remove("cm-mod-held");
    destroy() {
      window.removeEventListener("keydown", this.onKey, true);
      window.removeEventListener("keyup", this.onKey, true);
      window.removeEventListener("blur", this.clear);
    }
  },
);

/** Follows what is at a position. Whether there was something to follow. */
export function followAt(view: EditorView, pos: number, options: { split?: boolean; onTag: (tag: string) => void }): boolean {
  const tag = tagAt(view.state, pos);
  if (tag) {
    options.onTag(tag);
    return true;
  }
  const link = linkAt(view.state, pos);
  if (!link) return false;
  const going =
    link.kind === "url" ? api.urlOpen(link.target) : openLink(view.state.facet(notePath), link, { split: options.split });
  going.catch((e) => notifyError(e, "The link can't be opened"));
  return true;
}

function linkClicks(onTag: (tag: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as Element;
      const onLink = target.closest(".cm-link-text");
      const onTagMark = target.closest(".cm-tag");
      if (!onLink && !onTagMark) return false;
      const mod = event.metaKey || event.ctrlKey;
      const middle = event.button === 1;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
      if (!mod && !middle) {
        if (event.button !== 0 || event.shiftKey || event.altKey || event.detail > 1) return false;
        if (!settings().editor.clickOpensLinks || !onLink || !settings().editor.livePreview) return false;
        // Where one is editing a link, a click places the caret.
        const link = linkAt(view.state, pos);
        const { from, to } = view.state.selection.main;
        if (!link || (view.hasFocus && from <= link.to && to >= link.from)) return false;
      }
      if (!followAt(view, pos, { split: middle || (mod && event.shiftKey), onTag })) return false;
      event.preventDefault();
      return true;
    },
  });
}

// ── Settings ───────────────────────────────────────────────────────────────

const previewCompartment = new Compartment();
const numbersCompartment = new Compartment();
const languageCompartment = new Compartment();
const spellcheckCompartment = new Compartment();

const numbers = (on: boolean): Extension => (on ? [lineNumbers(), highlightActiveLineGutter()] : []);
const spellcheck = (on: boolean): Extension =>
  EditorView.contentAttributes.of({ spellcheck: String(on), autocorrect: on ? "on" : "off", autocapitalize: "off" });

/** Keeps an editor in step with the settings and the plugins. */
const follow = ViewPlugin.fromClass(
  class {
    private readonly stop: () => void;
    constructor(private readonly view: EditorView) {
      views.add(view);
      this.stop = useSettings.subscribe((next, before) => this.apply(next.editor, before.editor));
    }
    private apply(next: Settings["editor"], before: Settings["editor"]) {
      const effects: StateEffect<unknown>[] = [];
      if (next.livePreview !== before.livePreview && isNote(this.view.state.facet(notePath))) {
        effects.push(previewCompartment.reconfigure(next.livePreview ? livePreview() : []));
      }
      if (next.lineNumbers !== before.lineNumbers) effects.push(numbersCompartment.reconfigure(numbers(next.lineNumbers)));
      if (next.spellcheck !== before.spellcheck) effects.push(spellcheckCompartment.reconfigure(spellcheck(next.spellcheck)));
      if (effects.length > 0) this.view.dispatch({ effects });
      else this.view.requestMeasure();
    }
    update(update: ViewUpdate) {
      if (!update.docChanged || !isNote(update.state.facet(notePath))) return;
      // What opens the note decides how the rest reads, and the parser keeps
      // what it had: closing the frontmatter needs a fresh start.
      const had = frontmatterEnd(update.startState.doc) !== null;
      const has = frontmatterEnd(update.state.doc) !== null;
      if (had === has) return;
      queueMicrotask(() => this.view.dispatch({ effects: languageCompartment.reconfigure(noteLanguage()) }));
    }
    destroy() {
      views.delete(this.view);
      this.stop();
    }
  },
);

/** Everything a note editor is made of, the document's own part aside. */
export function editorExtensions(path: string, onTag: (tag: string) => void): Extension {
  const { editor } = settings();
  const note = isNote(path);
  const shared: Extension = [
    EditorView.exceptionSink.of((e) => console.error("an editor extension failed", e)),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches({ minSelectionLength: 2, wholeWords: true }),
    findPanel(),
    // Over the whole window: the editor's island would cut them.
    tooltips({ parent: document.body }),
    flashField,
    publishUpdates,
    selectionStack,
    editorTheme,
    editorHighlighting,
    numbersCompartment.of(numbers(editor.lineNumbers)),
    spellcheckCompartment.of(spellcheck(editor.spellcheck)),
    EditorState.tabSize.of(4),
    follow,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
  ];
  if (!note) {
    const language = LanguageDescription.matchFilename(languages, nameOf(path));
    return [
      shared,
      languageCompartment.of([]),
      ViewPlugin.define((view) => {
        void language?.load().then((support) => view.dom.isConnected && view.dispatch({ effects: languageCompartment.reconfigure(support) }));
        return {};
      }),
    ];
  }
  return [
    shared,
    languageCompartment.of(noteLanguage()),
    linkResolution(),
    previewCompartment.of(editor.livePreview ? livePreview() : []),
    codeFolding({ placeholderText: "…" }),
    noteCompletion(),
    quickDoc(),
    attachments(),
    Prec.high(linkClicks(onTag)),
    modHeld,
    Prec.low(pluginCompartment.of([...pluginExtensions])),
  ];
}
