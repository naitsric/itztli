/** Vault paths: relative to the root, `/`-separated. The root is "". */

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

export function isNote(path: string): boolean {
  return /[^/]\.md$/i.test(path);
}

/** A note's name goes without its extension, any other file's with it. */
export function displayName(path: string): string {
  const name = nameOf(path);
  return isNote(path) ? name.slice(0, -3) : name;
}

export function extensionOf(path: string): string {
  const name = nameOf(path);
  const at = name.lastIndexOf(".");
  return at > 0 ? name.slice(at + 1).toLowerCase() : "";
}

export function isWithin(path: string, folder: string): boolean {
  return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

/** Where a path ends up when `from` moves to `to`. */
export function movedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) && from !== "" ? to + path.slice(from.length) : path;
}

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

export function isImage(path: string): boolean {
  return IMAGES.has(extensionOf(path));
}

/** Names compare in the user's language, numbers by value: `2` before `10`. */
export const compareNames = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/** What is wrong with a name for a file or folder, or `null`. */
export function nameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Type a name";
  if (trimmed.split("/").some((part) => !part.trim())) return "A folder's name is empty";
  if (trimmed.split("/").some((part) => part === "." || part === "..")) return "Names can't be . or ..";
  if (trimmed.split("/").some((part) => part.startsWith("."))) return "Names starting with a dot are reserved";
  if (/[\\:*?"<>|#^[\]]/.test(trimmed)) return 'Names can\'t contain \\ : * ? " < > | # ^ [ ]';
  return null;
}
