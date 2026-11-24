import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { api } from "../backend/api";
import { renderMarkdown } from "../preview/render";
import { displayName, isImage, isNote } from "../vault/paths";
import { host } from "../backend/host";
import { linkAt, type LinkRef } from "./links";
import { notePath } from "./note";

/**
 * Quick Documentation: what a link leads to, without going there. Shown on
 * hover, or at the caret with F1.
 */

async function describe(view: EditorView, link: LinkRef): Promise<((dom: HTMLElement) => () => void) | null> {
  if (link.kind === "url") return null;
  const source = view.state.facet(notePath);
  const path = link.target ? await api.linkResolve(source, link.target, link.relative) : source;
  if (!path) return null;
  if (isImage(path)) {
    return (dom) => {
      const img = document.createElement("img");
      img.src = host.vaultUrl(path);
      img.style.maxWidth = "100%";
      dom.append(img);
      return () => {};
    };
  }
  if (!isNote(path)) return null;
  const excerpt = await api.excerpt(source, link.target, link.subpath, link.relative).catch(() => null);
  if (!excerpt) return null;
  return (dom) => {
    const title = document.createElement("div");
    title.className = "cm-quick-doc-title";
    title.textContent = path;
    const body = document.createElement("div");
    dom.append(title, body);
    // Long notes are cut: this is a look, not a read.
    const text = excerpt.text.split("\n").slice(0, 120).join("\n");
    return renderMarkdown(text || `*${displayName(path)} is empty*`, body, { path: excerpt.path, depth: 1 });
  };
}

function tooltip(link: LinkRef, draw: (dom: HTMLElement) => () => void): Tooltip {
  return {
    pos: link.from,
    end: link.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-quick-doc";
      const dispose = draw(dom);
      return { dom, destroy: dispose };
    },
  };
}

const show = StateEffect.define<Tooltip | null>();

const atCaret = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(show)) return effect.value;
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (field) => showTooltip.from(field),
});

/** Shows what the link at the caret leads to. */
export async function showQuickDoc(view: EditorView): Promise<boolean> {
  if (view.state.field(atCaret, false)) {
    view.dispatch({ effects: show.of(null) });
    return true;
  }
  const head = view.state.selection.main.head;
  const link = linkAt(view.state, head);
  const draw = link && (await describe(view, link));
  if (!link || !draw || view.state.selection.main.head !== head) return false;
  view.dispatch({ effects: show.of(tooltip(link, draw)) });
  return true;
}

export function quickDoc(): Extension {
  return [
    atCaret,
    keymap.of([
      {
        key: "Escape",
        run(view) {
          if (!view.state.field(atCaret)) return false;
          view.dispatch({ effects: show.of(null) });
          return true;
        },
      },
    ]),
    hoverTooltip(
      async (view, pos) => {
        const link = linkAt(view.state, pos);
        if (!link || link.kind === "embed" || link.kind === "image") return null;
        const draw = await describe(view, link);
        return draw && tooltip(link, draw);
      },
      { hoverTime: 550 },
    ),
  ];
}
