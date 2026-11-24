import { lazy } from "react";
import { registerToolWindow } from "../workbench/toolWindows";
import { McpWindow } from "../mcp/McpWindow";
import { BacklinksWindow } from "./BacklinksWindow";
import { BookmarksWindow } from "./BookmarksWindow";
import { FindWindow } from "./FindWindow";
import { ProblemsWindow } from "./ProblemsWindow";
import { StructureWindow } from "./StructureWindow";
import { TagsWindow } from "./TagsWindow";
import { VaultWindow } from "./VaultWindow";

// The graph brings its layout along, which nobody needs until they look at it.
const GraphWindow = lazy(() => import("./GraphWindow").then((m) => ({ default: m.GraphWindow })));

export function registerToolWindows(): () => void {
  const define = (id: string, title: string, icon: string, side: "left" | "right" | "bottom", order: number, component: React.ComponentType) =>
    registerToolWindow({ id, title, icon, side, order, component, commandId: `view.toolWindow.${id}` });
  const undo = [
    define("vault", "Vault", "folder", "left", 1, VaultWindow),
    define("bookmarks", "Bookmarks", "bookmark", "left", 2, BookmarksWindow),
    define("tags", "Tags", "tag", "left", 5, TagsWindow),
    define("structure", "Structure", "list-tree", "right", 7, StructureWindow),
    define("backlinks", "Backlinks", "backlinks", "right", 4, BacklinksWindow),
    define("graph", "Graph", "network", "bottom", 8, GraphWindow),
    define("find", "Find", "search", "bottom", 3, FindWindow),
    define("problems", "Problems", "warning", "bottom", 6, ProblemsWindow),
    define("mcp", "MCP", "bot", "bottom", 9, McpWindow),
  ];
  return () => undo.forEach((u) => u());
}
