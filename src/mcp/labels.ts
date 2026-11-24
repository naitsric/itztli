import type { Action, ApprovalRequest, Decision, Transport, Warning } from "./api";
import { displayName } from "../vault/paths";

/** What a client wants to do, as the approval dialog's title says it. */
const WANTS: Record<Action, string> = {
  create: "create a note",
  edit: "change a note",
  move: "move a note",
  delete: "delete a note",
};

export function wants(request: Pick<ApprovalRequest, "clientName" | "action" | "path">): string {
  return `${request.clientName} wants to ${WANTS[request.action]}: ${displayName(request.path)}`;
}

/** Why a change deserves a second look. */
export const WARNING_LABEL: Record<Warning, string> = {
  removesMost: "Most of what the note says goes away.",
  breaksLinks: "Other notes link to it. Their links will lead nowhere.",
};

/** A decision, as the Activity log's badge says it. */
export const DECISION_LABEL: Record<Decision, string> = {
  allowed: "Allowed",
  approved: "Approved",
  rejected: "Rejected",
  denied: "Denied",
  timeout: "Timed out",
  withdrawn: "Withdrawn",
};

/**
 * How a decision reads at a glance: calls that just ran stay quiet, changes
 * the user approved are green, refusals red, and requests nobody answered
 * amber.
 */
export const DECISION_TONE: Record<Decision, "neutral" | "success" | "danger" | "warning"> = {
  allowed: "neutral",
  approved: "success",
  rejected: "danger",
  denied: "danger",
  timeout: "warning",
  withdrawn: "warning",
};

/** What a decision meant for the call, in the Activity detail. */
export const DECISION_HINT: Record<Decision, string> = {
  allowed: "Ran without asking: reading needs no approval.",
  approved: "Approved in Itztli.",
  rejected: "Rejected in Itztli: the change was not made.",
  denied: "Refused without asking: no access, or a change that could not be made.",
  timeout: "Nobody answered in time: the change was not made.",
  withdrawn: "Withdrawn while it waited for approval: the client gave up, lost its access or the server stopped.",
};

/** How a client reached the server. */
export const TRANSPORT_LABEL: Record<Transport, string> = {
  http: "HTTP",
  bridge: "stdio bridge",
};
