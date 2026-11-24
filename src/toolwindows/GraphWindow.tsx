import { Maximize, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createMissingNote, run } from "../actions";
import { api, type Graph } from "../backend/api";
import { useDocuments } from "../editor/documents";
import { token, useTheme } from "../theme";
import { inputClass } from "../ui/Modal";
import { cx, IconButton, Segmented } from "../ui/primitives";
import { useElementSize } from "../ui/useElementSize";
import { useVault } from "../vault/store";
import { openPath, useEditorArea } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import type { FromWorker, ToWorker } from "./graphWorker";
import { useQuery } from "./useQuery";

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

const HUES = [212, 160, 35, 280, 340, 95, 190, 15, 250, 60];

function tagColor(tag: string, dark: boolean): string {
  const top = tag.split("/")[0]!.toLowerCase();
  const hash = [...top].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `hsl(${HUES[hash % HUES.length]} ${dark ? "60% 64%" : "62% 45%"})`;
}

export function GraphWindow() {
  const path = useEditorArea((s) => s.activePath);
  const content = useVault((s) => s.content);
  const saved = useDocuments((s) => s.saved);
  const [scope, setScope] = useState<"note" | "vault">("note");
  const [depth, setDepth] = useState(2);
  const [filter, setFilter] = useState("");
  const around = scope === "note" ? path : null;
  const graph = useQuery<Graph>(
    () => (scope === "note" && !path ? Promise.resolve({ nodes: [], edges: [] }) : api.graph({ around: around ?? undefined, depth, missing: scope === "note" })),
    [scope, around, depth, content, saved],
  );

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
        <GraphCanvas graph={graph} active={path} filter={filter} />
      ) : (
        <p className="px-4 py-3 text-[12.5px] text-subtle">{graph && "Open a note to see what it is linked with."}</p>
      )}
    </>
  );
}

function GraphCanvas({ graph, active, filter }: { graph: Graph; active: string | null; filter: string }) {
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

  const degree = useMemo(() => {
    const counts = new Uint16Array(graph.nodes.length);
    for (const [a, b] of graph.edges) {
      counts[a]!++;
      counts[b]!++;
    }
    return counts;
  }, [graph]);
  const near = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const [a, b] of graph.edges) {
      (map.get(a) ?? map.set(a, new Set()).get(a)!).add(b);
      (map.get(b) ?? map.set(b, new Set()).get(b)!).add(a);
    }
    return map;
  }, [graph]);
  const colors = useMemo(() => {
    const dark = theme.appearance === "dark";
    return graph.nodes.map((n) => (n.tag ? tagColor(n.tag, dark) : null));
  }, [graph, theme]);

  const radius = (i: number) => 3.2 + Math.min(9, Math.sqrt(degree[i]!) * 1.35);

  const latest = useRef({ graph, active, filter, near, colors, width, height });
  latest.current = { graph, active, filter, near, colors, width, height };

  const draw = () => {
    frame.current = 0;
    const context = canvas.current?.getContext("2d");
    const { graph: g, active: current, filter: wanted, near: neighbors, colors: hues, width: w, height: h } = latest.current;
    const at = positions.current;
    if (!context || at.length !== g.nodes.length * 2 || w === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const { x, y, zoom } = camera.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, w, h);
    context.setTransform(ratio * zoom, 0, 0, ratio * zoom, ratio * (w / 2 + x), ratio * (h / 2 + y));

    const focus = hovered.current;
    const lit = focus === null ? null : (neighbors.get(focus) ?? new Set<number>());
    const query = wanted.trim().toLowerCase();
    const matches = (i: number) => !query || g.nodes[i]!.name.toLowerCase().includes(query);
    const faded = (i: number) => (lit !== null && i !== focus && !lit.has(i)) || !matches(i);

    const edgeColor = token("border-strong");
    const accent = token("accent");
    context.lineWidth = 1 / zoom;
    context.strokeStyle = edgeColor;
    context.globalAlpha = lit || query ? 0.25 : 0.75;
    context.beginPath();
    for (const [a, b] of g.edges) {
      context.moveTo(at[a * 2]!, at[a * 2 + 1]!);
      context.lineTo(at[b * 2]!, at[b * 2 + 1]!);
    }
    context.stroke();
    if (focus !== null) {
      context.globalAlpha = 0.9;
      context.strokeStyle = accent;
      context.beginPath();
      for (const n of lit!) {
        context.moveTo(at[focus * 2]!, at[focus * 2 + 1]!);
        context.lineTo(at[n * 2]!, at[n * 2 + 1]!);
      }
      context.stroke();
    }

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
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillStyle = textColor;
    const size = 11.5 / zoom;
    context.font = `${size}px ${token("font-ui")}`;
    const few = g.nodes.length <= 60;
    g.nodes.forEach((node, i) => {
      const important = i === focus || lit?.has(i) || node.id === current || (!!query && matches(i));
      const visible = important || few || zoom > 1.5 || (zoom > 0.7 && degree[i]! > 6);
      if (!visible || (faded(i) && !important)) return;
      const px = at[i * 2]! * zoom + w / 2 + x;
      const py = at[i * 2 + 1]! * zoom + h / 2 + y;
      if (px < -60 || py < -20 || px > w + 60 || py > h + 20) return;
      context.globalAlpha = important ? 1 : Math.min(1, Math.max(0.35, zoom - 0.35));
      context.fillText(node.name.length > 32 ? `${node.name.slice(0, 31)}…` : node.name, at[i * 2]!, at[i * 2 + 1]! + radius(i) + 3 / zoom);
    });
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
    const message: ToWorker = { kind: "graph", count: graph.nodes.length, edges: graph.edges, positions: any ? known : null };
    worker.current?.postMessage(message);
  }, [graph]);

  useEffect(() => {
    if (!fitted.current) fitRef.current();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, theme, active, filter]);

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
    </div>
  );
}
