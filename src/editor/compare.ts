import { api } from "../backend/api";
import { notifyError } from "../ui/notifications";
import { displayName } from "../vault/paths";
import { create } from "zustand";
import type { NoteDocument } from "./documents";

/** Two texts side by side; see CompareDialog.tsx. */
export interface Comparison {
  title: string;
  before: { label: string; text: string };
  after: { label: string; text: string };
  /** Settles it with one of them. */
  actions: { title: string; run: () => void }[];
}

export const useComparison = create<{ shown: Comparison | null }>(() => ({ shown: null }));

export function compare(comparison: Comparison) {
  useComparison.setState({ shown: comparison });
}

export function compareWithDisk(doc: NoteDocument) {
  api
    .noteRead(doc.path)
    .then((file) =>
      compare({
        title: displayName(doc.path),
        before: { label: "On disk", text: file.text },
        after: { label: "Yours", text: doc.text.toString() },
        actions: [
          { title: "Load from disk", run: () => void doc.takeDisk() },
          { title: "Keep mine", run: () => void doc.keepMine() },
        ],
      }),
    )
    .catch((e) => notifyError(e));
}
