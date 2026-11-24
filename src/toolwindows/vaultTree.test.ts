import { describe, expect, it } from "vitest";
import { filteredRows, groupByFolder, treeRows } from "./vaultTree";

const entries = ["b.md", "a10.md", "a2.md", "Z/", "Z/x.md", "Z/deep/", "Z/deep/y.md", "img.png"].map((p) => ({
  path: p.replace(/\/$/, ""),
  folder: p.endsWith("/"),
  size: 0,
  modified: 0,
}));

describe("the vault tree", () => {
  it("puts folders first and sorts names as people do", () => {
    const rows = treeRows(groupByFolder(entries, true), new Set());
    expect(rows.map((r) => r.id)).toEqual(["Z", "a2.md", "a10.md", "b.md", "img.png"]);
  });

  it("shows what is inside open folders", () => {
    const rows = treeRows(groupByFolder(entries, false), new Set(["Z"]));
    expect(rows.map((r) => [r.id, r.depth, r.expanded])).toEqual([
      ["Z", 0, true],
      ["Z/deep", 1, false],
      ["Z/x.md", 1, undefined],
      ["a2.md", 0, undefined],
      ["a10.md", 0, undefined],
      ["b.md", 0, undefined],
    ]);
  });

  it("filters, keeping the way to what matches", () => {
    const rows = filteredRows(groupByFolder(entries, true), "Y");
    expect(rows.map((r) => r.id)).toEqual(["Z", "Z/deep", "Z/deep/y.md"]);
    expect(filteredRows(groupByFolder(entries, true), "zzz")).toEqual([]);
  });
});
