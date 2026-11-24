import { create } from "zustand";

export type SearchScope = "all" | "notes" | "files" | "headings" | "text" | "actions";

export const useSearchEverywhere = create<{
  open: boolean;
  scope: SearchScope;
  show: (scope: SearchScope) => void;
  hide: () => void;
}>((set) => ({
  open: false,
  scope: "all",
  show: (scope) => set({ open: true, scope }),
  hide: () => set({ open: false }),
}));
