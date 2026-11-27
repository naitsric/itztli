import { Spline } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { FileIcon } from "../ui/FileIcon";
import { TreeView } from "../ui/TreeView";
import { displayName, parentOf } from "../vault/paths";
import { openPath } from "../workbench/editorArea";
import { usageRows, type PlaceGroup } from "./usages";

export type { PlaceGroup } from "./usages";

export function UsageTree({ groups, label, empty }: { groups: readonly PlaceGroup[]; label: string; empty: ReactNode }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => usageRows(groups, collapsed, query), [groups, collapsed, query]);

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
        if (data.kind === "relation") return;
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
      {({ data }) => {
        switch (data.kind) {
          case "relation":
            return (
              <>
                <Spline className="size-3.5 shrink-0 text-subtle" />
                <span className="truncate font-medium">{data.name}</span>
                <span className="ml-auto shrink-0 text-[11.5px] text-subtle tabular-nums">{data.count}</span>
              </>
            );
          case "note":
            return (
              <>
                <FileIcon path={data.path} />
                <span className="truncate font-medium">{displayName(data.path)}</span>
                <span className="truncate text-[11.5px] text-subtle">{parentOf(data.path)}</span>
                {(!data.place || data.count > 1) && (
                  <span className="ml-auto shrink-0 text-[11.5px] text-subtle tabular-nums">{data.count}</span>
                )}
              </>
            );
          case "place":
            return <span className="min-w-0 truncate text-muted">{data.place.content}</span>;
        }
      }}
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
