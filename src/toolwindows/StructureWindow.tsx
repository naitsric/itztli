import { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useState } from "react";
import { useActiveEditor, type MountedEditor } from "../editor/active";
import { flashLineAt } from "../editor/flash";
import { outline, type OutlineItem } from "../editor/outline";
import { onEditorUpdate } from "../editor/updates";
import { Marked } from "../ui/Highlight";
import { TreeView, type TreeRow } from "../ui/TreeView";
import { rememberPlace } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";

/** The headings of an editor's note, and the one the caret is under, live. */
export function useOutline(editor: MountedEditor | null): { items: OutlineItem[]; current: number } {
  const [state, setState] = useState<{ items: OutlineItem[]; current: number }>({ items: [], current: -1 });
  useEffect(() => {
    if (!editor) return setState({ items: [], current: -1 });
    const { view } = editor;
    let timer = 0;
    const read = () => {
      timer = 0;
      const items = outline(view.state);
      const head = view.state.selection.main.head;
      const current = items.findLastIndex((i) => i.from <= head);
      setState((before) => {
        const same =
          before.current === current &&
          before.items.length === items.length &&
          before.items.every((b, i) => b.from === items[i]!.from && b.text === items[i]!.text && b.level === items[i]!.level);
        return same ? before : { items, current };
      });
    };
    const stop = onEditorUpdate((update) => {
      if (update.view === view && !timer && (update.docChanged || update.selectionSet)) timer = window.setTimeout(read, 80);
    });
    read();
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [editor]);
  return state;
}

export function goToHeading(editor: MountedEditor, item: OutlineItem, focus: boolean) {
  const { view } = editor;
  rememberPlace();
  const pos = Math.min(item.from, view.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 40 }) });
  flashLineAt(view, pos);
  if (focus) view.focus();
}

export function StructureWindow() {
  const editor = useActiveEditor((s) => s.editor);
  const { items, current } = useOutline(editor);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // As the caret moves, the heading it is under is the selected one.
  useEffect(() => setSelected(current >= 0 ? String(items[current]!.from) : null), [current, items]);

  const rows = useMemo(() => {
    const list: TreeRow<OutlineItem>[] = [];
    const parents: OutlineItem[] = [];
    let hiddenUnder = Infinity;
    items.forEach((item, i) => {
      while (parents.length > 0 && parents[parents.length - 1]!.level >= item.level) parents.pop();
      const depth = parents.length;
      parents.push(item);
      if (item.level <= hiddenUnder) hiddenUnder = Infinity;
      const hidden = hiddenUnder !== Infinity;
      const hasChildren = (items[i + 1]?.level ?? 0) > item.level;
      const isCollapsed = collapsed.has(item.from) && !query;
      if (!hidden && isCollapsed) hiddenUnder = item.level;
      if (hidden || (query && !item.text.toLowerCase().includes(query.toLowerCase()))) return;
      list.push({
        id: String(item.from),
        depth: query ? 0 : depth,
        expanded: hasChildren && !query ? !isCollapsed : undefined,
        label: item.text,
        data: item,
      });
    });
    return list;
  }, [items, collapsed, query]);

  return (
    <>
      <ToolWindowHeader title="Structure" icon="list-tree" onHide={() => hideToolWindow("structure")} />
      <TreeView
        label="Structure"
        rows={rows}
        selected={selected}
        query={query}
        onQuery={setQuery}
        activateOnClick
        onSelect={(row) => setSelected(row.id)}
        onActivate={(row, how) => editor && goToHeading(editor, row.data, how !== "click")}
        onToggle={(row, expand) =>
          setCollapsed((before) => {
            const next = new Set(before);
            if (expand) next.delete(row.data.from);
            else next.add(row.data.from);
            return next;
          })
        }
        empty={<p className="px-4 py-3 text-[12.5px] text-subtle">{editor ? "This note has no headings." : "Open a note to see its headings."}</p>}
      >
        {(row, { query: q }) => (
          <>
            <span className="w-5 shrink-0 text-[10.5px] font-semibold text-subtle">H{row.data.level}</span>
            <span className="truncate">
              <Marked text={row.label || "(empty)"} query={q} />
            </span>
          </>
        )}
      </TreeView>
    </>
  );
}
