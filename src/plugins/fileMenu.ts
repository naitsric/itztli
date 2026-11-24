import { create } from "zustand";
import type { Entry } from "../backend/api";

/** What plugins add to the menu of files and folders. */
export interface FileMenuItem {
  key: string;
  title: string;
  when?: (entry: Entry) => boolean;
  run: (entry: Entry) => void;
}

export const useFileMenu = create<{ items: readonly FileMenuItem[] }>(() => ({ items: [] }));

export function addFileMenuItem(item: FileMenuItem): () => void {
  useFileMenu.setState((s) => ({ items: [...s.items, item] }));
  return () => useFileMenu.setState((s) => ({ items: s.items.filter((i) => i !== item) }));
}
