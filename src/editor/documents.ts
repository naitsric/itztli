import { Annotation, Text, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { create } from "zustand";
import { api, errorMessage, isCommandError } from "../backend/api";
import { notify, notifyError } from "../ui/notifications";
import { displayName, isWithin, movedPath } from "../vault/paths";
import { onFileChange } from "../vault/store";

/**
 * Open notes. A document is one per path, however many editors show it: each
 * editor's changes go to the others, and it is saved by itself shortly after
 * typing stops, as in IntelliJ. It never overwrites someone else's change:
 * the file has to hold what was last read, or the user decides.
 */

export type DocumentStatus =
  | { state: "ready" }
  /** The file changed on disk while there were unsaved changes here. */
  | { state: "conflict" }
  /** The file was deleted while there were unsaved changes here. */
  | { state: "deleted" }
  | { state: "failed"; message: string };

interface DocumentInfo {
  dirty: boolean;
  status: DocumentStatus;
}

/** What the UI shows about open documents, by path. */
export const useDocuments = create<{ open: Record<string, DocumentInfo>; saved: number }>(() => ({ open: {}, saved: 0 }));

const SAVE_DELAY_MS = 500;

/** Marks a change that came from another editor of the same document, or from disk. */
const fromElsewhere = Annotation.define<boolean>();

export class NoteDocument {
  path: string;
  text: Text;
  revision: string;
  private readonly crlf: boolean;
  readonly views = new Set<EditorView>();
  dirty = false;
  status: DocumentStatus = { state: "ready" };
  private timer = 0;
  private saving: Promise<void> | null = null;

  constructor(path: string, text: string, revision: string) {
    this.path = path;
    this.crlf = text.includes("\r\n");
    this.text = toText(text);
    this.revision = revision;
    this.publish();
  }

  publish() {
    const info: DocumentInfo = { dirty: this.dirty, status: this.status };
    useDocuments.setState((s) => ({ open: { ...s.open, [this.path]: info } }));
  }

  setStatus(status: DocumentStatus) {
    this.status = status;
    this.publish();
  }

  /** For an editor of this document. */
  extension(): Extension {
    return EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.every((tr) => tr.annotation(fromElsewhere))) return;
      this.text = update.state.doc;
      for (const view of this.views) {
        if (view !== update.view) {
          view.dispatch({
            changes: update.changes,
            annotations: [fromElsewhere.of(true), Transaction.addToHistory.of(false)],
          });
        }
      }
      this.touched();
    });
  }

  private touched() {
    if (!this.dirty) {
      this.dirty = true;
      this.publish();
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  private content(): string {
    const text = this.text.toString();
    return this.crlf ? text.replaceAll("\n", "\r\n") : text;
  }

  /** Saves what changed. Resolves once it is on disk, or it is clear it won't be. */
  async save(): Promise<void> {
    window.clearTimeout(this.timer);
    while (this.saving) await this.saving;
    if (!this.dirty || this.status.state === "conflict" || this.status.state === "deleted") return;
    this.saving = this.write(this.revision).finally(() => (this.saving = null));
    await this.saving;
  }

  private async write(base: string | undefined) {
    const saved = this.text;
    try {
      this.revision = await api.noteWrite(this.path, this.content(), base);
      this.dirty = this.text !== saved;
      this.setStatus({ state: "ready" });
      useDocuments.setState((s) => ({ saved: s.saved + 1 }));
      // Typing went on while saving.
      if (this.dirty) this.scheduleSave();
    } catch (e) {
      if (isCommandError(e) && e.code === "conflict") this.setStatus({ state: "conflict" });
      else if (isCommandError(e) && e.code === "notFound") this.setStatus({ state: "deleted" });
      else {
        this.setStatus({ state: "failed", message: errorMessage(e) });
        notifyError(e, `“${displayName(this.path)}” is not saved`);
      }
    }
  }

  /** Replaces the text here and in every editor, changing only what differs. */
  setText(text: string, options: { history: boolean }) {
    const next = toText(text);
    const change = difference(this.text, next);
    this.text = next;
    if (!change) return;
    for (const view of this.views) {
      view.dispatch({
        changes: change,
        annotations: [fromElsewhere.of(true), Transaction.addToHistory.of(options.history)],
      });
    }
  }

  /** The file changed on disk: take it, unless there is something to lose. */
  async refresh(): Promise<void> {
    while (this.saving) await this.saving;
    let file;
    try {
      file = await api.noteRead(this.path);
    } catch (e) {
      if (isCommandError(e) && e.code === "notFound") return this.removed();
      return this.setStatus({ state: "failed", message: errorMessage(e) });
    }
    if (file.revision === this.revision) return;
    if (this.dirty) {
      if (toText(file.text).eq(this.text)) {
        this.revision = file.revision;
        this.dirty = false;
        return this.setStatus({ state: "ready" });
      }
      return this.setStatus({ state: "conflict" });
    }
    this.revision = file.revision;
    this.setText(file.text, { history: false });
    this.setStatus({ state: "ready" });
  }

  removed() {
    if (this.dirty) this.setStatus({ state: "deleted" });
  }

  /** Settles a conflict: what is on disk stays. */
  async takeDisk() {
    const file = await api.noteRead(this.path);
    window.clearTimeout(this.timer);
    this.revision = file.revision;
    this.dirty = false;
    // Undo brings back what was here.
    this.setText(file.text, { history: true });
    this.setStatus({ state: "ready" });
  }

  /** Settles a conflict, or a deletion: what is here stays. */
  async keepMine() {
    while (this.saving) await this.saving;
    this.saving = this.write(undefined).finally(() => (this.saving = null));
    await this.saving;
  }

  /** Changes the text from outside any editor, and saves. */
  async edit(change: (text: string) => string) {
    const before = this.text.toString();
    const after = change(before);
    if (after === before) return;
    this.setText(after, { history: true });
    this.touched();
    await this.save();
  }

  dispose() {
    window.clearTimeout(this.timer);
  }
}

function toText(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/));
}

/** The one change that turns a text into another. */
export function difference(from: Text, to: Text): ChangeSpec | null {
  if (from.eq(to)) return null;
  const a = from.toString();
  const b = to.toString();
  const shortest = Math.min(a.length, b.length);
  let start = 0;
  while (start < shortest && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < shortest - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  // Not through the middle of a character.
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  if (end > 0 && isLowSurrogate(a.charCodeAt(a.length - end))) end--;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit < 0xdc00;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit < 0xe000;

const documents = new Map<string, NoteDocument>();
const loading = new Map<string, Promise<NoteDocument>>();

/** The open document, if there is one. */
export function documentAt(path: string): NoteDocument | undefined {
  return documents.get(path);
}

export function openDocument(path: string): Promise<NoteDocument> {
  const open = documents.get(path);
  if (open) return Promise.resolve(open);
  let pending = loading.get(path);
  if (!pending) {
    pending = api
      .noteRead(path)
      .then(({ text, revision }) => {
        const doc = new NoteDocument(path, text, revision);
        documents.set(path, doc);
        return doc;
      })
      .finally(() => loading.delete(path));
    loading.set(path, pending);
  }
  return pending;
}

export function attachView(doc: NoteDocument, view: EditorView) {
  doc.views.add(view);
}

/** An editor closed. The last one takes its document with it, saved. */
export function detachView(doc: NoteDocument, view: EditorView) {
  doc.views.delete(view);
  if (doc.views.size > 0) return;
  void doc.save().then(() => {
    if (doc.views.size > 0 || documents.get(doc.path) !== doc) return;
    // Not saved: kept, so opening it again shows what was typed.
    if (doc.dirty) return;
    close(doc);
  });
}

function close(doc: NoteDocument) {
  doc.dispose();
  documents.delete(doc.path);
  useDocuments.setState((s) => {
    const { [doc.path]: _, ...open } = s.open;
    return { open };
  });
}

export async function saveAll(): Promise<void> {
  await Promise.all([...documents.values()].map((doc) => doc.save()));
}

/** Paths whose changes could not be saved. */
export function unsaved(): string[] {
  return [...documents.values()].filter((doc) => doc.dirty).map((doc) => doc.path);
}

export function closeAllDocuments() {
  for (const doc of [...documents.values()]) close(doc);
}

/** A note's text as the user sees it: what is open, or what is on disk. */
export async function readNote(path: string): Promise<string> {
  return documents.get(path)?.text.toString() ?? (await api.noteRead(path)).text;
}

/**
 * Changes a note's text, open or not. Closed, it is read and written again
 * if someone else wrote it in between.
 */
export async function modifyNote(path: string, change: (text: string) => string): Promise<void> {
  const open = documents.get(path);
  if (open) return open.edit(change);
  for (let attempt = 1; ; attempt++) {
    const { text, revision } = await api.noteRead(path);
    const next = change(text);
    if (next === text) return;
    try {
      await api.noteWrite(path, next, revision);
      return;
    } catch (e) {
      if (!isCommandError(e) || e.code !== "conflict" || attempt >= 5) throw e;
    }
  }
}

onFileChange((change) => {
  if (change.kind === "put") {
    void documents.get(change.path)?.refresh();
  } else if (change.kind === "remove") {
    for (const doc of documents.values()) if (isWithin(doc.path, change.path)) doc.removed();
  } else {
    for (const doc of [...documents.values()]) {
      if (!isWithin(doc.path, change.from)) continue;
      const old = doc.path;
      documents.delete(old);
      doc.path = movedPath(old, change.from, change.to);
      documents.set(doc.path, doc);
      useDocuments.setState((s) => {
        const { [old]: info, ...open } = s.open;
        return { open: info ? { ...open, [doc.path]: info } : open };
      });
    }
  }
});

/** Asks about notes that can't be saved as they are. Tells whether to go on. */
export function warnUnsaved(): boolean {
  const paths = unsaved();
  if (paths.length === 0) return true;
  notify(`${paths.map(displayName).join(", ")}: not saved. Settle it before closing.`, { kind: "warning" });
  return false;
}
