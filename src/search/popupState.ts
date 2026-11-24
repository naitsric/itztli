import { create } from "zustand";

/** The small palettes: which one shows. */
export type Popup = "recentFiles" | "structure" | "contextActions" | "goToLine" | "findInFiles" | null;

export const usePopup = create<{ popup: Popup }>(() => ({ popup: null }));

export function showPopup(popup: Popup) {
  usePopup.setState({ popup });
}
