/**
 * The file a context menu is about. Its items act on that one, and not on
 * what would be the target of the same action run from the keyboard: while a
 * menu shows, it has the keyboard, and the note in front is another matter.
 */
let current: string | null = null;

/** The file to act on while an item of a menu runs, or is asked if it can. */
export function menuTarget(): string | null {
  return current;
}

export function withMenuTarget<T>(path: string | undefined, action: () => T): T {
  if (path === undefined) return action();
  const before = current;
  current = path;
  try {
    return action();
  } finally {
    current = before;
  }
}
