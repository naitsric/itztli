import { useEffect } from "react";
import { tinykeys } from "tinykeys";
import { noteKeyboardRun } from "../menu/nativeMenu";
import { keymapHeld } from "./keymapHold";
import {
  bindingOf,
  executeCommand,
  focusContext,
  pickCommand,
  useCommands,
  type Command,
  type FocusContext,
} from "./registry";

/** Max gap between the two Shift taps of "Shift Shift", as in IntelliJ. */
const DOUBLE_SHIFT_MS = 350;

/**
 * What a key bound to `candidates` does: run one of them, do nothing at
 * all, or go to whoever else handles it.
 *
 * - The command `pickCommand` chooses runs and consumes the key. Without
 *   an enabled one, the key passes untouched.
 * - While a dialog holds the keymap (see keymapHold.ts) nothing runs, and
 *   every key passes: what the dialog has to type in needs them.
 */
export function resolveKey(
  candidates: readonly Command[],
  context: FocusContext | undefined,
  held: boolean,
): { action: "run"; command: Command } | { action: "pass" } {
  if (held) return { action: "pass" };
  const command = pickCommand(candidates, context);
  return command ? { action: "run", command } : { action: "pass" };
}

/**
 * Binds every registered command's keybinding on the window, in the capture
 * phase so it runs before the editors. Rebinds when the registry
 * changes. Unlike tinykeys' default, shortcuts also fire from inputs and
 * editors: all our bindings use a modifier or a function key, so they never
 * collide with typing.
 *
 * Several commands may share a key (see `pickCommand`). The one that runs
 * consumes the key (no default action, no propagation), so e.g. ⌘⏎ never
 * also inserts a newline in the editor; when none is enabled, the key goes
 * to whoever else handles it. Nothing runs while a dialog holds the keymap.
 */
export function useKeymap(onDoubleShift: () => void) {
  const commands = useCommands((s) => s.commands);
  const overrides = useCommands((s) => s.overrides);

  useEffect(() => {
    const byBinding = new Map<string, Command[]>();
    for (const c of Object.values(commands)) {
      const binding = bindingOf(c, overrides);
      if (binding) byBinding.set(binding, [...(byBinding.get(binding) ?? []), c]);
    }
    const bindings = Object.fromEntries(
      [...byBinding].map(([binding, candidates]) => [
        binding,
        (event: KeyboardEvent) => {
          const resolved = resolveKey(candidates, focusContext(), keymapHeld());
          if (resolved.action === "pass") return;
          event.preventDefault();
          event.stopPropagation();
          // A held key repeats edits (moving a line down), not switches.
          if (event.repeat && resolved.command.context !== "editor") return;
          noteKeyboardRun(resolved.command.id);
          executeCommand(resolved.command.id);
        },
      ]),
    );
    return tinykeys(window, bindings, {
      capture: true,
      // Held keys repeat: moving a line down twice is one long press.
      ignore: (event) => event.isComposing,
    });
  }, [commands, overrides]);

  useEffect(() => detectDoubleShift(() => !keymapHeld() && onDoubleShift()), [onDoubleShift]);
}

/** Fires on two bare Shift taps in quick succession, with no other key in between. */
function detectDoubleShift(onDoubleShift: () => void): () => void {
  let lastTap = 0;
  let clean = false;

  const down = (e: KeyboardEvent) => {
    if (e.key === "Shift" && !e.repeat) {
      clean = !(e.metaKey || e.ctrlKey || e.altKey);
    } else {
      clean = false;
      lastTap = 0;
    }
  };
  const up = (e: KeyboardEvent) => {
    if (e.key !== "Shift" || !clean) return;
    const now = performance.now();
    if (now - lastTap < DOUBLE_SHIFT_MS) {
      lastTap = 0;
      onDoubleShift();
    } else {
      lastTap = now;
    }
  };

  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  return () => {
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
  };
}

/** Keys written as tinykeys' codes and shown as what is printed on them. */
const SYMBOLS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  NumpadAdd: "+",
  $mod: "⌘",
  Meta: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "⏎",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Tab: "⇥",
  Space: "Space",
};

const WORDS: Record<string, string> = { $mod: "Ctrl", Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win" };

/** `$mod+Shift+KeyA` → `⇧⌘A`, in macOS modifier order; `Ctrl+Shift+A` elsewhere. */
export function formatKeybinding(binding: string, mac = isMac()): string {
  const order = ["Control", "Alt", "Shift", "$mod", "Meta"];
  const parts = binding.split("+");
  const key = parts.pop()!;
  const modifiers = parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const keyLabel = SYMBOLS[key] ?? key.replace(/^Key/, "").replace(/^Digit/, "");
  if (!mac) return [...modifiers.map((m) => WORDS[m] ?? m), keyLabel].join("+");
  return modifiers.map((m) => SYMBOLS[m] ?? m).join("") + keyLabel;
}

/**
 * The binding a key press stands for, for recording one in the settings.
 * `null` while only modifiers are down, or for a key that would get in the
 * way of typing.
 */
export function bindingFromEvent(event: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"].includes(event.key)) return null;
  const isFunctionKey = /^F\d{1,2}$/.test(event.key);
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !isFunctionKey) return null;
  const mac = isMac();
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("$mod");
  if (mac && event.ctrlKey) parts.push("Control");
  if (!mac && event.metaKey) parts.push("Meta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  return [...parts, isFunctionKey ? event.key : event.code].join("+");
}

export function isMac(): boolean {
  return /Mac|iP(hone|ad|od)/.test(navigator.platform);
}
