import { useMemo } from "react";
import { plural } from "../actions";
import { api, type Usages } from "../backend/api";
import { useDocuments } from "../editor/documents";
import { plainText } from "../editor/outline";
import { displayName } from "../vault/paths";
import { useVault } from "../vault/store";
import { useEditorArea } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { UsageTree, type PlaceGroup } from "./UsageTree";
import { useQuery } from "./useQuery";

export function usageGroups(usages: readonly Usages[]): PlaceGroup[] {
  return usages.map(({ path, links }) => ({
    path,
    places: links.map((link) => {
      const text = plainText(link.context.replace(/^\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s+(?:\[[ xX]\]\s+)?/, ""));
      return { line: link.line, col: link.col, label: text, content: text };
    }),
  }));
}

/** Where the note in front is linked from. */
export function BacklinksWindow() {
  const path = useEditorArea((s) => s.activePath);
  const content = useVault((s) => s.content);
  const saved = useDocuments((s) => s.saved);
  const usages = useQuery<Usages[]>(() => (path ? api.usages(path) : Promise.resolve([])), [path, content, saved]);
  const groups = useMemo(() => usageGroups(usages ?? []), [usages]);
  const total = groups.reduce((n, g) => n + g.places.length, 0);
  return (
    <>
      <ToolWindowHeader title="Backlinks" icon="backlinks" onHide={() => hideToolWindow("backlinks")}>
        {total > 0 && <span className="mr-1 text-[11.5px] text-subtle">{plural(total, "link")}</span>}
      </ToolWindowHeader>
      <UsageTree
        label="Backlinks"
        groups={groups}
        empty={
          <p className="px-4 py-3 text-[12.5px] text-subtle">
            {path ? `No note links to ${displayName(path)} yet.` : "Open a note to see what links to it."}
          </p>
        }
      />
    </>
  );
}
