import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashLine = Decoration.line({ class: "cm-flash" });

/** Holds the flashed line; the CSS animation does the fading. */
export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue;
      next = effect.value ? Decoration.set([flashLine.range(tr.newDoc.lineAt(effect.value.from).from)]) : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Matches the `itztli-flash` animation. */
const FLASH_MS = 900;
const timers = new WeakMap<EditorView, number>();

/** Briefly highlights the line a jump landed on. */
export function flashLineAt(view: EditorView, pos: number) {
  window.clearTimeout(timers.get(view));
  // Cleared first, so flashing the same line twice restarts the animation.
  view.dispatch({ effects: setFlash.of(null) });
  view.dispatch({ effects: setFlash.of({ from: Math.min(pos, view.state.doc.length), to: pos }) });
  timers.set(
    view,
    window.setTimeout(() => view.dom.isConnected && view.dispatch({ effects: setFlash.of(null) }), FLASH_MS),
  );
}
