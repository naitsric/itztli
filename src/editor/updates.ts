import { EditorView, type ViewUpdate } from "@codemirror/view";

/** Lets the UI around the editors follow what happens in them. */
const listeners = new Set<(update: ViewUpdate) => void>();

export const publishUpdates = EditorView.updateListener.of((update) => {
  for (const listener of listeners) listener(update);
});

/** Hears every update of every note editor. */
export function onEditorUpdate(listener: (update: ViewUpdate) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
