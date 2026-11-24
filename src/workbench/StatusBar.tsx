import { ChevronRight, CircleCheck, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { plural } from "../actions";
import { useActiveEditor } from "../editor/active";
import { problemCount } from "../editor/problems";
import { onEditorUpdate } from "../editor/updates";
import { useApp } from "../appInfo";
import { displayName } from "../vault/paths";
import { useVault } from "../vault/store";
import { revealInVault } from "../toolwindows/vaultReveal";
import { useEditorArea } from "./editorArea";
import { showToolWindow } from "./toolWindows";
import { useStatusItems, type StatusItem } from "./statusItems";

export function StatusBar() {
  const info = useVault((s) => s.info);
  const index = useVault((s) => s.index);
  const safeMode = useApp((s) => s.info?.safeMode);
  const items = useStatusItems((s) => s.items);
  const left = items.filter((i) => i.side === "left");
  const right = items.filter((i) => i.side === "right");
  return (
    <footer className="flex h-[var(--statusbar-height)] shrink-0 items-center gap-3 bg-frame px-3 text-[11.5px] text-muted">
      {info && <Breadcrumbs vault={info.name} />}
      {left.map((i) => (
        <Item key={i.id} item={i} />
      ))}
      <span className="ml-auto flex items-center gap-3">
        {safeMode && (
          <span className="flex items-center gap-1 font-medium text-warning">
            <ShieldAlert className="size-3.5" /> Safe Mode: no plugins
          </span>
        )}
        {index && !index.ready && <span className="text-accent">Indexing…</span>}
        {right.map((i) => (
          <Item key={i.id} item={i} />
        ))}
        <EditorStatus />
        {index?.ready && (
          <span title={`Indexed in ${index.elapsedMs} ms`} className="text-subtle tabular-nums">
            {plural(index.notes, "note")}
          </span>
        )}
      </span>
    </footer>
  );
}

function Item({ item }: { item: StatusItem }) {
  if (!item.text) return null;
  if (!item.onClick) return <span title={item.title}>{item.text}</span>;
  return (
    <button type="button" title={item.title} className="rounded px-1 hover:bg-hover hover:text-fg" onClick={item.onClick}>
      {item.text}
    </button>
  );
}

function Breadcrumbs({ vault }: { vault: string }) {
  const path = useEditorArea((s) => s.activePath);
  const parts = path ? path.split("/") : [];
  return (
    <nav aria-label="Path" className="flex min-w-0 items-center">
      <button type="button" className="truncate rounded px-1 hover:bg-hover hover:text-fg" onClick={() => showToolWindow("vault")}>
        {vault}
      </button>
      {parts.map((part, i) => {
        const to = parts.slice(0, i + 1).join("/");
        return (
          <span key={to} className="flex min-w-0 items-center">
            <ChevronRight className="size-3 shrink-0 text-subtle" />
            <button type="button" className="truncate rounded px-1 hover:bg-hover hover:text-fg" onClick={() => revealInVault(to)}>
              {i === parts.length - 1 ? displayName(to) : part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

/** Caret, selection and problems of the note in front. */
function EditorStatus() {
  const editor = useActiveEditor((s) => s.editor);
  const activePath = useEditorArea((s) => s.activePath);
  const [status, setStatus] = useState<{ line: number; col: number; selected: number; problems: number } | null>(null);

  useEffect(() => {
    if (!editor || editor.path !== activePath) return setStatus(null);
    const { view } = editor;
    const read = () => {
      const { main } = view.state.selection;
      const line = view.state.doc.lineAt(main.head);
      const next = { line: line.number, col: main.head - line.from + 1, selected: main.to - main.from, problems: problemCount(view) };
      setStatus((s) =>
        s && s.line === next.line && s.col === next.col && s.selected === next.selected && s.problems === next.problems ? s : next,
      );
    };
    read();
    let frame = 0;
    const stop = onEditorUpdate((update) => {
      if (update.view !== view || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    });
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [editor, activePath]);

  if (!status) return null;
  return (
    <>
      <button
        type="button"
        title="Problems in this note"
        className="flex items-center gap-1 rounded px-1 hover:bg-hover"
        onClick={() => showToolWindow("problems")}
      >
        {status.problems > 0 ? (
          <>
            <TriangleAlert className="size-3.5 text-warning" /> {status.problems}
          </>
        ) : (
          <CircleCheck className="size-3.5 text-success" />
        )}
      </button>
      <span className="tabular-nums">
        {status.line}:{status.col}
        {status.selected > 0 && ` (${status.selected})`}
      </span>
    </>
  );
}
