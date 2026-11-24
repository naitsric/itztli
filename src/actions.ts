import { api, isCommandError } from "./backend/api";
import { saveAll } from "./editor/documents";
import type { LinkRef } from "./editor/links";
import { confirm, input, move } from "./dialogs/ask";
import { notify, notifyError } from "./ui/notifications";
import { displayName, isNote, joinPath, nameOf, nameProblem, parentOf } from "./vault/paths";
import { entryAt, useVault } from "./vault/store";
import { settings } from "./settings/store";
import { openPath, rememberPlace, useEditorArea, type OpenOptions } from "./workbench/editorArea";

/** User-level actions shared by commands, menus, the editor and plugins. */

/** Where new notes go: the configured folder, or next to the note in front. */
export function newNoteFolder(): string {
  const { newNoteLocation, newNoteFolder } = settings().files;
  if (newNoteLocation === "folder") return newNoteFolder;
  if (newNoteLocation === "root") return "";
  return parentOf(useEditorArea.getState().activePath ?? "");
}

export async function newNote(folder = newNoteFolder()): Promise<void> {
  const name = await input({
    title: folder ? `New Note in ${folder}` : "New Note",
    placeholder: "Name, or folder/name",
    validate: (value) => noteNameProblem(folder, value),
    optional: true,
  });
  if (name === null) return;
  const path = name.trim()
    ? await createNote(joinPath(folder, withExtension(name.trim())))
    : await api.noteCreateFree(folder, "Untitled.md");
  openPath(path);
}

function withExtension(name: string): string {
  return isNote(name) ? name : `${name}.md`;
}

function noteNameProblem(folder: string, value: string): string | null {
  if (!value.trim()) return null;
  const problem = nameProblem(value);
  if (problem) return problem;
  return entryAt(joinPath(folder, withExtension(value.trim()))) ? "There is already a note with this name" : null;
}

/** Creates a note and returns its path, even if it was already there. */
export async function createNote(path: string, text = ""): Promise<string> {
  try {
    await api.noteCreate(path, text);
  } catch (e) {
    if (!isCommandError(e) || e.code !== "exists") throw e;
  }
  return path;
}

export async function newFolder(parent: string): Promise<void> {
  const name = await input({
    title: parent ? `New Folder in ${parent}` : "New Folder",
    placeholder: "Name",
    validate: (value) => nameProblem(value) ?? (entryAt(joinPath(parent, value.trim())) ? "It already exists" : null),
  });
  if (name !== null) await api.folderCreate(joinPath(parent, name.trim()));
}

/** Where a note nobody has written yet would go, as a link names it. */
function pathForMissing(source: string, target: string): string {
  const name = withExtension(target.replace(/^\/+/, ""));
  if (target.includes("/")) return name;
  const { newNoteLocation, newNoteFolder: folder } = settings().files;
  if (newNoteLocation === "folder") return joinPath(folder, name);
  return newNoteLocation === "root" ? name : joinPath(parentOf(source), name);
}

/** Goes where a link leads; a note that doesn't exist yet is created. */
export async function openLink(
  source: string,
  link: Pick<LinkRef, "target" | "subpath" | "relative">,
  options: OpenOptions & { create?: boolean } = {},
): Promise<void> {
  const { create = true, ...open } = options;
  const path = await api.linkResolve(source, link.target, link.relative);
  if (path) {
    if (path === source) rememberPlace();
    openPath(path, { ...open, subpath: link.subpath });
    return;
  }
  if (!create || !link.target) return;
  const problem = nameProblem(link.target.replace(/^(\.\.?\/|\/)+/, ""));
  if (problem) return notify(`“${link.target}” can't be a note: ${problem.toLowerCase()}`, { kind: "warning" });
  openPath(await createNote(pathForMissing(source, link.target)), open);
}

export async function createMissingNote(source: string, target: string): Promise<void> {
  await createNote(pathForMissing(source, target));
}

/** Renames or moves, rewriting every link that leads there. */
export async function moveEntry(from: string, to: string): Promise<boolean> {
  if (from === to) return true;
  // The backend rewrites what is on disk.
  await saveAll();
  const { relinked, failed } = await api.entryMove(from, to);
  if (failed.length > 0) {
    const names = failed.map(([path, why]) => `${displayName(path)} (${why})`).join(", ");
    notify(`Moved, but some links could not be updated: ${names}`, { kind: "error" });
  } else if (relinked.length > 0) {
    const links = relinked.reduce((n, r) => n + r.links, 0);
    notify(`Updated ${plural(links, "link")} in ${plural(relinked.length, "note")}`);
  }
  return true;
}

export async function renameEntry(path: string): Promise<void> {
  const entry = entryAt(path);
  if (!entry) return;
  const note = !entry.folder && isNote(path);
  const parent = parentOf(path);
  const toPath = (value: string) => joinPath(parent, note ? withExtension(value.trim()) : value.trim());
  const name = await input({
    title: `Rename ${entry.folder ? "Folder" : note ? "Note" : "File"}`,
    value: displayName(path),
    action: "Rename",
    validate(value) {
      if (value.includes("/")) return "Use Move to change its folder";
      const problem = nameProblem(value);
      if (problem) return problem;
      const to = toPath(value);
      return to.toLowerCase() !== path.toLowerCase() && entryAt(to) ? "It already exists" : null;
    },
    async describe(value) {
      if (nameProblem(value) || toPath(value) === path) return null;
      return describeRelinks(await api.entryMovePreview(path, toPath(value)));
    },
  });
  if (name !== null) await moveEntry(path, toPath(name));
}

function describeRelinks(relinked: { path: string; links: number }[]): string {
  if (relinked.length === 0) return "No links to update";
  const links = relinked.reduce((n, r) => n + r.links, 0);
  return `Updates ${plural(links, "link")} in ${plural(relinked.length, "note")}`;
}

/** Asks for a folder and moves there. */
export async function moveToFolder(path: string): Promise<void> {
  const folders = [...useVault.getState().entries.values()]
    .filter((e) => e.folder && e.path !== parentOf(path) && !`${e.path}/`.startsWith(`${path}/`))
    .map((e) => ({ title: e.path, value: e.path }));
  if (parentOf(path)) folders.unshift({ title: "/", value: "" });
  const to = await move({ title: `Move “${displayName(path)}” to`, folders });
  if (to === null) return;
  if (to.create) await api.folderCreate(to.folder);
  await moveEntry(path, joinPath(to.folder, nameOf(path)));
}

export async function trashEntry(path: string): Promise<void> {
  const entry = entryAt(path);
  if (!entry) return;
  await saveAll();
  const usages = entry.folder ? [] : await api.usages(path);
  const links = usages.reduce((n, u) => n + u.links.length, 0);
  const inside = entry.folder ? [...useVault.getState().entries.keys()].filter((p) => p.startsWith(`${path}/`)).length : 0;
  const details = [
    inside > 0 ? `It holds ${plural(inside, "item")}.` : null,
    links > 0 ? `${plural(links, "link")} in ${plural(usages.length, "note")} will lead nowhere.` : null,
    "You can restore it from the Trash.",
  ];
  const ok = await confirm({
    title: `Move “${displayName(path)}” to the Trash?`,
    message: details.filter(Boolean).join(" "),
    action: "Move to Trash",
    danger: true,
  });
  if (ok) await api.entryTrash(path);
}

export async function duplicateEntry(path: string): Promise<void> {
  await saveAll();
  openPath(await api.entryDuplicate(path));
}

export async function copyLink(path: string): Promise<void> {
  await copyText(`[[${await api.linkText("", path)}]]`);
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** Puts text in a new note and a link to it where the text was. */
export async function extractToNote(source: string, text: string): Promise<{ link: string; path: string } | null> {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text.trimStart().split("\n", 1)[0] ?? "");
  const suggested = heading ? heading[1]!.replace(/[\\:*?"<>|#^[\]/]/g, "").trim() : "";
  const folder = parentOf(source);
  const name = await input({
    title: "Extract to Note",
    value: suggested,
    placeholder: "Name of the new note",
    action: "Extract",
    validate: (value) => nameProblem(value) ?? noteNameProblem(folder, value),
  });
  if (name === null) return null;
  const path = joinPath(folder, withExtension(name.trim()));
  await api.noteCreate(path, `${text.trim()}\n`);
  return { path, link: `[[${await api.linkText(source, path)}]]` };
}

export async function revealInFileManager(path: string): Promise<void> {
  await api.entryReveal(path);
}

export async function openExternally(path: string): Promise<void> {
  await api.entryOpen(path);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** For actions started from the UI: failures are shown, not thrown. */
export function run(action: Promise<unknown>, doing?: string) {
  action.catch((e) => notifyError(e, doing));
}
