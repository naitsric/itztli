import { useLayoutEffect } from "react";

/**
 * A modal dialog holds the keymap while it shows. Then no global keybinding
 * runs its command (⌘⌫ doesn't delete a line of the note behind it), the
 * native menu runs nothing, and Shift Shift opens nothing; the dialog's own
 * keys (Tab, Enter, Space, Escape) reach it as usual.
 *
 * Checked where keys are dispatched (see keymap.ts and nativeMenu.ts), not
 * by each command.
 */
const holds = new Set<symbol>();

/** Holds the keymap until the returned function is called. */
export function holdKeymap(): () => void {
  const hold = Symbol("keymap hold");
  holds.add(hold);
  return () => void holds.delete(hold);
}

export function keymapHeld(): boolean {
  return holds.size > 0;
}

/** What last had the keyboard outside any dialog. */
let lastOutside: HTMLElement | null = null;
/** Where it goes when that is gone. */
let fallback: () => void = () => {};

if (typeof document !== "undefined") {
  document.addEventListener("focusin", ({ target }) => {
    if (target instanceof HTMLElement && !target.closest("[role=dialog]")) lastOutside = target;
  });
}

export function setFocusFallback(focus: () => void) {
  fallback = focus;
}

/** Unless something took the keyboard already, it goes back to whoever had it. */
function giveKeyboardBack() {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  // A dialog that opened this one is still there.
  const remaining = [...document.querySelectorAll<HTMLElement>("[role=dialog]")].at(-1);
  // Where it was scrolled to is where it stays.
  if (remaining) remaining.focus({ preventScroll: true });
  else if (lastOutside?.isConnected) lastOutside.focus({ preventScroll: true });
  else fallback();
}

/**
 * Holds the keymap while the calling component is mounted. A dialog opened
 * by a key has no button for the keyboard to go back to, so this sees to it.
 */
export function useKeymapHold() {
  // Before paint, so no key gets through between showing and holding.
  useLayoutEffect(() => {
    const release = holdKeymap();
    return () => {
      release();
      window.setTimeout(giveKeyboardBack);
    };
  }, []);
}
