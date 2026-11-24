import { useMemo, useState } from "react";
import { plural } from "../actions";
import { api, type Problem } from "../backend/api";
import { useDocuments } from "../editor/documents";
import { describeProblem } from "../editor/problems";
import { Segmented } from "../ui/primitives";
import { useVault } from "../vault/store";
import { useEditorArea } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { UsageTree, type PlaceGroup } from "./UsageTree";
import { useQuery } from "./useQuery";

/** Links that lead nowhere, in the note in front or in all of them. */
export function ProblemsWindow() {
  const path = useEditorArea((s) => s.activePath);
  const content = useVault((s) => s.content);
  const saved = useDocuments((s) => s.saved);
  const [scope, setScope] = useState<"note" | "vault">("vault");
  const problems = useQuery<Problem[]>(
    () => (scope === "vault" ? api.problems() : path ? api.problemsIn(path) : Promise.resolve([])),
    [scope, scope === "note" ? path : null, content, saved],
  );
  const groups = useMemo(() => {
    const byPath = new Map<string, PlaceGroup>();
    for (const p of problems ?? []) {
      const group = byPath.get(p.path) ?? { path: p.path, places: [] };
      const label = describeProblem(p);
      group.places.push({ line: p.line, col: p.col, label, content: label });
      byPath.set(p.path, group);
    }
    return [...byPath.values()];
  }, [problems]);

  return (
    <>
      <ToolWindowHeader title="Problems" icon="warning" onHide={() => hideToolWindow("problems")}>
        {problems && problems.length > 0 && <span className="mr-2 text-[11.5px] text-subtle">{plural(problems.length, "problem")}</span>}
        <Segmented
          label="Where"
          value={scope}
          options={[
            { value: "note", label: "Note" },
            { value: "vault", label: "Vault" },
          ]}
          onChange={setScope}
        />
      </ToolWindowHeader>
      <UsageTree label="Problems" groups={groups} empty={<p className="px-4 py-3 text-[12.5px] text-subtle">Every link leads somewhere.</p>} />
    </>
  );
}
