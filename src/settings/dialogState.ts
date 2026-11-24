import { create } from "zustand";

export type SettingsPage = "appearance" | "editor" | "files" | "keymap" | "plugins" | `plugin:${string}`;

export const useSettingsDialog = create<{ open: boolean; page: SettingsPage }>(() => ({ open: false, page: "appearance" }));

export function showSettings(page?: SettingsPage) {
  useSettingsDialog.setState((s) => ({ open: true, page: page ?? s.page }));
}
