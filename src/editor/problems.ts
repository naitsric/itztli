import { forEachDiagnostic, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { api, type Problem } from "../backend/api";
import { nameProblem } from "../vault/paths";
import { createMissingNote } from "../actions";
import { notifyError } from "../ui/notifications";
import { notePath } from "./note";

export function describeProblem(problem: Problem): string {
  switch (problem.kind) {
    case "missingNote":
      return `“${problem.target}” does not exist`;
    case "missingPlace":
      return `There is no “${problem.target.slice(problem.target.indexOf("#") + 1)}” there`;
    case "invalidFrontmatter":
      return "The properties at the top are not valid YAML";
  }
}

/** Marks the links of a note that lead nowhere, as saved. */
export async function refreshProblems(view: EditorView): Promise<void> {
  const path = view.state.facet(notePath);
  const doc = view.state.doc;
  const problems = await api.problemsIn(path).catch(() => []);
  // Typing went on: positions are for a text that is no more.
  if (view.state.doc !== doc || view.state.facet(notePath) !== path || !view.dom.isConnected) return;
  const diagnostics = problems.flatMap((problem): Diagnostic[] => {
    if (problem.line >= doc.lines) return [];
    const line = doc.line(problem.line + 1);
    const from = Math.min(line.from + problem.col, line.to);
    const creatable = problem.kind === "missingNote" && nameProblem(problem.target.replace(/^(\.\.?\/|\/)+/, "")) === null && !/\.\w{2,4}$/.test(problem.target.replace(/\.md$/i, ""));
    return [
      {
        from,
        to: Math.min(from + problem.len, line.to),
        severity: problem.kind === "invalidFrontmatter" ? "error" : "info",
        message: describeProblem(problem),
        actions: creatable
          ? [{ name: "Create it", apply: () => void createMissingNote(path, problem.target).catch((e) => notifyError(e)) }]
          : [],
      },
    ];
  });
  view.dispatch(setDiagnostics(view.state, diagnostics));
}

/** Goes to the next or previous problem, around the ends. */
export function goToProblem(view: EditorView, direction: 1 | -1): boolean {
  const at: { from: number; to: number }[] = [];
  forEachDiagnostic(view.state, (_, from, to) => at.push({ from, to }));
  if (at.length === 0) return false;
  at.sort((a, b) => a.from - b.from);
  const head = view.state.selection.main.head;
  const next =
    direction > 0 ? (at.find((d) => d.from > head) ?? at[0]!) : (at.findLast((d) => d.from < head) ?? at[at.length - 1]!);
  view.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
  return true;
}

export function problemCount(view: EditorView): number {
  let count = 0;
  forEachDiagnostic(view.state, () => count++);
  return count;
}
