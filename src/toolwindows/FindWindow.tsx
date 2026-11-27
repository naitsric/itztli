import { useMemo } from "react";
import { useFindResults } from "../search/findState";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { usageGroups } from "./usages";
import { Excerpted, UsageTree, type PlaceGroup } from "./UsageTree";

/** The results of a search, kept in view while one goes through them. */
export function FindWindow() {
  const results = useFindResults((s) => s.results);
  const groups = useMemo((): PlaceGroup[] => {
    if (!results) return [];
    if (results.kind === "usages") return usageGroups(results.usages);
    return results.results.files.map(({ path, matches }) => ({
      path,
      places: matches.map((m) => ({
        line: m.line,
        col: m.col,
        label: m.preview,
        content: <Excerpted text={m.preview} from={m.previewCol} length={m.len} />,
      })),
    }));
  }, [results]);
  const total = groups.reduce((n, g) => n + g.places.length, 0);
  return (
    <>
      <ToolWindowHeader title={results ? `Find: ${results.title}` : "Find"} icon="search" onHide={() => hideToolWindow("find")}>
        {results && <span className="mr-1 text-[11.5px] text-subtle tabular-nums">{total}</span>}
      </ToolWindowHeader>
      <UsageTree
        label="Find results"
        groups={groups}
        empty={
          <p className="px-4 py-3 text-[12.5px] text-subtle">
            {results ? "Nothing found." : "Results of Find in Files (⇧⌘F) and Find Usages (⌥F7) show here."}
          </p>
        }
      />
    </>
  );
}
