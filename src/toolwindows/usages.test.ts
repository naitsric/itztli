import { describe, expect, it } from "vitest";
import type { Link, Usages } from "../backend/api";
import { usageGroups, usageRows } from "./usages";

const link = (line: number, context: string, relation: string | null = null): Link & { context: string } => ({
  kind: relation ? "property" : "wiki",
  target: "Ana",
  subpath: null,
  display: null,
  relation,
  line,
  col: 0,
  len: 7,
  context,
});

const usages: Usages[] = [
  { path: "Diary/Today.md", links: [link(4, "- Saw [[Ana]]")] },
  { path: "Meetings/Kickoff.md", links: [link(1, 'author: "[[Ana]]"', "author"), link(8, "Ana said [[Ana]]")] },
  { path: "Meetings/Sync.md", links: [link(2, '  - "[[Ana]]"', "attendees"), link(3, '  - "[[Ana]]"', "attendees")] },
  { path: "Team.md", links: [link(1, 'lead: "[[Ana]]"', "author")] },
];

describe("backlinks", () => {
  it("lists those through a property under its name, and mentions as they were", () => {
    const groups = usageGroups(usages);
    expect(groups.map((g) => [g.relation, g.path, g.places.map((p) => p.line)])).toEqual([
      ["attendees", "Meetings/Sync.md", [2, 3]],
      ["author", "Meetings/Kickoff.md", [1]],
      ["author", "Team.md", [1]],
      [undefined, "Diary/Today.md", [4]],
      [undefined, "Meetings/Kickoff.md", [8]],
    ]);
    expect(groups[3]!.places[0]!.label).toBe("Saw Ana");
  });

  it("shows notes under their relation, opening where the link is", () => {
    const rows = usageRows(usageGroups(usages), new Set(), "");
    expect(rows.map((r) => [r.id, r.depth, r.expanded])).toEqual([
      ["relation:attendees", 0, true],
      ["relation:attendees:Meetings/Sync.md", 1, undefined],
      ["relation:author", 0, true],
      ["relation:author:Meetings/Kickoff.md", 1, undefined],
      ["relation:author:Team.md", 1, undefined],
      ["Diary/Today.md", 0, true],
      ["Diary/Today.md:4:0:0", 1, undefined],
      ["Meetings/Kickoff.md", 0, true],
      ["Meetings/Kickoff.md:8:0:0", 1, undefined],
    ]);
    expect(rows[0]!.data).toEqual({ kind: "relation", name: "attendees", count: 1 });
    expect(rows[1]!.data).toMatchObject({ kind: "note", path: "Meetings/Sync.md", count: 2, place: { line: 2 } });
  });

  it("folds a relation, and finds by its name or a note's", () => {
    const groups = usageGroups(usages);
    expect(usageRows(groups, new Set(["relation:author"]), "").filter((r) => r.depth === 0).map((r) => r.label)).toEqual([
      "attendees",
      "author",
      "Today",
      "Kickoff",
    ]);
    expect(usageRows(groups, new Set(), "auth").map((r) => r.label)).toEqual(["author", "Kickoff", "Team"]);
    expect(usageRows(groups, new Set(), "team").map((r) => r.label)).toEqual(["author", "Team"]);
  });
});
