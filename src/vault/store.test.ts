import { describe, expect, it } from "vitest";
import type { Entry } from "../backend/api";
import { applyChanges } from "./store";

const entry = (path: string, folder = false): Entry => ({ path, folder, size: 0, modified: 0 });
const vault = (...paths: string[]) => new Map(paths.map((p) => [p.replace(/\/$/, ""), entry(p.replace(/\/$/, ""), p.endsWith("/"))]));

describe("applyChanges", () => {
  it("tells new files from changed ones", () => {
    const entries = vault("a.md");
    const heard = applyChanges(
      entries,
      [{ kind: "put", entry: entry("a.md") }, { kind: "put", entry: entry("b.md") }],
      "disk",
    );
    expect(heard).toEqual([
      { kind: "put", path: "a.md", created: false, origin: "disk" },
      { kind: "put", path: "b.md", created: true, origin: "disk" },
    ]);
  });

  it("removes folders whole, and tells once", () => {
    const entries = vault("f/", "f/a.md", "f/g/", "f/g/b.md", "fx.md");
    const heard = applyChanges(entries, [{ kind: "remove", path: "f" }, { kind: "remove", path: "f/a.md" }], "app");
    expect([...entries.keys()]).toEqual(["fx.md"]);
    expect(heard).toEqual([{ kind: "remove", path: "f" }]);
  });

  it("moves folders with everything inside", () => {
    const entries = vault("f/", "f/a.md", "fx.md");
    applyChanges(entries, [{ kind: "move", from: "f", to: "g/h" }], "app");
    expect([...entries.keys()].sort()).toEqual(["fx.md", "g/h", "g/h/a.md"]);
    expect(entries.get("g/h/a.md")!.path).toBe("g/h/a.md");
  });
});
