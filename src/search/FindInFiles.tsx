import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { plural } from "../actions";
import { api, errorMessage, type TextMatch, type TextResults } from "../backend/api";
import { useKeymapHold } from "../commands/keymapHold";
import { activeView } from "../editor/active";
import { readNote } from "../editor/documents";
import { Excerpted } from "../toolwindows/UsageTree";
import { FileIcon } from "../ui/FileIcon";
import { inputClass } from "../ui/Modal";
import { Button, cx, Kbd } from "../ui/primitives";
import { TreeView, type TreeRow } from "../ui/TreeView";
import { displayName } from "../vault/paths";
import { openPath } from "../workbench/editorArea";
import { showToolWindow } from "../workbench/toolWindows";
import { useFindQuery, useFindResults } from "./findState";
import { showPopup } from "./popupState";

type Row = { path: string; match: TextMatch };

const LIMIT = 1000;

/** Find in Files (⇧⌘F): every match as one types, and the text around the selected one. */
export function FindInFiles() {
  const { query } = useFindQuery();
  const [results, setResults] = useState<TextResults | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const set = (change: Partial<typeof query>) => useFindQuery.setState({ query: { ...query, ...change } });

  // What is selected in the note is most likely what one is after.
  useEffect(() => {
    const view = activeView();
    const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 };
    const text = view && to > from && to - from < 200 ? view.state.sliceDoc(from, to) : "";
    if (text && !text.includes("\n")) set({ text });
    requestAnimationFrame(() => field.current?.select());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let stale = false;
    const timer = window.setTimeout(() => {
      if (!query.text) return setResults(null);
      api
        .searchText({ ...query, limit: LIMIT })
        .then((found) => {
          if (stale) return;
          setProblem(null);
          setResults(found);
        })
        .catch((e) => {
          if (stale) return;
          setProblem(errorMessage(e));
          setResults(null);
        });
    }, 60);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const rows = useMemo(
    () =>
      (results?.files ?? []).flatMap((file) =>
        file.matches.map((match, i): TreeRow<Row> => ({
          id: `${file.path}:${match.line}:${match.col}:${i}`,
          depth: 0,
          label: match.preview,
          data: { path: file.path, match },
        })),
      ),
    [results],
  );
  useEffect(() => setSelected(rows[0]?.id ?? null), [rows]);
  const at = rows.findIndex((r) => r.id === selected);
  const current = rows[at]?.data;

  const open = (row: Row) => {
    showPopup(null);
    requestAnimationFrame(() => openPath(row.path, { line: row.match.line, col: row.match.col }));
  };
  const openInWindow = () => {
    if (!results) return;
    useFindResults.setState({ results: { kind: "text", title: `“${query.text}”`, results } });
    showPopup(null);
    showToolWindow("find");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (e.target !== field.current || rows.length === 0) return;
      e.preventDefault();
      const next = Math.min(Math.max(at + (e.key === "ArrowDown" ? 1 : -1), 0), rows.length - 1);
      setSelected(rows[next]!.id);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) openInWindow();
      else if (current) open(current);
    } else if (e.altKey && !e.metaKey && ["KeyC", "KeyW", "KeyX"].includes(e.code)) {
      e.preventDefault();
      if (e.code === "KeyC") set({ matchCase: !query.matchCase });
      if (e.code === "KeyW") set({ wholeWords: !query.wholeWords });
      if (e.code === "KeyX") set({ regex: !query.regex });
    }
  };

  return (
    <Dialog.Root open onOpenChange={(isOpen) => !isOpen && showPopup(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className="fixed top-[9vh] left-1/2 z-50 flex h-[min(680px,82vh)] w-[min(880px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover outline-none"
        >
          <Hold />
          <div className="flex items-center gap-2 px-4 pt-3 pb-2">
            <Dialog.Title className="text-[13px] font-semibold text-fg">Find in Files</Dialog.Title>
            <span className="text-[12px] text-subtle">
              {problem ? (
                <span className="text-danger">{problem}</span>
              ) : (
                results && `${results.total}${results.truncated ? "+" : ""} in ${plural(results.files.length, "note")}`
              )}
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-4 pb-2">
            <input
              ref={field}
              autoFocus
              aria-label="Text to find"
              className={cx(inputClass, "h-8 flex-1 text-[13px]", problem && "border-danger")}
              value={query.text}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="Text to find"
              onChange={(e) => set({ text: e.target.value })}
            />
            <Toggle label="Match case (⌥C)" text="Cc" on={query.matchCase} onClick={() => set({ matchCase: !query.matchCase })} />
            <Toggle label="Words (⌥W)" text="W" on={query.wholeWords} onClick={() => set({ wholeWords: !query.wholeWords })} />
            <Toggle label="Regular expression (⌥X)" text=".*" on={query.regex} onClick={() => set({ regex: !query.regex })} />
            <input
              aria-label="Only in folder"
              className={cx(inputClass, "h-8 w-40")}
              value={query.folder}
              spellCheck={false}
              placeholder="In folder"
              onChange={(e) => set({ folder: e.target.value.replace(/^\/+|\/+$/g, "") })}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col border-t border-border bg-panel">
            <TreeView
              label="Matches"
              driven
              rows={rows}
              selected={selected}
              onSelect={(row) => setSelected(row.id)}
              onActivate={(row, how) => how !== "click" && open(row.data)}
              empty={<p className="px-4 py-6 text-center text-[12.5px] text-subtle">{query.text && !problem ? "Nothing found" : ""}</p>}
            >
              {({ data }) => (
                <>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    <Excerpted text={data.match.preview} from={data.match.previewCol} length={data.match.len} />
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-subtle">
                    <FileIcon path={data.path} />
                    {displayName(data.path)}:{data.match.line + 1}
                  </span>
                </>
              )}
            </TreeView>
          </div>
          <Preview row={current} />
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11.5px] text-subtle">
            <span>
              <Kbd>⏎</Kbd> open
            </span>
            <span className="flex-1" />
            <Button disabled={!results?.total} onClick={openInWindow}>
              Open in Find Window <Kbd>⌘⏎</Kbd>
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Hold() {
  useKeymapHold();
  return null;
}

function Toggle({ label, text, on, onClick }: { label: string; text: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      tabIndex={-1}
      className="h-7 min-w-7 rounded-md px-1.5 font-mono text-[12px] text-muted hover:bg-hover aria-pressed:bg-accent-soft aria-pressed:text-accent"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

const AROUND = 5;

/** The lines around a match. */
function Preview({ row }: { row: Row | undefined }) {
  const [text, setText] = useState<{ path: string; lines: string[] } | null>(null);
  const path = row?.path;
  useEffect(() => {
    if (!path) return;
    let stale = false;
    readNote(path)
      .then((t) => !stale && setText({ path, lines: t.split(/\r\n?|\n/) }))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [path]);

  if (!row || text?.path !== row.path) return <div className="h-[218px] shrink-0 border-t border-border" />;
  const first = Math.max(0, row.match.line - AROUND);
  return (
    <div className="h-[218px] shrink-0 overflow-hidden border-t border-border bg-inset py-2 font-mono text-[12px] leading-[18px]">
      {text.lines.slice(first, row.match.line + AROUND + 1).map((line, i) => {
        const number = first + i;
        const isMatch = number === row.match.line;
        return (
          <div key={number} className={cx("flex gap-3 px-4 whitespace-pre", isMatch && "bg-accent-soft")}>
            <span className="w-8 shrink-0 text-right text-subtle">{number + 1}</span>
            <span className="min-w-0 truncate text-muted">
              {isMatch ? <Excerpted text={line} from={row.match.col} length={row.match.len} /> : line}
            </span>
          </div>
        );
      })}
    </div>
  );
}
