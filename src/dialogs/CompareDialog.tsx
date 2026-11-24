import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useLayoutEffect, useRef } from "react";
import { useComparison } from "../editor/compare";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/primitives";

const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { fontSize: "12.5px", backgroundColor: "var(--bg-panel)" },
    ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "1.6" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
    ".cm-changedLine": { backgroundColor: "var(--accent-soft)" },
    ".cm-changedText": { background: "var(--editor-match)" },
    ".cm-deletedChunk": { backgroundColor: "transparent" },
  }),
];

/** Two texts side by side. */
export function Diff({ before, after }: { before: string; after: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = new MergeView({
      parent: host.current!,
      a: { doc: before, extensions: readOnly },
      b: { doc: after, extensions: readOnly },
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    return () => view.destroy();
  }, [before, after]);
  return <div ref={host} className="h-full overflow-auto" />;
}

/** One text, to read. */
export function NoteText({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const view = new EditorView({ parent: host.current!, doc: text, extensions: readOnly });
    return () => view.destroy();
  }, [text]);
  return <div ref={host} className="h-full overflow-auto" />;
}

export function CompareDialog() {
  const shown = useComparison((s) => s.shown);
  if (!shown) return null;
  const close = () => useComparison.setState({ shown: null });
  return (
    <Modal
      open
      onClose={close}
      title={shown.title}
      width={1100}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={close}>Close</Button>
          {shown.actions.map((a) => (
            <Button
              key={a.title}
              onClick={() => {
                close();
                a.run();
              }}
            >
              {a.title}
            </Button>
          ))}
        </>
      }
    >
      <div className="mb-2 grid grid-cols-2 text-[12px] font-medium text-muted">
        <span>{shown.before.label}</span>
        <span>{shown.after.label}</span>
      </div>
      <div className="h-[min(560px,60vh)] overflow-hidden rounded-md border border-border">
        <Diff before={shown.before.text} after={shown.after.text} />
      </div>
    </Modal>
  );
}
