import { create } from "zustand";
import { host } from "./backend/host";

export type Appearance = "light" | "dark";

/** A theme a plugin offers: an appearance with some colors changed. */
export interface PluginTheme {
  /** `<plugin id>.<theme id>` */
  id: string;
  name: string;
  appearance: Appearance;
  /** CSS variables without the dashes. */
  colors: Record<string, string>;
}

interface ThemeState {
  /** `system`, `light`, `dark` or a plugin theme's id. */
  preference: string;
  translucent: boolean;
  plugins: PluginTheme[];
  /** What the preference comes to now. */
  appearance: Appearance;
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Also kept outside the settings file, which takes a moment to read: the
 * first frame is already in the right colors.
 */
const EARLY_KEY = "itztli.theme";

function early(): Pick<ThemeState, "preference" | "translucent"> {
  try {
    const stored = JSON.parse(localStorage.getItem(EARLY_KEY) ?? "{}");
    return { preference: stored.preference ?? "system", translucent: stored.translucent ?? true };
  } catch {
    return { preference: "system", translucent: true };
  }
}

function appearanceOf(preference: string, plugins: PluginTheme[]): Appearance {
  if (preference === "light" || preference === "dark") return preference;
  const theme = plugins.find((t) => t.id === preference);
  return theme?.appearance ?? (darkQuery.matches ? "dark" : "light");
}

export const useTheme = create<ThemeState>(() => {
  const { preference, translucent } = early();
  return { preference, translucent, plugins: [], appearance: appearanceOf(preference, []) };
});

export function setTheme(change: Partial<Pick<ThemeState, "preference" | "translucent">>) {
  useTheme.setState((s) => {
    const next = { ...s, ...change };
    return { ...next, appearance: appearanceOf(next.preference, next.plugins) };
  });
}

export function registerTheme(theme: PluginTheme): () => void {
  const update = (plugins: PluginTheme[]) =>
    useTheme.setState((s) => ({ plugins, appearance: appearanceOf(s.preference, plugins) }));
  update([...useTheme.getState().plugins.filter((t) => t.id !== theme.id), theme]);
  return () => update(useTheme.getState().plugins.filter((t) => t !== theme));
}

let applied: string[] = [];

function apply({ preference, translucent, plugins, appearance }: ThemeState) {
  const root = document.documentElement;
  root.dataset.theme = appearance;
  root.dataset.vibrancy = translucent && host.desktop && /Mac/.test(navigator.platform) ? "on" : "off";
  for (const name of applied) root.style.removeProperty(name);
  applied = [];
  const colors = plugins.find((t) => t.id === preference)?.colors ?? {};
  for (const [name, value] of Object.entries(colors)) {
    root.style.setProperty(`--${name}`, value);
    applied.push(`--${name}`);
  }
  try {
    localStorage.setItem(EARLY_KEY, JSON.stringify({ preference, translucent }));
  } catch {
    // Only costs a flash on the next start.
  }
  if (host.desktop) {
    // Keeps the native title bar in step. `null` follows the system.
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(preference === "system" ? null : appearance))
      .catch(() => {});
  }
}

apply(useTheme.getState());
useTheme.subscribe(apply);
darkQuery.addEventListener("change", () => setTheme({}));

/** Reads a design token's current value, for what is drawn on a canvas. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}
