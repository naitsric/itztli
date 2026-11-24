import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../backend/api";
import { showTag } from "../toolwindows/tagSelection";
import { useSettings } from "../settings/store";
import { Button, cx } from "../ui/primitives";
import { useVault } from "../vault/store";
import { rememberCaret, workspaceState } from "../vault/workspaceState";
import { keepPanelOf } from "../workbench/editorArea";
import { mountEditor } from "./active";
import { compareWithDisk } from "./compare";
import { attachView, detachView, openDocument, useDocuments, type NoteDocument } from "./documents";
import { editorExtensions } from "./extensions";
import { notePath } from "./note";
import { refreshProblems } from "./problems";

const FONTS = { ui: "var(--font-ui)", serif: "var(--font-serif)", mono: "var(--font-code)" };

/** A note in a tab, loaded and kept in step with its document. */
export function NoteEditor({ path, panelId, visible }: { path: string; panelId: string; visible: boolean }) {
  const [state, setState] = useState<{ doc: NoteDocument } | { error: string } | null>(null);

  useEffect(() => {
    let stale = false;
    openDocument(path)
      .then((doc) => !stale && setState({ doc }))
      .catch((e) => !stale && setState({ error: errorMessage(e) }));
    return () => {
      stale = true;
    };
  }, [path]);

  if (!state) return null;
  if ("error" in state) {
    return <div className="flex h-full items-center justify-center p-8 text-center text-muted">{state.error}</div>;
  }
  // While another note loads, the one before stays; its document is still open.
  return <DocumentEditor key={state.doc.path} doc={state.doc} panelId={panelId} visible={visible} />;
}

function DocumentEditor({ doc, panelId, visible }: { doc: NoteDocument; panelId: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const scroll = useRef<ReturnType<EditorView["scrollSnapshot"]> | null>(null);
  const editor = useSettings((s) => s.editor);
  const saved = useDocuments((s) => s.saved);
  const structure = useVault((s) => s.structure);
  const indexReady = useVault((s) => !!s.index?.ready);

  useEffect(() => {
    const caret = Math.min(workspaceState().carets[doc.path] ?? 0, doc.text.length);
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: doc.text,
        selection: { anchor: caret },
        extensions: [
          notePath.of(doc.path),
          editorExtensions(doc.path, showTag),
          doc.extension(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) {
              keepPanelOf(panelId);
            }
          }),
          EditorView.contentAttributes.of({ "aria-label": doc.path }),
        ],
      }),
      scrollTo: caret > 0 ? EditorView.scrollIntoView(caret, { y: "center" }) : undefined,
    });
    viewRef.current = view;
    attachView(doc, view);
    const unmount = mountEditor({ panelId, path: doc.path, view });
    const onBlur = () => void doc.save();
    view.contentDOM.addEventListener("blur", onBlur);
    return () => {
      rememberCaret(doc.path, view.state.selection.main.head);
      unmount();
      view.contentDOM.removeEventListener("blur", onBlur);
      detachView(doc, view);
      view.destroy();
      viewRef.current = null;
    };
  }, [doc, panelId]);

  // A hidden tab leaves the page, and loses where it was scrolled to.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (visible && scroll.current) {
      view.dispatch({ effects: scroll.current });
      scroll.current = null;
    } else if (visible) view.requestMeasure();
    return () => {
      if (visible) scroll.current = view.scrollSnapshot();
    };
  }, [visible]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && visible && indexReady) void refreshProblems(view);
  }, [saved, structure, indexReady, visible, doc]);

  const style = {
    "--editor-font": FONTS[editor.font],
    "--editor-size": `${editor.size}px`,
    "--editor-width": editor.width > 0 ? `${editor.width}px` : "none",
    "--line-inset": "28px",
  } as React.CSSProperties;

  return (
    <div className="flex h-full flex-col">
      <Banner doc={doc} />
      <div ref={host} style={style} data-focus-context="editor" className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

/** What has to be settled before the note can be saved. */
function Banner({ doc }: { doc: NoteDocument }) {
  const status = useDocuments((s) => s.open[doc.path]?.status);
  if (!status || status.state === "ready") return null;
  const tone = status.state === "failed" ? "bg-danger/10 text-danger" : "bg-warning/12 text-warning";
  return (
    <div className={cx("flex shrink-0 items-center gap-2 px-4 py-1.5 text-[12.5px]", tone)}>
      <span className="min-w-0 flex-1">
        {status.state === "conflict" && "This note changed on disk while you had unsaved changes."}
        {status.state === "deleted" && "This note was deleted while you had unsaved changes."}
        {status.state === "failed" && `Not saved: ${status.message}`}
      </span>
      {status.state === "conflict" && (
        <>
          <Button onClick={() => compareWithDisk(doc)}>Compare</Button>
          <Button onClick={() => void doc.takeDisk()}>Load from disk</Button>
          <Button onClick={() => void doc.keepMine()}>Keep mine</Button>
        </>
      )}
      {status.state === "deleted" && <Button onClick={() => void doc.keepMine()}>Save it again</Button>}
      {status.state === "failed" && <Button onClick={() => void doc.save()}>Try again</Button>}
    </div>
  );
}
