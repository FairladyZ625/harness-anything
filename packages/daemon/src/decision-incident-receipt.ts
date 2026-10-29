import type { TaskDispatchDecisionAction } from "./protocol/task-dispatch-contract.ts";

type SettledIncidentAction = Extract<TaskDispatchDecisionAction, { readonly status: "applied" | "failed" }>;
import { appendRuntimeWorkerRecord, readDispatchStreamSummary } from "./dispatch-stream.ts";

/** The dispatch-stream record kind that carries one incident disposition. It lives on the source
 * dispatch's own durable stream — the same per-dispatch record store that already carries
 * settlement — so the receipt outlives annotation-store retention and is projected by the
 * canonical dispatch read instead of a second ledger. */
export const incidentActionRecordKind = "decision_action";

const budgetSources = new Set(["task", "repository", "daemon"]);
const actions = new Set(["resume", "rerun", "needs_attention", "no_action"]);
const statuses = new Set(["claimed", "applied", "failed"]);

/** Append the pre-action fence (`claimed`) or its settlement (`applied`/`failed`). The summary keeps
 * the last record, so one dispatch carries exactly one visible disposition. */
export function appendIncidentActionReceipt(
  rootDir: string,
  dispatchId: string,
  receipt: TaskDispatchDecisionAction,
): void {
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: incidentActionRecordKind, ...receipt });
}

/** The disposition recorded for a dispatch, read through the same bounded summary the canonical
 * dispatch row already builds. `null` means the daemon never fenced or executed an action here. */
export function readIncidentActionReceipt(rootDir: string, dispatchId: string): TaskDispatchDecisionAction | null {
  const record = readDispatchStreamSummary(rootDir, dispatchId)?.decisionActionRecord;
  return record === null || record === undefined ? null : incidentActionFromRecord(record);
}

/** The continuation budget already consumed by this task's current no-progress streak, read from
 * the canonical dispatch receipts rather than the retention-capped local annotation file. Every
 * applied disposition records the streak it ended on, not only resume/rerun: a progressing stop
 * that escalated or did nothing must still persist the reset, otherwise the next no-progress stop
 * would inherit a streak the worktree already disproved. The newest receipt with a recorded budget
 * is the whole durable state; a measured worktree HEAD change resets it before the gate reads it.
 * A receipt with no budget (an owner dismissal) and a task with no receipt start at zero. Receipts
 * written before the streak was recorded carry the old pre-action lifetime count, so the reader
 * treats that number as a conservative streak estimate; it converges as new receipts are written.
 * A `claimed` fence carries no streak and is ignored. */
export function incidentContinuationUsed(
  rows: readonly { readonly decisionAction?: TaskDispatchDecisionAction }[],
  progressed: boolean,
): number {
  if (progressed) return 0;
  let latest: SettledIncidentAction | null = null;
  for (const row of rows) {
    const action = row.decisionAction;
    if (action?.status !== "applied" || action.budget === null) continue;
    if (latest === null || action.decidedAt > latest.decidedAt) latest = action;
  }
  return latest?.budget?.used ?? 0;
}

/** Validate one stored record into the public row shape. A vocabulary value this daemon never
 * writes is not a receipt, so it is dropped instead of surfacing a half-typed action. */
export function incidentActionFromRecord(record: Readonly<Record<string, unknown>>): TaskDispatchDecisionAction | null {
  const action = String(record.action),
    status = String(record.status);
  if (
    typeof record.pointId !== "string" ||
    typeof record.questionVersion !== "string" ||
    typeof record.decidedAt !== "string" ||
    !statuses.has(status)
  )
    return null;
  if (status === "claimed")
    return {
      pointId: record.pointId,
      questionVersion: record.questionVersion,
      status: "claimed",
      decidedAt: record.decidedAt,
    };
  if (
    !actions.has(action) ||
    typeof record.selected !== "string" ||
    (record.reason !== null && typeof record.reason !== "string") ||
    (record.successorDispatchId !== null && typeof record.successorDispatchId !== "string")
  )
    return null;
  const budget = record.budget,
    attention = incidentAttention(action, record);
  if (budget !== null && !validBudget(budget)) return null;
  if (attention === undefined) return null;
  return {
    pointId: record.pointId,
    questionVersion: record.questionVersion,
    status: status as "applied" | "failed",
    selected: record.selected,
    action: action as "resume" | "rerun" | "needs_attention" | "no_action",
    attention,
    reason: (record.reason ?? null) as string | null,
    successorDispatchId: (record.successorDispatchId ?? null) as string | null,
    budget: (budget ?? null) as SettledIncidentAction["budget"],
    decidedAt: record.decidedAt,
  };
}

/** The owner's explicit close of one escalated incident receipt: the visible disposition becomes
 * `no_action` carrying the owner's reason, on the same durable record the automatic disposition
 * used. Idempotent by the summary's last-record-wins projection — concurrent closes from several
 * edge nodes all land as a settled no_action. */
export type IncidentDismissOutcome =
  | { readonly settled: "dismissed" }
  | { readonly settled: "already_settled" }
  | { readonly settled: "missing" }
  | { readonly settled: "claimed" };

export function dismissIncidentActionReceipt(
  rootDir: string,
  dispatchId: string,
  reason: string,
  decidedAt: string,
): IncidentDismissOutcome {
  const receipt = readIncidentActionReceipt(rootDir, dispatchId);
  if (receipt === null) return { settled: "missing" };
  if (receipt.status === "claimed") return { settled: "claimed" };
  if (receipt.action !== "needs_attention") return { settled: "already_settled" };
  appendIncidentActionReceipt(rootDir, dispatchId, {
    pointId: receipt.pointId,
    questionVersion: receipt.questionVersion,
    status: "applied",
    selected: "no_action",
    action: "no_action",
    attention: null,
    reason,
    successorDispatchId: null,
    budget: null,
    decidedAt,
  });
  return { settled: "dismissed" };
}

/** A settled action's owner-attention kind. `undefined` means a stored value this daemon never
 * writes; `null` means the action cannot need owner attention. Receipts written before the field
 * existed are mapped once here, at the boundary both readers share. */
function incidentAttention(
  action: string,
  record: Readonly<Record<string, unknown>>,
): "question" | "guard" | null | undefined {
  const stored = record.attention;
  if (stored !== undefined && stored !== null && stored !== "question" && stored !== "guard") return undefined;
  if (action !== "needs_attention") return null;
  if (stored === "question" || stored === "guard") return stored;
  // The old writer used `question:` for both real asks and guard refusals. Preserve the legacy
  // question reading here rather than making every historical ask disappear from the ruling queue.
  return typeof record.reason === "string" && record.reason.startsWith("question:") ? "question" : "guard";
}

function validBudget(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const budget = value as { readonly used?: unknown; readonly limit?: unknown; readonly source?: unknown };
  return (
    Number.isSafeInteger(budget.used) &&
    Number(budget.used) >= 0 &&
    Number.isSafeInteger(budget.limit) &&
    budgetSources.has(String(budget.source))
  );
}
