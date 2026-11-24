import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { api } from "../backend/api";
import { useVault } from "../vault/store";
import { notePath } from "./note";

/** A link as far as finding its file goes. */
export interface LinkTarget {
  target: string;
  relative: boolean;
}

const keyOf = ({ target, relative }: LinkTarget) => `${relative ? "r" : "w"}:${target}`;

/** What links of this note lead to, as far as known: a path, or `null` for nowhere. */
const setResolved = StateEffect.define<ReadonlyMap<string, string | null>>();

export const resolvedLinks = StateField.define<ReadonlyMap<string, string | null>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setResolved)) value = effect.value;
    return value;
  },
});

/** `undefined` while it is not known yet. */
export function resolvedLink(view: EditorView, link: LinkTarget): string | null | undefined {
  return view.state.field(resolvedLinks, false)?.get(keyOf(link));
}

/**
 * Finds out where links on screen lead, a batch at a time, and again when
 * files come and go. Whoever draws links asks with `want`.
 */
class Resolver {
  private readonly wanted = new Map<string, LinkTarget>();
  private timer = 0;
  private stale = false;
  private readonly stop: () => void;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.stop = useVault.subscribe((state, before) => {
      if (state.structure !== before.structure) this.invalidate();
    });
  }

  want(link: LinkTarget) {
    const key = keyOf(link);
    if (this.view.state.field(resolvedLinks).has(key) || this.wanted.has(key)) return;
    this.wanted.set(key, link);
    this.schedule();
  }

  private invalidate() {
    // What is known stays until it is known again, so nothing flickers.
    for (const key of this.view.state.field(resolvedLinks).keys()) {
      this.wanted.set(key, { relative: key.startsWith("r:"), target: key.slice(2) });
    }
    this.stale = true;
    this.schedule();
  }

  private schedule() {
    if (!this.timer) this.timer = window.setTimeout(() => void this.run(), 0);
  }

  private async run() {
    this.timer = 0;
    const links = [...this.wanted.values()];
    const stale = this.stale;
    this.wanted.clear();
    this.stale = false;
    if (links.length === 0) return;
    const source = this.view.state.facet(notePath);
    const found = await api.linksResolve(links.map((l) => ({ ...l, source }))).catch(() => null);
    if (!found || this.destroyed) return;
    const next = new Map(stale ? [] : this.view.state.field(resolvedLinks));
    links.forEach((link, i) => next.set(keyOf(link), found[i] ?? null));
    this.view.dispatch({ effects: setResolved.of(next) });
  }

  update(update: ViewUpdate) {
    if (update.startState.facet(notePath) !== update.state.facet(notePath)) this.invalidate();
  }

  destroy() {
    this.destroyed = true;
    window.clearTimeout(this.timer);
    this.stop();
  }
}

export const resolver = ViewPlugin.fromClass(Resolver);

export function linkResolution(): Extension {
  return [resolvedLinks, resolver];
}
