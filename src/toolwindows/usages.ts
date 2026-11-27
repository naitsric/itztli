import type { ReactNode } from "react";
import type { Usages } from "../backend/api";
import { plainText } from "../editor/outline";
import { displayName } from "../vault/paths";
import type { TreeRow } from "../ui/TreeView";

export interface Place {
  line: number;
  col: number;
  content: ReactNode;
  label: string;
}

/** Places in notes, grouped by note: backlinks, search results, problems, tasks. */
export interface PlaceGroup {
  path: string;
  places: Place[];
  /**
   * The property these places link through. The note is then listed under
   * the property's name, as one row that opens at the first of them.
   */
  relation?: string;
}

export type UsageRow =
  | { kind: "relation"; name: string; count: number }
  | { kind: "note"; path: string; count: number; place?: Place }
  | { kind: "place"; path: string; place: Place };

/** Backlinks through a property under its name, by name; then the rest, by note. */
export function usageGroups(usages: readonly Usages[]): PlaceGroup[] {
  const related: PlaceGroup[] = [];
  const mentions: PlaceGroup[] = [];
  for (const { path, links } of usages) {
    const byRelation = new Map<string, Place[]>();
    const plain: Place[] = [];
    for (const link of links) {
      const text = plainText(link.context.replace(/^\s*(?:[-*+]|\d+[.)]|>|#{1,6})\s+(?:\[[ xX]\]\s+)?/, ""));
      const place = { line: link.line, col: link.col, label: text, content: text };
      if (!link.relation) plain.push(place);
      else (byRelation.get(link.relation) ?? byRelation.set(link.relation, []).get(link.relation)!).push(place);
    }
    for (const [relation, places] of byRelation) related.push({ path, places, relation });
    if (plain.length > 0) mentions.push({ path, places: plain });
  }
  related.sort((a, b) => a.relation!.localeCompare(b.relation!));
  return [...related, ...mentions];
}

/**
 * The rows of a usage tree. Notes linking through a property go under its
 * name, where it first comes; the others show their places. Typing keeps
 * what has it in the note's name, the property's or a place.
 */
export function usageRows(groups: readonly PlaceGroup[], collapsed: ReadonlySet<string>, query: string): TreeRow<UsageRow>[] {
  const wanted = query.toLowerCase();
  const has = (text: string) => text.toLowerCase().includes(wanted);
  const sections = new Map<string, PlaceGroup[]>();
  const order: (PlaceGroup | string)[] = [];
  for (const group of groups) {
    if (group.relation === undefined) order.push(group);
    else if (sections.has(group.relation)) sections.get(group.relation)!.push(group);
    else {
      sections.set(group.relation, [group]);
      order.push(group.relation);
    }
  }

  const rows: TreeRow<UsageRow>[] = [];
  for (const item of order) {
    if (typeof item === "string") {
      const notes = wanted && !has(item) ? sections.get(item)!.filter((g) => has(displayName(g.path))) : sections.get(item)!;
      if (notes.length === 0) continue;
      const id = `relation:${item}`;
      const open = wanted ? true : !collapsed.has(id);
      rows.push({ id, depth: 0, expanded: open, label: item, data: { kind: "relation", name: item, count: notes.length } });
      if (!open) continue;
      for (const { path, places } of notes) {
        const data: UsageRow = { kind: "note", path, count: places.length, place: places[0] };
        rows.push({ id: `${id}:${path}`, depth: 1, label: displayName(path), data });
      }
      continue;
    }
    const { path, places } = item;
    const name = displayName(path);
    const matching = wanted && !has(name) ? places.filter((p) => has(p.label)) : places;
    if (matching.length === 0) continue;
    const open = wanted ? true : !collapsed.has(path);
    rows.push({ id: path, depth: 0, expanded: open, label: name, data: { kind: "note", path, count: matching.length } });
    if (!open) continue;
    matching.forEach((place, i) => {
      rows.push({ id: `${path}:${place.line}:${place.col}:${i}`, depth: 1, label: place.label, data: { kind: "place", path, place } });
    });
  }
  return rows;
}
