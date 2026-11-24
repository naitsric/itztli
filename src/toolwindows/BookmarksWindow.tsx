import { Bookmark as BookmarkIcon, X } from "lucide-react";
import { useMemo, useState } from "react";
import { FileIcon } from "../ui/FileIcon";
import { TreeView, type TreeRow } from "../ui/TreeView";
import { displayName } from "../vault/paths";
import { openPath } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { removeBookmark, useBookmarks, type Bookmark } from "./bookmarks";

export function BookmarksWindow() {
  const bookmarks = useBookmarks((s) => s.bookmarks);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () =>
      bookmarks
        .map((b): TreeRow<Bookmark> => {
          const label = b.text ? `${displayName(b.path)}: ${b.text}` : displayName(b.path);
          return { id: `${b.path}:${b.line ?? ""}`, depth: 0, label, data: b };
        })
        .filter((r) => r.label.toLowerCase().includes(query.toLowerCase())),
    [bookmarks, query],
  );
  return (
    <>
      <ToolWindowHeader title="Bookmarks" icon="bookmark" onHide={() => hideToolWindow("bookmarks")} />
      <TreeView
        label="Bookmarks"
        rows={rows}
        selected={selected}
        query={query}
        onQuery={setQuery}
        activateOnClick
        onSelect={(row) => setSelected(row.id)}
        onActivate={({ data }, how) => openPath(data.path, { line: data.line, focus: how !== "click" })}
        empty={<p className="px-4 py-3 text-[12.5px] text-subtle">Press F3 in a note to bookmark where you are.</p>}
      >
        {({ data, label }) => (
          <>
            {data.line === undefined ? <FileIcon path={data.path} /> : <BookmarkIcon className="size-3.5 shrink-0 text-warning" />}
            <span className="truncate">{label}</span>
            <button
              type="button"
              aria-label="Remove bookmark"
              className="ml-auto flex size-4 shrink-0 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg"
              onClick={(e) => {
                e.stopPropagation();
                removeBookmark(data);
              }}
            >
              <X className="size-3" />
            </button>
          </>
        )}
      </TreeView>
    </>
  );
}
