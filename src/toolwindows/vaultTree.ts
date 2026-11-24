import type { Entry } from "../backend/api";
import type { TreeRow } from "../ui/TreeView";
import { compareNames, displayName, isNote, nameOf, parentOf } from "../vault/paths";

/** Entries by the folder holding them, folders first, then by name. */
export function groupByFolder(entries: Iterable<Entry>, showAttachments: boolean): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.folder && !showAttachments && !isNote(entry.path)) continue;
    const parent = parentOf(entry.path);
    const group = groups.get(parent);
    if (group) group.push(entry);
    else groups.set(parent, [entry]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Number(b.folder) - Number(a.folder) || compareNames(nameOf(a.path), nameOf(b.path)));
  }
  return groups;
}

/** The rows to show, with the folders that are open. */
export function treeRows(groups: Map<string, Entry[]>, expanded: ReadonlySet<string>): TreeRow<Entry>[] {
  const rows: TreeRow<Entry>[] = [];
  const add = (folder: string, depth: number) => {
    for (const entry of groups.get(folder) ?? []) {
      const open = entry.folder ? expanded.has(entry.path) : undefined;
      rows.push({ id: entry.path, depth, expanded: open, label: displayName(entry.path), data: entry });
      if (open) add(entry.path, depth + 1);
    }
  };
  add("", 0);
  return rows;
}

/** Only what matches a query, with the folders leading to it, all open. */
export function filteredRows(groups: Map<string, Entry[]>, query: string): TreeRow<Entry>[] {
  const wanted = query.toLowerCase();
  const rows: TreeRow<Entry>[] = [];
  const add = (folder: string, depth: number): boolean => {
    let any = false;
    for (const entry of groups.get(folder) ?? []) {
      const at = rows.length;
      const label = displayName(entry.path);
      rows.push({ id: entry.path, depth, expanded: entry.folder ? true : undefined, label, data: entry });
      const inside = entry.folder && add(entry.path, depth + 1);
      if (inside || label.toLowerCase().includes(wanted)) any = true;
      else rows.length = at;
    }
    return any;
  };
  add("", 0);
  return rows;
}
