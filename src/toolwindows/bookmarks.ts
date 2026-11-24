import { create } from "zustand";
import { api, onEvent } from "../backend/api";
import { isWithin, movedPath } from "../vault/paths";
import { onFileChange, useVault } from "../vault/store";
import { notifyError } from "../ui/notifications";

/** Bookmarks: notes, or lines of them. Kept in the vault, so they travel with it. */
export interface Bookmark {
  path: string;
  /** Zero-based; absent for the whole note. */
  line?: number;
  /** What the line said, to find it again when it moves. */
  text?: string;
}

export const useBookmarks = create<{ bookmarks: Bookmark[] }>(() => ({ bookmarks: [] }));

export async function loadBookmarks() {
  const saved = await api.configGet<{ bookmarks?: unknown }>("bookmarks").catch(() => null);
  const list = Array.isArray(saved?.bookmarks) ? saved.bookmarks : [];
  useBookmarks.setState({
    bookmarks: list.filter((b): b is Bookmark => typeof b === "object" && b !== null && typeof (b as Bookmark).path === "string"),
  });
}

function save(bookmarks: Bookmark[]) {
  useBookmarks.setState({ bookmarks });
  if (!useVault.getState().info) return;
  void api.configSet("bookmarks", { bookmarks }).catch((e) => notifyError(e, "Bookmarks are not saved"));
}

/** Adds a bookmark, or takes it off. */
export function toggleBookmark(bookmark: Bookmark): boolean {
  const { bookmarks } = useBookmarks.getState();
  const others = bookmarks.filter((b) => b.path !== bookmark.path || b.line !== bookmark.line);
  const added = others.length === bookmarks.length;
  save(added ? [...bookmarks, bookmark] : others);
  return added;
}

export function removeBookmark(bookmark: Bookmark) {
  save(useBookmarks.getState().bookmarks.filter((b) => b !== bookmark));
}

onFileChange((change) => {
  const { bookmarks } = useBookmarks.getState();
  if (change.kind === "move" && bookmarks.some((b) => isWithin(b.path, change.from))) {
    save(bookmarks.map((b) => ({ ...b, path: movedPath(b.path, change.from, change.to) })));
  } else if (change.kind === "remove" && bookmarks.some((b) => isWithin(b.path, change.path))) {
    save(bookmarks.filter((b) => !isWithin(b.path, change.path)));
  }
});

/** Follows the file when a sync client brings another one. */
export function listenToBookmarks(): () => void {
  return onEvent("config-changed", () => void loadBookmarks());
}
