import { create } from "zustand";
import { showToolWindow } from "../workbench/toolWindows";

/** The tag the Tags window is on. */
export const useTagSelection = create<{ tag: string | null; request: number }>(() => ({ tag: null, request: 0 }));

/** Opens the Tags window on a tag. */
export function showTag(tag: string) {
  useTagSelection.setState((s) => ({ tag, request: s.request + 1 }));
  showToolWindow("tags");
}
