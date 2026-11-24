import { ArrowRight, Check, ChevronLeft, ChevronRight, Clock, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Diff, NoteText } from "../dialogs/CompareDialog";
import { Modal } from "../ui/Modal";
import { Button, cx, IconButton } from "../ui/primitives";
import { useNow } from "../ui/useNow";
import type { ApprovalRequest } from "./api";
import { armed, armsIn, closedGate, currentRequest, rearm, showRequest, type ApproveGate } from "./approvalsQueue";
import { wants, WARNING_LABEL } from "./labels";
import { clientInfoLabel, formatCountdown } from "./presence";
import { answerApproval, hideApprovals, stepApproval, useMcp } from "./store";

/** The countdown turns red this close to the end. */
const URGENT_MS = 15_000;
/** Notes named one by one, of those whose links change. */
const NAMED = 6;

/**
 * Asks the user about a change an MCP client wants to make. It comes up over
 * everything, the window brought to the front by the app, also while the
 * user types in a note, so it is built not to be answered by accident:
 *
 * - Reject has the focus, and plain Enter never approves (Enter on Reject
 *   rejects; on Approve it does nothing).
 * - Approve is disabled for 800 ms after a request is shown, after moving
 *   to another one, and after the window comes back to the front.
 * - In those 800 ms Enter, Space and Escape do nothing at all, and any key
 *   restarts them, so someone still typing in a note answers nothing.
 * - Escape (and Later) puts the dialog aside without answering: the
 *   requests keep waiting until they expire, and the status bar's badge,
 *   or the next request, brings it back. A click outside does nothing.
 * - While it shows, it holds the keymap (see keymapHold.ts): no shortcut
 *   or menu command acts behind it.
 * - What the client wrote is marked as its own and kept apart (`bdi`), so no
 *   text of its choosing rearranges the dialog's.
 */
export function ApprovalDialog() {
  const approvals = useMcp((s) => s.approvals);
  const hidden = useMcp((s) => s.approvalsHidden);
  const current = currentRequest(approvals);
  if (!current || hidden) return null;
  return <ApprovalSheet request={current.request} index={current.index} total={approvals.requests.length} />;
}

function ApprovalSheet({ request, index, total }: { request: ApprovalRequest; index: number; total: number }) {
  const now = useNow(1000);
  const [gate, drawGate] = useState(closedGate);
  // Read when a click or a key arrives, which may be before the next drawing.
  const latest = useRef(gate);
  const setGate = useCallback((change: (gate: ApproveGate) => ApproveGate) => {
    latest.current = change(latest.current);
    drawGate(latest.current);
  }, []);
  const [answering, setAnswering] = useState(false);
  const answered = useRef<number | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const rejectButton = useRef<HTMLButtonElement>(null);

  // Arm again, and give Reject the focus, whenever another request is shown.
  useLayoutEffect(() => {
    setGate((g) => showRequest(g, request.id, performance.now()));
    setAnswering(false);
    rejectButton.current?.focus();
  }, [request.id, setGate]);

  // Coming back to the window re-arms too: a click meant to focus it must not approve.
  useEffect(() => {
    const onFocus = () => setGate((g) => rearm(g, performance.now()));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [setGate]);

  // Re-render once the gate opens.
  useEffect(() => {
    const wait = armsIn(gate, performance.now());
    if (wait === 0) return;
    const timer = window.setTimeout(rerender, wait + 16);
    return () => window.clearTimeout(timer);
  }, [gate]);

  const isArmed = () => armed(latest.current, performance.now());
  const left = Date.parse(request.expiresAt) - now;
  const expired = left <= 0;

  const answer = async (approve: boolean) => {
    if (answered.current === request.id) return;
    answered.current = request.id;
    setAnswering(true);
    await answerApproval(request.id, approve);
    // Still here if it could not be answered: then it can be again.
    answered.current = null;
    setAnswering(false);
  };

  const onKeyDownCapture = (e: KeyboardEvent) => {
    const early = !isArmed();
    // Someone still typing (in the note the dialog came up over) keeps it
    // from arming: each key restarts the wait.
    if (early && e.key !== "Tab") setGate((g) => rearm(g, performance.now()));
    const activates = e.key === "Enter" || e.key === " ";
    // Plain Enter never approves.
    const enterOnApprove = e.key === "Enter" && (e.target as Element).closest("[data-approve]");
    if ((early && activates) || enterOnApprove) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const reportedBy = clientInfoLabel(request.clientInfo?.name ?? null, request.clientInfo?.version ?? null);
  const destroys = request.action === "delete" || request.warnings.length > 0;

  return (
    <Modal
      open
      onClose={hideApprovals}
      width={request.action === "edit" ? 1040 : 680}
      title={wants(request)}
      description="It happens only if you approve it."
      aside={
        total > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-[12px] text-muted tabular-nums">
            <IconButton label="Previous request" disabled={index === 0} onClick={() => stepApproval(-1)}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <span aria-live="polite">
              {index + 1} of {total}
            </span>
            <IconButton label="Next request" disabled={index === total - 1} onClick={() => stepApproval(1)}>
              <ChevronRight className="size-4" />
            </IconButton>
          </div>
        )
      }
      contentProps={{
        onKeyDownCapture,
        // Escape too, while arming, would put aside a dialog nobody saw.
        onEscapeKeyDown: (e) => !isArmed() && e.preventDefault(),
        onInteractOutside: (e) => e.preventDefault(),
        onOpenAutoFocus: (e) => {
          e.preventDefault();
          rejectButton.current?.focus();
        },
      }}
      footer={
        <>
          <span
            className={cx(
              "flex items-center gap-1.5 text-[12px] tabular-nums",
              expired || left < URGENT_MS ? "text-danger" : "text-muted",
            )}
          >
            <Clock className="size-3.5" />
            {expired ? "Expired" : `Expires in ${formatCountdown(left)}`}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="ghost"
              title="Answer later: it keeps waiting until it expires (Esc)"
              onClick={hideApprovals}
            >
              Later
            </Button>
            <Button
              ref={rejectButton}
              disabled={answering}
              // A key press (detail 0) counts only once armed; a click always does.
              onClick={(e) => (e.detail > 0 || isArmed()) && void answer(false)}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              data-approve
              // Red when it takes away what is written.
              className={cx(destroys && "bg-danger")}
              disabled={answering || expired || !isArmed()}
              onClick={() => isArmed() && void answer(true)}
            >
              <Check className="size-3.5" />
              Approve
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <dl className="grid grid-cols-[64px_1fr] items-baseline gap-x-3 gap-y-1.5 text-[12.5px]">
          <Row label="Client">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-fg">{request.clientName}</span>
              <span className="flex items-center gap-1 text-[11.5px] text-success" title="Its token is registered in Itztli">
                <ShieldCheck className="size-3.5" /> Verified token
              </span>
              {reportedBy && (
                <span className="text-[11.5px] text-subtle">
                  Reported by the client, unverified: <bdi className="selectable text-muted">{reportedBy}</bdi>
                </span>
              )}
            </span>
          </Row>
          <Row label="Note">
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span className="text-muted">{request.vaultName} /</span>
              <bdi className="selectable font-medium text-fg">{request.path}</bdi>
              {request.to && (
                <>
                  <ArrowRight className="size-3.5 text-subtle" />
                  <bdi className="selectable font-medium text-fg">{request.to}</bdi>
                </>
              )}
            </span>
          </Row>
          {request.reason && (
            <Row label="Reason">
              <bdi className="selectable text-fg">“{request.reason}”</bdi>
              <span className="text-[11.5px] text-subtle"> · given by the client</span>
            </Row>
          )}
          {request.affected.length > 0 && (
            <Row label="Links">
              <Affected request={request} />
            </Row>
          )}
        </dl>

        {request.warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {request.warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {WARNING_LABEL[warning]}
              </li>
            ))}
          </ul>
        )}

        <Text request={request} />
      </div>
    </Modal>
  );
}

/** Notes whose links the change rewrites, or breaks. */
function Affected({ request }: { request: ApprovalRequest }) {
  const { affected, action } = request;
  const more = affected.length - NAMED;
  return (
    <span className="text-muted">
      {action === "move" ? "Rewritten in " : "Broken in "}
      <bdi className="selectable text-fg">{affected.slice(0, NAMED).join(", ")}</bdi>
      {more > 0 && ` and ${more} more`}
    </span>
  );
}

/** What the note says, would say, or both next to each other. */
function Text({ request }: { request: ApprovalRequest }) {
  const { before, after } = request;
  if (before === null && after === null) return null;
  return (
    <div>
      <div className={cx("mb-1.5 text-[12px] font-medium text-muted", before !== null && after !== null && "grid grid-cols-2")}>
        {before !== null && <span>{after === null ? "What goes to the trash" : "Now"}</span>}
        {after !== null && <span>{before === null ? "The new note" : "If you approve"}</span>}
      </div>
      <div className="max-h-[min(440px,46vh)] overflow-auto rounded-md border border-border bg-panel" role="region" aria-label="Change to approve">
        {before !== null && after !== null ? <Diff before={before} after={after} /> : <NoteText text={after ?? before ?? ""} />}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-right text-[12px] text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
