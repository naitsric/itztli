import { Hash } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type TagCount } from "../backend/api";
import { useDocuments } from "../editor/documents";
import { FileIcon } from "../ui/FileIcon";
import { Marked } from "../ui/Highlight";
import { TreeView, type TreeRow } from "../ui/TreeView";
import { displayName, parentOf } from "../vault/paths";
import { useVault } from "../vault/store";
import { openPath } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { useTagSelection } from "./tagSelection";
import { useQuery } from "./useQuery";

type Row = { kind: "tag"; tag: TagCount } | { kind: "note"; path: string };

export function TagsWindow() {
  const content = useVault((s) => s.content);
  const saved = useDocuments((s) => s.saved);
  const request = useTagSelection();
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const tags = useQuery<TagCount[]>(() => api.tags(), [content, saved]) ?? [];
  const opened = useMemo(() => [...open].sort(), [open]);
  const notes = useQuery<Map<string, string[]>>(
    async () => new Map(await Promise.all(opened.map(async (tag) => [tag, await api.notesWithTag(tag)] as const))),
    [opened, content, saved],
  );

  useEffect(() => {
    if (!request.tag) return;
    const key = request.tag.toLowerCase();
    setQuery("");
    setOpen((before) => {
      const next = new Set(before);
      key.split("/").forEach((_, i, parts) => next.add(parts.slice(0, i + 1).join("/")));
      return next;
    });
    setSelected(key);
  }, [request]);

  const rows = useMemo(() => {
    const list: TreeRow<Row>[] = [];
    const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const tag of sorted) {
      const key = tag.name.toLowerCase();
      const parts = key.split("/");
      const shown = query
        ? key.includes(query.toLowerCase())
        : parts.slice(0, -1).every((_, i) => open.has(parts.slice(0, i + 1).join("/")));
      if (!shown) continue;
      const depth = query ? 0 : parts.length - 1;
      const isOpen = open.has(key);
      const label = query ? tag.name : tag.name.slice(tag.name.lastIndexOf("/") + 1);
      list.push({ id: key, depth, expanded: isOpen, label, data: { kind: "tag", tag } });
      if (!isOpen) continue;
      // A note is shown under the most specific tag it is open under.
      const nested = sorted.filter((t) => t.name.toLowerCase().startsWith(`${key}/`) && open.has(t.name.toLowerCase()) && !query);
      const elsewhere = new Set(nested.flatMap((t) => notes?.get(t.name.toLowerCase()) ?? []));
      for (const path of notes?.get(key) ?? []) {
        if (elsewhere.has(path)) continue;
        list.push({ id: `${key}:${path}`, depth: depth + 1, label: displayName(path), data: { kind: "note", path } });
      }
    }
    return list;
  }, [tags, open, notes, query]);

  const toggle = (id: string, expand: boolean) =>
    setOpen((before) => {
      const next = new Set(before);
      if (expand) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <>
      <ToolWindowHeader title="Tags" icon="tag" onHide={() => hideToolWindow("tags")} />
      <TreeView
        label="Tags"
        rows={rows}
        selected={selected}
        query={query}
        onQuery={setQuery}
        onSelect={(row) => setSelected(row.id)}
        activateOnClick
        onActivate={(row, how) => {
          if (row.data.kind === "tag") toggle(row.id, !row.expanded);
          else openPath(row.data.path, { preview: how === "click", focus: how !== "click" });
        }}
        onToggle={(row, expand) => toggle(row.id, expand)}
        empty={<p className="px-4 py-3 text-[12.5px] text-subtle">{query ? "Nothing matches" : "No note has tags yet. Write #something in one."}</p>}
      >
        {(row, { query: q }) =>
          row.data.kind === "tag" ? (
            <>
              <Hash className="size-3.5 shrink-0 text-tag" />
              <span className="truncate">
                <Marked text={row.label} query={q} />
              </span>
              <span className="ml-auto text-[11.5px] text-subtle tabular-nums">{row.data.tag.notes}</span>
            </>
          ) : (
            <>
              <FileIcon path={row.data.path} />
              <span className="truncate">{row.label}</span>
              <span className="truncate text-[11.5px] text-subtle">{parentOf(row.data.path)}</span>
            </>
          )
        }
      </TreeView>
    </>
  );
}
