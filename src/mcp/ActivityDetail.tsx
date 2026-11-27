import { CircleAlert, FileText, History, MousePointerClick, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { NoteText } from "../dialogs/CompareDialog";
import { showLocalHistory } from "../dialogs/LocalHistoryDialog";
import { formatDuration } from "../ui/format";
import { Notice } from "../ui/Notice";
import { Button, cx } from "../ui/primitives";
import { useNow } from "../ui/useNow";
import { useVault } from "../vault/store";
import { openPath } from "../workbench/editorArea";
import { callSummary, countLabel, formatFullTime, formatLogTime, isChange, isUnasked } from "./activity";
import type { AuditEntry, Decision } from "./api";
import { DECISION_LABEL, DECISION_TONE, decisionHint, TRANSPORT_LABEL } from "./labels";
import { clientInfoLabel } from "./presence";
import { CopyButton } from "./SnippetPicker";

const TONE_CLASS: Record<(typeof DECISION_TONE)[Decision], string> = {
  neutral: "bg-active text-muted",
  success: "bg-success/15 text-success",
  danger: "bg-danger/15 text-danger",
  warning: "bg-warning/15 text-warning",
};

/** A call's decision as a small pill: quiet for what just ran, colored for everything else. */
export function DecisionBadge({ entry, className }: { entry: Pick<AuditEntry, "tool" | "decision">; className?: string }) {
  return (
    <span
      title={decisionHint(entry)}
      className={cx(
        "inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] font-medium",
        TONE_CLASS[DECISION_TONE[entry.decision]],
        className,
      )}
    >
      {DECISION_LABEL[entry.decision]}
    </span>
  );
}

/** Why a row's note can't be opened, or `null` when it can: it must be in the open vault, and still there. */
export function openBlocker(entry: Pick<AuditEntry, "path" | "vaultId" | "vaultName">): string | null {
  const { info, entries } = useVault.getState();
  if (entry.path === null) return "This call was about no note.";
  if (entry.vaultId !== info?.id) return `The vault “${entry.vaultName ?? ""}” is not open.`;
  if (!entries.has(entry.path) || entries.get(entry.path)!.folder) return "The note is no longer there.";
  return null;
}

export function openNote(entry: AuditEntry) {
  if (openBlocker(entry) === null) openPath(entry.path!);
}

/** What the detail of a call is, over its text. */
function detailTitle(entry: AuditEntry): string {
  if (entry.tool === "edit_note") return "Changes";
  if (entry.tool === "search_notes") return "Searched for";
  return isChange(entry) && entry.tool !== "move_note" ? "Text" : "Asked";
}

/** Everything recorded about one tool call, and what can be done with it. */
export function ActivityDetail({ entry }: { entry: AuditEntry | undefined }) {
  const now = useNow(60_000);
  // Whether the note can be opened changes as notes come and go.
  useVault((s) => s.structure);
  useVault((s) => s.info?.id);

  if (!entry) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-subtle">
        <MousePointerClick className="size-5" strokeWidth={1.5} />
        Select an entry to see everything recorded about it.
      </div>
    );
  }

  const blocker = openBlocker(entry);
  const reportedAs = clientInfoLabel(entry.clientInfoName, entry.clientInfoVersion);
  const { did } = callSummary(entry);
  const title = entry.path ? `${did} ${entry.path}` : did;

  return (
    <section aria-label="Activity details" className="flex h-full min-w-0 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <DecisionBadge entry={entry} />
            <h2 className="selectable truncate text-[13px] font-semibold text-fg" title={title}>
              {title}
            </h2>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-subtle">
            {entry.clientName} · <span title={formatFullTime(entry.at)}>{formatLogTime(entry.at, now)}</span>
          </p>
        </div>
        {entry.path !== null && (
          <div className="flex shrink-0 items-center gap-1">
            {/* A disabled button shows no tooltip; its wrapper does. */}
            <span title={blocker ?? "Open the note  ⏎"}>
              <Button disabled={blocker !== null} onClick={() => openNote(entry)}>
                <FileText className="size-3.5" />
                Open
              </Button>
            </span>
            {isChange(entry) && (
              <span title={blocker ?? "What the note said before"}>
                <Button disabled={blocker !== null} onClick={() => showLocalHistory(entry.path!)}>
                  <History className="size-3.5" />
                  Local History
                </Button>
              </span>
            )}
          </div>
        )}
      </header>

      {/* Keyed, so each call's details start from the top. */}
      <div key={entry.id} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {entry.error && (
          <Notice tone="danger" icon={CircleAlert}>
            <span className="selectable min-w-0 [overflow-wrap:anywhere]">{entry.error}</span>
          </Notice>
        )}
        {entry.detail !== null && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1 text-[12px] font-medium text-muted">
              {detailTitle(entry)}
              <CopyButton text={entry.detail} label="Copy" className="size-6" />
            </div>
            <div className="max-h-[220px] shrink-0 overflow-auto rounded-md border border-border">
              <NoteText text={entry.detail} />
            </div>
            {entry.detailTruncated && (
              <p className="text-[11.5px] text-warning">It was longer: only its first 100 KiB was recorded.</p>
            )}
          </div>
        )}

        <dl className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-[12px]">
          <Field label="Time">
            <Value>{formatFullTime(entry.at)}</Value>
          </Field>
          <Field label="Decision">
            <span className="text-fg">{DECISION_LABEL[entry.decision]}</span>
            <span className="text-muted"> · {decisionHint(entry)}</span>
          </Field>
          <Field label="Client">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium text-fg">{entry.clientName}</span>
              <span className="flex items-center gap-1 text-[11.5px] text-success" title="Its token is registered in Itztli">
                <ShieldCheck className="size-3.5" /> Verified token
              </span>
            </span>
          </Field>
          <Field label="Reported as">
            {reportedAs ? (
              <>
                <span className="selectable text-fg">{reportedAs}</span>
                <span className="text-subtle"> · unverified, as the client says</span>
              </>
            ) : (
              <None />
            )}
          </Field>
          <Field label="Vault">{entry.vaultName ? <Value>{entry.vaultName}</Value> : <None />}</Field>
          <Field label="Note">{entry.path ? <Value>{entry.path}</Value> : <None />}</Field>
          <Field label="Tool">
            <span className="font-mono text-[11.5px] text-fg">{entry.tool}</span>
          </Field>
          {entry.reason !== null && (
            <Field label="Reason">
              <span className="selectable text-fg">“{entry.reason}”</span>
              <span className="text-subtle"> · given by the client</span>
            </Field>
          )}
          <Field label="Approval wait">
            {entry.approvalWaitMs !== null ? (
              <Value>{formatDuration(entry.approvalWaitMs)}</Value>
            ) : isUnasked(entry) ? (
              <span className="text-fg">Not asked</span>
            ) : (
              <None />
            )}
          </Field>
          <Field label="Elapsed">{entry.elapsedMs !== null ? <Value>{formatDuration(entry.elapsedMs)}</Value> : <None />}</Field>
          <Field label="Returned">
            {countLabel(entry) !== null ? <Value>{countLabel({ ...entry, truncated: false })}</Value> : <None />}
            {entry.truncated && <span className="text-warning"> · cut short</span>}
          </Field>
          <Field label="Transport">
            <Value>{TRANSPORT_LABEL[entry.transport]}</Value>
          </Field>
          <Field label="Protocol">{entry.protocolVersion ? <Value>{entry.protocolVersion}</Value> : <None />}</Field>
          <Field label="Session">
            {entry.sessionKey ? (
              <span className="selectable font-mono text-[11.5px] break-all text-fg">{entry.sessionKey}</span>
            ) : (
              <None />
            )}
          </Field>
          <Field label="Entry">
            <Value>#{entry.id}</Value>
          </Field>
        </dl>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-right text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <span className="selectable text-fg tabular-nums">{children}</span>;
}

function None() {
  return <span className="text-subtle">—</span>;
}
