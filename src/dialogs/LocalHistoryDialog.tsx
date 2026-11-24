import { useEffect, useState } from "react";
import { create } from "zustand";
import { createNote, run } from "../actions";
import { api, type Revision } from "../backend/api";
import { modifyNote, readNote } from "../editor/documents";
import { Modal } from "../ui/Modal";
import { notify } from "../ui/notifications";
import { Button, cx } from "../ui/primitives";
import { displayName } from "../vault/paths";
import { entryAt } from "../vault/store";
import { openPath } from "../workbench/editorArea";
import { Diff } from "./CompareDialog";

export const useLocalHistory = create<{ path: string | null }>(() => ({ path: null }));

export function showLocalHistory(path: string) {
  useLocalHistory.setState({ path });
}

const REASON: Record<Revision["reason"], string> = {
  edit: "Edited",
  refactor: "Links updated",
  mcp: "Changed by an MCP client",
  delete: "Deleted",
};

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** What a note said before, next to what it says now. */
export function LocalHistoryDialog() {
  const path = useLocalHistory((s) => s.path);
  return path ? <History key={path} path={path} /> : null;
}

function History({ path }: { path: string }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const close = () => useLocalHistory.setState({ path: null });

  useEffect(() => {
    run(
      api.historyList(path).then((list) => {
        setRevisions(list);
        setSelected(list[0]?.id ?? null);
      }),
    );
    if (entryAt(path)) run(readNote(path).then(setCurrent));
  }, [path]);
  useEffect(() => {
    if (selected === null) return;
    let stale = false;
    run(api.historyText(selected).then((t) => !stale && setText(t)));
    return () => {
      stale = true;
    };
  }, [selected]);

  const restore = async () => {
    if (text === null) return;
    if (entryAt(path)) await modifyNote(path, () => text);
    else await createNote(path, text);
    close();
    openPath(path);
    notify(`${displayName(path)} is as it was`);
  };

  const chosen = revisions?.find((r) => r.id === selected);
  return (
    <Modal
      open
      onClose={close}
      title={`Local History: ${displayName(path)}`}
      width={1180}
      footer={
        <>
          <span className="flex-1 text-[12px] text-subtle">Kept on this computer for 30 days, outside the vault.</span>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" disabled={text === null} onClick={() => run(restore())}>
            Revert to this
          </Button>
        </>
      }
    >
      {revisions?.length === 0 ? (
        <p className="py-8 text-center text-[12.5px] text-muted">Nothing yet. Every change from now on is kept here.</p>
      ) : (
        <div className="flex h-[min(580px,62vh)] gap-3">
          <ul className="w-[210px] shrink-0 overflow-y-auto" aria-label="Revisions">
            {revisions?.map((r, i) => {
              const newDay = i === 0 || day.format(r.at) !== day.format(revisions[i - 1]!.at);
              return (
                <li key={r.id}>
                  {newDay && <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-subtle">{day.format(r.at)}</div>}
                  <button
                    type="button"
                    className={cx("flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-[12.5px]", r.id === selected ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover")}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className="tabular-nums">{time.format(r.at)}</span>
                    <span className="truncate text-[11.5px] text-subtle">{REASON[r.reason]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="mb-1 grid grid-cols-2 text-[12px] font-medium text-muted">
              <span>{chosen && `Before ${time.format(chosen.at)}`}</span>
              <span>Now</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
              {text !== null && <Diff before={text} after={current} />}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
