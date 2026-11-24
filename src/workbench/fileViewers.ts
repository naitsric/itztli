import { create } from "zustand";
import { extensionOf } from "../vault/paths";

/** Shows files of some extensions. Plugins register them. */
export interface FileViewer {
  id: string;
  extensions: string[];
  mount: (element: HTMLElement, path: string) => (() => void) | void;
}

export const useFileViewers = create<{ viewers: readonly FileViewer[] }>(() => ({ viewers: [] }));

export function registerFileViewer(viewer: FileViewer): () => void {
  useFileViewers.setState((s) => ({ viewers: [...s.viewers, viewer] }));
  return () => useFileViewers.setState((s) => ({ viewers: s.viewers.filter((v) => v !== viewer) }));
}

/** The last one registered for an extension. */
export function viewerFor(path: string, viewers: readonly FileViewer[]): FileViewer | undefined {
  const extension = extensionOf(path);
  return viewers.findLast((v) => v.extensions.includes(extension));
}

/** Files the editor opens as plain text. */
const TEXT = new Set(
  "txt text log csv tsv json jsonl yaml yml toml ini xml html css scss js mjs ts tsx jsx py rs go rb java kt swift c h cpp hpp cs php sh bash zsh sql r lua tex bib canvas".split(" "),
);

export function isText(path: string): boolean {
  return TEXT.has(extensionOf(path));
}
