import type { Graph } from "../backend/api";

/** What drawing a graph needs to know about it, worked out once per graph. */
export interface GraphShape {
  /** Each node's neighbors, whichever way they link. */
  near: Set<number>[];
  /** Each node's edges, by index, either way. */
  incident: number[][];
  /** Each pair of linked nodes once, for the layout. */
  pairs: [number, number][];
  /** The relations each edge is of, by edge; `undefined` for plain links. */
  names: (string[] | undefined)[];
}

export function graphShape(graph: Graph): GraphShape {
  const near = graph.nodes.map(() => new Set<number>());
  const incident: number[][] = graph.nodes.map(() => []);
  graph.edges.forEach(([a, b], e) => {
    near[a]!.add(b);
    near[b]!.add(a);
    incident[a]!.push(e);
    incident[b]!.push(e);
  });
  const pairs: [number, number][] = [];
  near.forEach((others, a) => others.forEach((b) => b > a && pairs.push([a, b])));
  const names: (string[] | undefined)[] = new Array(graph.edges.length);
  for (const { name, edges } of graph.relations) for (const e of edges) (names[e] ??= []).push(name);
  return { near, incident, pairs, names };
}

/** The edges of one relation, and the nodes they join. */
export function relationFocus(graph: Graph, name: string): { edges: number[]; nodes: Set<number> } | null {
  const relation = graph.relations.find((r) => r.name === name);
  if (!relation) return null;
  const nodes = new Set<number>();
  for (const e of relation.edges) graph.edges[e]!.forEach((n) => nodes.add(n));
  return { edges: relation.edges, nodes };
}

const HUES = [212, 160, 35, 280, 340, 95, 190, 15, 250, 60];

const hsl = (hue: number, dark: boolean) => `hsl(${hue} ${dark ? "60% 64%" : "62% 45%"})`;

/** A tag's color comes from its name, so it is the same in every graph. */
function tagColor(tag: string, dark: boolean): string {
  const top = tag.split("/")[0]!.toLowerCase();
  const hash = [...top].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return hsl(HUES[hash % HUES.length]!, dark);
}

export interface GraphColors {
  /** By node; `null` for one with neither a type nor a tag. */
  nodes: (string | null)[];
  /** The types in the graph, most common first. */
  types: { name: string; count: number; color: string }[];
}

/**
 * Nodes are colored by their type, else by their first tag. Types take the
 * palette in order of how common they are here, so the few a graph has look
 * apart; the first hue is left out, as it is the note in front's.
 */
export function graphColors(graph: Graph, dark: boolean): GraphColors {
  const counts = new Map<string, { name: string; count: number }>();
  for (const { type } of graph.nodes) {
    if (!type) continue;
    const key = type.toLowerCase();
    (counts.get(key) ?? counts.set(key, { name: type, count: 0 }).get(key)!).count++;
  }
  const ranked = [...counts].sort(([, a], [, b]) => b.count - a.count || a.name.localeCompare(b.name));
  const color = new Map(ranked.map(([key], i) => [key, hsl(HUES[(i + 1) % HUES.length]!, dark)]));
  return {
    nodes: graph.nodes.map((n) => (n.type ? color.get(n.type.toLowerCase())! : n.tag ? tagColor(n.tag, dark) : null)),
    types: ranked.map(([key, { name, count }]) => ({ name, count, color: color.get(key)! })),
  };
}

/**
 * An arrow head pointing at `(tx, ty)`, touching a circle of `radius` around
 * it: its tip and two back corners. `null` when the nodes are too close.
 */
export function arrowHead(fx: number, fy: number, tx: number, ty: number, radius: number, size: number): number[] | null {
  const dx = tx - fx;
  const dy = ty - fy;
  const length = Math.hypot(dx, dy);
  if (length <= radius + size) return null;
  const ux = dx / length;
  const uy = dy / length;
  const tipX = tx - ux * radius;
  const tipY = ty - uy * radius;
  const backX = tipX - ux * size;
  const backY = tipY - uy * size;
  const half = size * 0.45;
  return [tipX, tipY, backX - uy * half, backY + ux * half, backX + uy * half, backY - ux * half];
}
