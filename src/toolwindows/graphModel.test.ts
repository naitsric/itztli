import { describe, expect, it } from "vitest";
import type { Graph } from "../backend/api";
import { arrowHead, graphColors, graphShape, relationFocus } from "./graphModel";

const node = (name: string, type: string | null = null, tag: string | null = null) => ({ id: `${name}.md`, name, missing: false, type, tag });

const graph: Graph = {
  nodes: [node("ana", "person", "team"), node("luis", null, "team/core"), node("sync", "meeting"), node("x", "Person")],
  edges: [
    [0, 1],
    [1, 0],
    [2, 0],
    [2, 1],
    [3, 0],
  ],
  relations: [
    { name: "attendees", edges: [2, 3] },
    { name: "author", edges: [2] },
  ],
};

describe("the graph", () => {
  it("knows neighbors either way, and lays each pair out once", () => {
    const shape = graphShape(graph);
    expect(shape.near.map((n) => [...n].sort())).toEqual([[1, 2, 3], [0, 2], [0, 1], [0]]);
    expect(shape.incident[0]).toEqual([0, 1, 2, 4]);
    expect(shape.pairs).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
    ]);
    expect(shape.names).toEqual([undefined, undefined, ["attendees", "author"], ["attendees"], undefined]);
  });

  it("highlights a relation's edges and the notes they join", () => {
    expect(relationFocus(graph, "author")).toEqual({ edges: [2], nodes: new Set([2, 0]) });
    expect(relationFocus(graph, "gone")).toBeNull();
  });

  it("colors types apart, most common first, and the rest by their first tag", () => {
    const { nodes, types } = graphColors(graph, false);
    expect(types.map(({ name, count }) => [name, count])).toEqual([
      ["person", 2],
      ["meeting", 1],
    ]);
    expect(new Set(types.map((t) => t.color)).size).toBe(2);
    expect(nodes).toEqual([types[0]!.color, nodes[1], types[1]!.color, types[0]!.color]);
    const tagged = graphColors({ ...graph, nodes: [node("a", null, "team/core"), node("b", null, "Team")] }, false);
    expect(tagged.nodes[0]).toBe(tagged.nodes[1]);
    expect(tagged.types).toEqual([]);
  });

  it("points arrows at the edge of the node they lead to", () => {
    const [tipX, tipY, ...back] = arrowHead(0, 0, 10, 0, 2, 3)!;
    expect([tipX, tipY]).toEqual([8, 0]);
    expect(back.map((v) => Math.round(v * 100) / 100)).toEqual([5, 1.35, 5, -1.35]);
    expect(arrowHead(0, 0, 4, 0, 2, 3)).toBeNull();
  });
});
