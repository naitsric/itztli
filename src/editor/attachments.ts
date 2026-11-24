import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { api } from "../backend/api";
import { settings } from "../settings/store";
import { notifyError } from "../ui/notifications";
import { nameOf } from "../vault/paths";
import { notePath } from "./note";

/** Files pasted or dropped in a note: saved in the vault and embedded. */

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

function nameFor(file: File): string {
  // What the clipboard calls a screenshot says nothing.
  const generic = !file.name || /^image\.\w+$/.test(file.name);
  if (!generic) return file.name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/^\.+/, "").trim() || "file";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted ${stamp}.${EXTENSION[file.type] ?? "bin"}`;
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
    reader.readAsDataURL(file);
  });
}

async function attach(view: EditorView, files: File[], pos: number) {
  const source = view.state.facet(notePath);
  const embeds: string[] = [];
  for (const file of files) {
    const path = await api.attachmentCreate(settings().files.attachmentsFolder, nameFor(file), await toBase64(file));
    embeds.push(`![[${await api.linkText(source, path).catch(() => nameOf(path))}]]`);
  }
  if (!view.dom.isConnected) return;
  const at = Math.min(pos, view.state.doc.length);
  const insert = embeds.join("\n");
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.paste" });
}

export function attachments(): Extension {
  const take = (view: EditorView, files: FileList | undefined, pos: number): boolean => {
    if (!files || files.length === 0) return false;
    attach(view, [...files], pos).catch((e) => notifyError(e, "The file was not added"));
    return true;
  };
  return EditorView.domEventHandlers({
    paste(event, view) {
      // Copied from a spreadsheet or a page, text is what one wants.
      if (event.clipboardData?.types.includes("text/plain")) return false;
      const { from, to } = view.state.selection.main;
      if (!take(view, event.clipboardData?.files, from)) return false;
      if (from !== to) view.dispatch({ changes: { from, to } });
      event.preventDefault();
      return true;
    },
    drop(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      if (!take(view, event.dataTransfer?.files, pos)) return false;
      event.preventDefault();
      return true;
    },
  });
}
