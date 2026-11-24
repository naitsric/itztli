import { create } from "zustand";

/**
 * Where keyboard focus is, for keys that mean different things in different
 * places (⌘⌫ deletes a line in the editor and a file in the vault tree).
 * Marked in the DOM with `data-focus-context`.
 */
export type FocusContext = "editor" | "vault";

/**
 * Every user-facing action is a registered command, like IntelliJ's
 * AnAction. Registering one makes it available to the keymap, Search
 * Everywhere, the menu bar and the keymap settings with no extra wiring.
 * Plugins' commands are the same thing.
 */
export interface Command {
  /** Stable id, `<area>.<action>`, e.g. `file.newNote`. Keymap overrides key on it. */
  id: string;
  title: string;
  /** Group shown in Search Everywhere, e.g. "Navigate". */
  category: string;
  /** tinykeys syntax, e.g. `$mod+Enter`, `$mod+Shift+KeyA`. */
  keybinding?: string;
  /**
   * Limits the keybinding to when focus is inside this context. Commands may
   * share a binding: see {@link pickCommand}. Search Everywhere and menus
   * ignore it; `enabled` alone decides there.
   */
  context?: FocusContext;
  /** Extra search terms. */
  keywords?: string[];
  /** The plugin that registered it. */
  plugin?: string;
  /** Whether the command can run right now. Disabled commands stay visible but inert. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

interface CommandRegistry {
  commands: Record<string, Command>;
  /** The user's keys by command id; `null` means none. */
  overrides: Record<string, string | null>;
}

export const useCommands = create<CommandRegistry>(() => ({ commands: {}, overrides: {} }));

/** Registers commands and returns a function that unregisters them. */
export function registerCommands(commands: Command[]): () => void {
  useCommands.setState((s) => ({
    commands: { ...s.commands, ...Object.fromEntries(commands.map((c) => [c.id, c])) },
  }));
  return () =>
    useCommands.setState((s) => {
      const next = { ...s.commands };
      for (const c of commands) if (next[c.id] === c) delete next[c.id];
      return { commands: next };
    });
}

/** The key in effect for a command: the user's, or its own. */
export function bindingOf(command: Command, overrides = useCommands.getState().overrides): string | undefined {
  const own = overrides[command.id];
  return own === undefined ? command.keybinding : (own ?? undefined);
}

export function isEnabled(command: Command): boolean {
  try {
    return command.enabled?.() ?? true;
  } catch (e) {
    console.error(`${command.id}: enabled() failed`, e);
    return false;
  }
}

export function focusContext(): FocusContext | undefined {
  const marked = document.activeElement?.closest("[data-focus-context]");
  return (marked?.getAttribute("data-focus-context") as FocusContext | null) ?? undefined;
}

/**
 * Which of the commands sharing a key runs: those bound to the focused
 * context first, then context-free ones. Within each, the app's before
 * plugins' (a plugin can't take a key the app uses), in registration order;
 * the first enabled one wins. A command bound to another context never runs.
 */
export function pickCommand(candidates: readonly Command[], context: FocusContext | undefined): Command | undefined {
  const appFirst = [...candidates.filter((c) => !c.plugin), ...candidates.filter((c) => c.plugin)];
  const contextual = appFirst.filter((c) => c.context !== undefined && c.context === context);
  const global = appFirst.filter((c) => c.context === undefined);
  return [...contextual, ...global].find(isEnabled);
}

/** Told when a command fails, so it can be shown. Set by the notifications. */
let onFailure: (command: Command, error: unknown) => void = (command, e) => console.error(command.id, e);

export function setCommandFailureHandler(handler: typeof onFailure) {
  onFailure = handler;
}

export function executeCommand(id: string): void {
  const command = useCommands.getState().commands[id];
  if (!command || !isEnabled(command)) return;
  void (async () => command.run())().catch((e) => onFailure(command, e));
}
