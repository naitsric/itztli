import { create } from "zustand";

/** An item of the status bar. Plugins add them. */
export interface StatusItem {
  id: number;
  side: "left" | "right";
  text: string | null;
  title?: string;
  onClick?: () => void;
}

export const useStatusItems = create<{ items: readonly StatusItem[] }>(() => ({ items: [] }));

let next = 1;

export function addStatusItem(item: Omit<StatusItem, "id" | "text">): {
  setText: (text: string | null) => void;
  dispose: () => void;
} {
  const id = next++;
  useStatusItems.setState((s) => ({ items: [...s.items, { ...item, id, text: null }] }));
  return {
    setText: (text) => useStatusItems.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, text } : i)) })),
    dispose: () => useStatusItems.setState((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  };
}
