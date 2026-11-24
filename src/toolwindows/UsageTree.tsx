import { useMemo, useState, type ReactNode } from "react";
import { FileIcon } from "../ui/FileIcon";
import { TreeView, type TreeRow } from "../ui/TreeView";
import { displayName, parentOf } from "../vault/paths";
import { openPath } from "../workbench/editorArea";

/** Places in notes, grouped by note: backlinks, search results, problems, tasks. */
export interface PlaceGroup {
  path: string;
  places: { line: number; col: number; content: ReactNode; label: string }[];
}

type Row = { path: string; place?: PlaceGroup["places"][number]; count: number };

export function UsageTree({ groups, label, empty }: { groups: readonly PlaceGroup[]; label: string; empty: ReactNode }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const wanted = query.toLowerCase();
    const list: TreeRow<Row>[] = [];
    for (const { path, places } of groups) {
      const name = displayName(path);
      const matching = wanted && !name.toLowerCase().includes(wanted) ? places.filter((p) => p.label.toLowerCase().includes(wanted)) : places;
      if (matching.length === 0) continue;
      const open = wanted ? true : !collapsed.has(path);
      list.push({ id: path, depth: 0, expanded: open, label: name, data: { path, count: matching.length } });
      if (!open) continue;
      matching.forEach((place, i) => {
        list.push({ id: `${path}:${place.line}:${place.col}:${i}`, depth: 1, label: place.label, data: { path, place, count: 0 } });
      });
    }
    return list;
  }, [groups, collapsed, query]);

  return (
    <TreeView
      label={label}
      rows={rows}
      selected={selected}
      query={query}
      onQuery={setQuery}
      onSelect={(row) => setSelected(row.id)}
      activateOnClick
      onActivate={({ data }, how) => {
        if (!data.place) return how === "click" ? undefined : openPath(data.path);
        openPath(data.path, { line: data.place.line, col: data.place.col, focus: how !== "click", preview: how === "click" });
      }}
      onToggle={(row, expand) =>
        setCollapsed((before) => {
          const next = new Set(before);
          if (expand) next.delete(row.id);
          else next.add(row.id);
          return next;
        })
      }
      empty={empty}
    >
      {({ data }) =>
        data.place ? (
          <span className="min-w-0 truncate text-muted">{data.place.content}</span>
        ) : (
          <>
            <FileIcon path={data.path} />
            <span className="truncate font-medium">{displayName(data.path)}</span>
            <span className="truncate text-[11.5px] text-subtle">{parentOf(data.path)}</span>
            <span className="ml-auto shrink-0 text-[11.5px] text-subtle tabular-nums">{data.count}</span>
          </>
        )
      }
    </TreeView>
  );
}

/** A line with a stretch of it standing out. */
export function Excerpted({ text, from, length }: { text: string; from: number; length: number }) {
  return (
    <>
      {text.slice(0, from)}
      <span className="rounded-sm bg-warning/25 font-medium text-fg">{text.slice(from, from + length)}</span>
      {text.slice(from + length)}
    </>
  );
}
