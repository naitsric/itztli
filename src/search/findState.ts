import { create } from "zustand";
import type { TextQuery, TextResults, Usages } from "../backend/api";

/** What Find in Files last looked for: it opens as it was left. */
export const useFindQuery = create<{ query: Required<Pick<TextQuery, "text" | "matchCase" | "wholeWords" | "regex" | "folder">> }>(() => ({
  query: { text: "", matchCase: false, wholeWords: false, regex: false, folder: "" },
}));

/** What the Find tool window shows: a search, or the usages of a note. */
export type FindResults =
  | { kind: "text"; title: string; results: TextResults }
  | { kind: "usages"; title: string; usages: Usages[] };

export const useFindResults = create<{ results: FindResults | null }>(() => ({ results: null }));
