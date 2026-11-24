import { create } from "zustand";
import { showToolWindow } from "../workbench/toolWindows";

/** A path the Vault window has been asked to show. */
export const useVaultReveal = create<{ path: string | null; request: number }>(() => ({ path: null, request: 0 }));

export function revealInVault(path: string, focus = true) {
  useVaultReveal.setState((s) => ({ path, request: s.request + 1 }));
  showToolWindow("vault", focus);
}

/** What is selected in the Vault window, for the commands that act on it. */
export const useVaultSelection = create<{ path: string | null }>(() => ({ path: null }));
