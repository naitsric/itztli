import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { create } from "zustand";
import { errorMessage } from "../backend/api";
import { setCommandFailureHandler } from "../commands/registry";
import { cx } from "./primitives";

export interface Notification {
  id: number;
  kind: "info" | "warning" | "error";
  message: string;
  actions: { title: string; run: () => void }[];
}

const useNotifications = create<{ shown: Notification[] }>(() => ({ shown: [] }));

let next = 1;
/** Enough to read; what went wrong, or has something to click, stays until dismissed. */
const SHOWN_MS = 5000;
const MAX_SHOWN = 4;

export function notify(
  message: string,
  options: { kind?: Notification["kind"]; actions?: Notification["actions"] } = {},
): void {
  const { kind = "info", actions = [] } = options;
  const id = next++;
  useNotifications.setState((s) => {
    // The same thing again replaces itself rather than piling up.
    const others = s.shown.filter((n) => n.message !== message || n.kind !== kind);
    return { shown: [...others, { id, kind, message, actions }].slice(-MAX_SHOWN) };
  });
  if (kind === "info" && actions.length === 0) window.setTimeout(() => dismiss(id), SHOWN_MS);
}

export function notifyError(e: unknown, doing?: string) {
  console.error(doing ?? "error", e);
  notify(doing ? `${doing}: ${errorMessage(e)}` : errorMessage(e), { kind: "error" });
}

function dismiss(id: number) {
  useNotifications.setState((s) => ({ shown: s.shown.filter((n) => n.id !== id) }));
}

setCommandFailureHandler((command, e) => notifyError(e, command.title));

const ICON = { info: Info, warning: TriangleAlert, error: CircleAlert };
const TONE = { info: "text-accent", warning: "text-warning", error: "text-danger" };

export function Notifications() {
  const shown = useNotifications((s) => s.shown);
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-40 flex w-[340px] flex-col gap-2" role="status" aria-live="polite">
      {shown.map((n) => {
        const Icon = ICON[n.kind];
        return (
          <div
            key={n.id}
            className="pointer-events-auto flex animate-[itztli-rise_160ms_ease-out] gap-2.5 rounded-lg border border-border-strong bg-elevated py-2.5 pr-2 pl-3 shadow-popover"
          >
            <Icon className={cx("mt-px size-4 shrink-0", TONE[n.kind])} />
            <div className="min-w-0 flex-1">
              <p className="selectable text-[12.5px] break-words text-fg">{n.message}</p>
              {n.actions.length > 0 && (
                <div className="mt-1.5 flex gap-3">
                  {n.actions.map((action) => (
                    <button
                      key={action.title}
                      type="button"
                      className="text-[12px] font-medium text-accent hover:underline"
                      onClick={() => {
                        dismiss(n.id);
                        action.run();
                      }}
                    >
                      {action.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="flex size-5 shrink-0 items-center justify-center rounded text-subtle hover:bg-hover hover:text-fg"
              onClick={() => dismiss(n.id)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
