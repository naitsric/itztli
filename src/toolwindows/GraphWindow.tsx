import { Maximize, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createMissingNote, run } from "../actions";
import { api, type Graph } from "../backend/api";
import { useDocuments } from "../editor/documents";
import { token, useTheme } from "../theme";
import { inputClass } from "../ui/Modal";
import { cx, FilterSelect, IconButton, Segmented } from "../ui/primitives";
import { useElementSize } from "../ui/useElementSize";
import { useVault } from "../vault/store";
import { openPath, useEditorArea } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { arrowHead, graphColors, graphShape, relationFocus } from "./graphModel";
import type { FromWorker, ToWorker } from "./graphWorker";
import { useQuery } from "./useQuery";

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export function GraphWindow() {
  const path = useEditorArea((s) => s.activePath);
  const content = useVault((s) => s.content);
  const saved = useDocuments((s) => s.saved);
  const [scope, setScope] = useState<"note" | "vault">("note");
  const [depth, setDepth] = useState(2);
  const [filter, setFilter] = useState("");
  const [relation, setRelation] = useState<string | null>(null);
  const around = scope === "note" ? path : null;
  const graph = useQuery<Graph>(
    () =>
      scope === "note" && !path
        ? Promise.resolve({ nodes: [], edges: [], relations: [] })
        : api.graph({ around: around ?? undefined, depth, missing: scope === "note" }),
    [scope, around, depth, content, saved],
  );
  const relations = graph?.relations ?? [];
  // Kept for when it is there again, as around another note.
  const shown = relations.some((r) => r.name === relation) ? relation : null;

  return (
    <>
      <ToolWindowHeader title="Graph" icon="network" onHide={() => hideToolWindow("graph")}>
        <div className="mr-1 flex items-center gap-2">
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-1.5 size-3 text-subtle" />
            <input
              aria-label="Highlight notes"
              placeholder="Highlight"
              className={cx(inputClass, "h-6 w-28 pl-6 text-[11.5px]")}
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          {relations.length > 0 && (
            <FilterSelect
              label="Relation"
              all="All links"
              value={shown}
              options={relations.map((r) => ({ value: r.name, label: r.name }))}
              onChange={setRelation}
            />
          )}
          {scope === "note" && (
            <Segmented
              label="Depth"
              value={String(depth)}
              options={["1", "2", "3"].map((value) => ({ value, label: value, title: `${value} links away` }))}
              onChange={(v) => setDepth(Number(v))}
            />
          )}
          <Segmented
            label="What"
            value={scope}
            options={[
              { value: "note", label: "Note" },
              { value: "vault", label: "Vault" },
            ]}
            onChange={setScope}
          />
        </div>
      </ToolWindowHeader>
      {graph && graph.nodes.length > 0 ? (
        <GraphCanvas graph={graph} active={path} filter={filter} relation={shown} />
      ) : (
        <p className="px-4 py-3 text-[12.5px] text-subtle">{graph && "Open a note to see what it is linked with."}</p>
      )}
    </>
  );
}

/** Arrow heads are drawn from this zoom in, and always on what is highlighted. */
const ARROWS_FROM_ZOOM = 0.6;

function GraphCanvas({ graph, active, filter, relation }: { graph: Graph; active: string | null; filter: string; relation: string | null }) {
  const { ref: sizeRef, width, height } = useElementSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | null>(null);
  const positions = useRef<Float32Array>(new Float32Array());
  const places = useRef(new Map<string, [number, number]>());
  const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const fitted = useRef(false);
  const hovered = useRef<number | null>(null);
  const frame = useRef(0);
  const theme = useTheme();

  const shape = useMemo(() => graphShape(graph), [graph]);
  const chosen = useMemo(() => (relation ? relationFocus(graph, relation) : null), [graph, relation]);
  const dark = theme.appearance === "dark";
  const { nodes: colors, types } = useMemo(() => graphColors(graph, dark), [graph, dark]);

  const latest = useRef({ graph, active, filter, shape, chosen, colors, width, height });
  latest.current = { graph, active, filter, shape, chosen, colors, width, height };

  // The layout's ticks draw with the first render's functions: what they use is read from `latest`.
  const radius = (i: number) => 3.2 + Math.min(9, Math.sqrt(latest.current.shape.near[i]?.size ?? 0) * 1.35);

  const draw = () => {
    frame.current = 0;
    const context = canvas.current?.getContext("2d");
    const { graph: g, active: current, filter: wanted, shape: s, chosen: only, colors: hues, width: w, height: h } = latest.current;
    const at = positions.current;
    if (!context || at.length !== g.nodes.length * 2 || w === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const { x, y, zoom } = camera.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, w, h);
    context.setTransform(ratio * zoom, 0, 0, ratio * zoom, ratio * (w / 2 + x), ratio * (h / 2 + y));

    const focus = hovered.current;
    const lit = focus === null ? null : s.near[focus]!;
    const query = wanted.trim().toLowerCase();
    const matches = (i: number) => !query || g.nodes[i]!.name.toLowerCase().includes(query);
    const faded = (i: number) =>
      i !== focus && ((lit !== null && !lit.has(i)) || !matches(i) || (only !== null && !only.nodes.has(i)));
    // What is on screen, in the graph's coordinates, with room for a name.
    const left = (-w / 2 - x) / zoom - 60 / zoom;
    const right = (w / 2 - x) / zoom + 60 / zoom;
    const top = (-h / 2 - y) / zoom - 20 / zoom;
    const bottom = (h / 2 - y) / zoom + 20 / zoom;
    const onScreen = (i: number) => at[i * 2]! >= left && at[i * 2]! <= right && at[i * 2 + 1]! >= top && at[i * 2 + 1]! <= bottom;

    /** Some edges (all of them for `null`), and the arrow heads saying which way they go. */
    const edges = (which: readonly number[] | null, arrows: boolean) => {
      const count = which ? which.length : g.edges.length;
      context.beginPath();
      for (let k = 0; k < count; k++) {
        const [a, b] = g.edges[which ? which[k]! : k]!;
        context.moveTo(at[a * 2]!, at[a * 2 + 1]!);
        context.lineTo(at[b * 2]!, at[b * 2 + 1]!);
      }
      context.stroke();
      if (!arrows) return;
      context.beginPath();
      for (let k = 0; k < count; k++) {
        const [a, b] = g.edges[which ? which[k]! : k]!;
        if (!onScreen(b)) continue;
        const head = arrowHead(at[a * 2]!, at[a * 2 + 1]!, at[b * 2]!, at[b * 2 + 1]!, radius(b) + 1 / zoom, 6 / zoom);
        if (!head) continue;
        context.moveTo(head[0]!, head[1]!);
        context.lineTo(head[2]!, head[3]!);
        context.lineTo(head[4]!, head[5]!);
        context.closePath();
      }
      context.fill();
    };

    const edgeColor = token("border-strong");
    const accent = token("accent");
    context.lineWidth = 1 / zoom;
    context.strokeStyle = context.fillStyle = edgeColor;
    context.globalAlpha = only ? 0.15 : lit || query ? 0.25 : 0.75;
    edges(null, zoom >= ARROWS_FROM_ZOOM);
    context.globalAlpha = 0.9;
    context.strokeStyle = context.fillStyle = accent;
    if (only) edges(only.edges, true);
    if (focus !== null) edges(s.incident[focus]!, true);

    const plain = token("fg-muted");
    const missing = token("fg-subtle");
    g.nodes.forEach((node, i) => {
      context.globalAlpha = faded(i) ? 0.15 : 1;
      context.beginPath();
      context.arc(at[i * 2]!, at[i * 2 + 1]!, radius(i), 0, Math.PI * 2);
      if (node.missing) {
        context.strokeStyle = missing;
        context.lineWidth = 1.3 / zoom;
        context.stroke();
      } else {
        context.fillStyle = node.id === current ? accent : (hues[i] ?? plain);
        context.fill();
      }
    });

    // Names of what matters at this distance; all of them up close.
    const textColor = token("fg");
    const font = token("font-ui");
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = textColor;
    const size = 11.5 / zoom;
    context.font = `${size}px ${font}`;
    const few = g.nodes.length <= 60;
    g.nodes.forEach((node, i) => {
      const important = i === focus || lit?.has(i) || node.id === current || (!!query && matches(i)) || !!only?.nodes.has(i);
      const visible = important || few || zoom > 1.5 || (zoom > 0.7 && s.near[i]!.size > 6);
      if (!visible || (faded(i) && !important) || !onScreen(i)) return;
      context.globalAlpha = important ? 1 : Math.min(1, Math.max(0.35, zoom - 0.35));
      context.fillText(node.name.length > 32 ? `${node.name.slice(0, 31)}…` : node.name, at[i * 2]!, at[i * 2 + 1]! + radius(i) + 3 / zoom);
    });

    // What the hovered note's links are, where they say.
    if (focus !== null) {
      const said = new Map<number, Set<string>>();
      for (const e of s.incident[focus]!) {
        if (!s.names[e]) continue;
        const [a, b] = g.edges[e]!;
        const other = a === focus ? b : a;
        const names = said.get(other) ?? said.set(other, new Set()).get(other)!;
        s.names[e].forEach((name) => names.add(name));
      }
      context.globalAlpha = 1;
      context.textBaseline = "middle";
      context.font = `${10.5 / zoom}px ${font}`;
      context.lineWidth = 3 / zoom;
      context.lineJoin = "round";
      context.strokeStyle = token("bg-panel");
      context.fillStyle = plain;
      for (const [other, names] of said) {
        const [ax, ay, bx, by] = [at[focus * 2]!, at[focus * 2 + 1]!, at[other * 2]!, at[other * 2 + 1]!];
        const text = [...names].join(", ");
        // Only on an edge long enough to hold it: zoom in to read the rest.
        const room = Math.hypot(bx - ax, by - ay) - radius(focus) - radius(other) - 6 / zoom;
        if (context.measureText(text).width > room) continue;
        context.strokeText(text, (ax + bx) / 2, (ay + by) / 2);
        context.fillText(text, (ax + bx) / 2, (ay + by) / 2);
      }
    }
    context.globalAlpha = 1;
  };

  const redraw = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  const fit = () => {
    const at = positions.current;
    if (at.length === 0 || width === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < at.length; i += 2) {
      minX = Math.min(minX, at[i]!);
      maxX = Math.max(maxX, at[i]!);
      minY = Math.min(minY, at[i + 1]!);
      maxY = Math.max(maxY, at[i + 1]!);
    }
    const zoom = Math.min(2, Math.max(0.08, 0.85 * Math.min(width / (maxX - minX + 80), height / (maxY - minY + 80))));
    camera.current = { zoom, x: (-(minX + maxX) / 2) * zoom, y: (-(minY + maxY) / 2) * zoom };
    redraw();
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;

  useEffect(() => {
    const thread = new Worker(new URL("./graphWorker.ts", import.meta.url), { type: "module" });
    worker.current = thread;
    thread.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      positions.current = data.positions;
      latest.current.graph.nodes.forEach((n, i) => places.current.set(n.id, [data.positions[i * 2]!, data.positions[i * 2 + 1]!]));
      // Follows the layout until someone moves the camera.
      if (!fitted.current) fitRef.current();
      redraw();
    };
    return () => {
      thread.terminate();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // What was there stays where it was.
    const known = new Float32Array(graph.nodes.length * 2).fill(NaN);
    let any = false;
    graph.nodes.forEach((n, i) => {
      const place = places.current.get(n.id);
      if (!place) return;
      any = true;
      known[i * 2] = place[0];
      known[i * 2 + 1] = place[1];
    });
    hovered.current = null;
    fitted.current = false;
    const message: ToWorker = { kind: "graph", count: graph.nodes.length, edges: shape.pairs, positions: any ? known : null };
    worker.current?.postMessage(message);
  }, [graph, shape]);

  useEffect(() => {
    if (!fitted.current) fitRef.current();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, theme, active, filter, chosen]);

  const toGraph = (clientX: number, clientY: number): [number, number] => {
    const box = canvas.current!.getBoundingClientRect();
    const { x, y, zoom } = camera.current;
    return [(clientX - box.left - width / 2 - x) / zoom, (clientY - box.top - height / 2 - y) / zoom];
  };
  const nodeAt = (clientX: number, clientY: number): number | null => {
    const [gx, gy] = toGraph(clientX, clientY);
    const at = positions.current;
    let best: number | null = null;
    let bestDistance = Infinity;
    for (let i = 0; i < graph.nodes.length; i++) {
      const distance = Math.hypot(at[i * 2]! - gx, at[i * 2 + 1]! - gy) - radius(i);
      if (distance < Math.min(bestDistance, 6 / camera.current.zoom)) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  };

  const drag = useRef<{ node: number | null; x: number; y: number; moved: boolean } | null>(null);

  return (
    <div ref={sizeRef} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas
        ref={canvas}
        width={Math.round(width * (window.devicePixelRatio || 1))}
        height={Math.round(height * (window.devicePixelRatio || 1))}
        style={{ width, height }}
        role="img"
        aria-label={`Graph of ${graph.nodes.length} notes and ${graph.edges.length} links`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { node: nodeAt(e.clientX, e.clientY), x: e.clientX, y: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) {
            const node = nodeAt(e.clientX, e.clientY);
            if (node !== hovered.current) {
              hovered.current = node;
              e.currentTarget.style.cursor = node === null ? "" : "pointer";
              redraw();
            }
            return;
          }
          if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
          d.moved = true;
          fitted.current = true;
          if (d.node !== null) {
            const [x, y] = toGraph(e.clientX, e.clientY);
            worker.current?.postMessage({ kind: "drag", node: d.node, x, y } satisfies ToWorker);
          } else {
            camera.current.x += e.clientX - d.x;
            camera.current.y += e.clientY - d.y;
            d.x = e.clientX;
            d.y = e.clientY;
            redraw();
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.node !== null && d.moved) worker.current?.postMessage({ kind: "drop", node: d.node } satisfies ToWorker);
          if (d.node === null || d.moved) return;
          const node = graph.nodes[d.node]!;
          if (!node.missing) openPath(node.id, { split: e.metaKey });
          else if (active) run(createMissingNote(active, node.id));
        }}
        onPointerLeave={() => {
          hovered.current = null;
          redraw();
        }}
        onWheel={(e) => {
          fitted.current = true;
          const box = e.currentTarget.getBoundingClientRect();
          const { x, y, zoom } = camera.current;
          // Pinching arrives as a wheel with Ctrl; scrolling pans, as elsewhere.
          if (!e.ctrlKey && !e.metaKey && e.deltaMode === 0 && Math.abs(e.deltaX) + Math.abs(e.deltaY) < 60 && e.deltaX !== 0) {
            camera.current = { zoom, x: x - e.deltaX, y: y - e.deltaY };
          } else {
            const next = Math.min(6, Math.max(0.05, zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022))));
            const px = e.clientX - box.left - width / 2;
            const py = e.clientY - box.top - height / 2;
            camera.current = { zoom: next, x: px - ((px - x) / zoom) * next, y: py - ((py - y) / zoom) * next };
          }
          redraw();
        }}
      />
      <IconButton
        label="Fit"
        className="absolute right-2 bottom-2 bg-elevated"
        onClick={() => {
          fitted.current = false;
          fit();
        }}
      >
        <Maximize className="size-3.5" />
      </IconButton>
      {types.length > 0 && (
        <ul aria-label="Types" className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-panel/85 px-2 py-1 text-[11px] text-muted">
          {types.slice(0, 8).map(({ name, count, color }) => (
            <li key={name} className="flex h-4 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
              {name}
              <span className="text-subtle tabular-nums">{count}</span>
            </li>
          ))}
          {types.length > 8 && <li className="h-4 text-subtle">{types.length - 8} more</li>}
        </ul>
      )}
    </div>
  );
}
