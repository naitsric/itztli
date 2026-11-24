import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

/** Lays the graph out, away from the thread that draws and types. */

interface Node extends SimulationNodeDatum {
  index: number;
}

export type ToWorker =
  | { kind: "graph"; count: number; edges: [number, number][]; positions: Float32Array | null }
  | { kind: "drag"; node: number; x: number; y: number }
  | { kind: "drop"; node: number }
  | { kind: "stop" };

export interface FromWorker {
  positions: Float32Array;
  settled: boolean;
}

let nodes: Node[] = [];
let simulation: Simulation<Node, SimulationLinkDatum<Node>> | null = null;

function send(settled: boolean) {
  const positions = new Float32Array(nodes.length * 2);
  nodes.forEach((n, i) => {
    positions[i * 2] = n.x ?? 0;
    positions[i * 2 + 1] = n.y ?? 0;
  });
  (self as unknown as Worker).postMessage({ positions, settled } satisfies FromWorker, [positions.buffer]);
}

self.onmessage = ({ data }: MessageEvent<ToWorker>) => {
  switch (data.kind) {
    case "graph": {
      simulation?.stop();
      const radius = Math.sqrt(data.count) * 12;
      nodes = Array.from({ length: data.count }, (_, index) => {
        const known = data.positions && Number.isFinite(data.positions[index * 2]);
        const angle = index * 2.399963;
        const distance = radius * Math.sqrt((index + 0.5) / data.count);
        return {
          index,
          x: known ? data.positions![index * 2] : Math.cos(angle) * distance,
          y: known ? data.positions![index * 2 + 1] : Math.sin(angle) * distance,
        };
      });
      const links = data.edges.map(([source, target]) => ({ source, target }));
      simulation = forceSimulation<Node>(nodes)
        .force("charge", forceManyBody<Node>().strength(-60).theta(1.1).distanceMax(600))
        .force("link", forceLink<Node, SimulationLinkDatum<Node>>(links).distance(38).strength(0.35))
        .force("x", forceX<Node>(0).strength(0.04))
        .force("y", forceY<Node>(0).strength(0.04))
        // Big graphs settle sooner: their shape shows long before they stop.
        .alphaDecay(data.count > 3000 ? 0.05 : 0.026)
        .on("tick", () => send(false))
        .on("end", () => send(true));
      break;
    }
    case "drag": {
      const node = nodes[data.node];
      if (!node) return;
      node.fx = data.x;
      node.fy = data.y;
      simulation?.alphaTarget(0.25).restart();
      break;
    }
    case "drop": {
      const node = nodes[data.node];
      if (!node) return;
      node.fx = null;
      node.fy = null;
      simulation?.alphaTarget(0);
      break;
    }
    case "stop":
      simulation?.stop();
  }
};
