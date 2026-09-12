import type { DecisionProjectionRow, GuiActionResult, ProjectionWarning } from "../api/renderer-dto.ts";
import { readGuiActionResult } from "./command-receipt.ts";
import { daemonBridgeError } from "./daemon-startup.ts";
import { isRendererRecord } from "./result-validation.ts";

export interface DecisionListSuccess {
  readonly ok: true;
  readonly decisions: ReadonlyArray<DecisionProjectionRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

/**
 * `repo.decisions.list {projection:"summary"}` row: the fields the overview's decision
 * stream renders and sorts. It deliberately excludes claims, consents, and body; opening
 * a row reads that one complete decision separately.
 */
export interface DecisionSummaryRow {
  readonly decisionId: string;
  readonly title: string;
  readonly state: DecisionProjectionRow["state"];
  readonly riskTier: DecisionProjectionRow["riskTier"];
  readonly urgency: DecisionProjectionRow["urgency"];
  readonly proposedAt: DecisionProjectionRow["proposedAt"];
}

export interface DecisionSummaryListSuccess {
  readonly ok: true;
  readonly projection: "summary";
  readonly decisions: ReadonlyArray<DecisionSummaryRow>;
  readonly warnings: ReadonlyArray<ProjectionWarning>;
}

export interface DecisionControlListSuccess {
  readonly status: "ready" | "pending";
  readonly decisionIds: ReadonlyArray<string>;
  readonly opId: string;
  readonly hint?: string;
}

export interface DecisionShowSuccess {
  readonly status: "ready" | "pending";
  readonly decision: DecisionProjectionRow;
  readonly hint: string | null;
}

export interface DecisionProposalInput {
  readonly title: string;
  readonly question: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly vertical: string;
  readonly preset: string;
  readonly decisionClass: "ordinary" | "standing_policy";
  readonly appliesTo: { readonly modules: readonly string[]; readonly productLines: readonly string[] };
  readonly chosen: ReadonlyArray<{ readonly id: string; readonly text: string; readonly rationale?: string }>;
  readonly rejected: ReadonlyArray<{ readonly id: string; readonly text: string; readonly whyNot: string }>;
  readonly body: string;
  readonly claims: ReadonlyArray<{ readonly id: string; readonly text: string; readonly loadBearing: boolean }>;
  readonly fulfillments: ReadonlyArray<{
    readonly claimId: string;
    readonly mode: "evidenced" | "delivered" | "standing_policy";
  }>;
}

function decisionReadError(value: unknown): Error {
  const error = daemonBridgeError(
    value,
    "GUI/daemon decision response shape mismatch; reload the GUI with the matching daemon build.",
  );
  return new Error(`Decision read failed [${error.code ?? "daemon_decision_result_invalid"}]: ${error.message}`);
}

export function readDecisionListResult(value: unknown): DecisionListSuccess {
  const result = value as Partial<DecisionListSuccess>;
  if (
    !result ||
    result.ok !== true ||
    !Array.isArray(result.decisions) ||
    !result.decisions.every(isDecisionProjectionRow)
  ) {
    throw decisionReadError(value);
  }
  return {
    ok: true,
    decisions: result.decisions,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

/** Summary rows are a different wire shape than `decision-row/v1`; never filter them
 *  through `isDecisionProjectionRow`, which would silently drop every row. */
export function readDecisionSummaryListResult(value: unknown): DecisionSummaryListSuccess {
  const result = value as Partial<DecisionSummaryListSuccess>;
  const rows = result?.decisions;
  if (
    !result ||
    result.ok !== true ||
    result.projection !== "summary" ||
    !Array.isArray(rows) ||
    !rows.every(isDecisionSummaryRow)
  ) {
    throw decisionReadError(value);
  }
  return {
    ok: true,
    projection: "summary",
    decisions: rows,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
}

function isDecisionSummaryRow(value: unknown): value is DecisionSummaryRow {
  if (!isRendererRecord(value)) return false;
  return (
    typeof value.decisionId === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    (value.riskTier === "low" || value.riskTier === "medium" || value.riskTier === "high") &&
    (value.urgency === "low" || value.urgency === "medium" || value.urgency === "high") &&
    typeof value.proposedAt === "string"
  );
}

export function readDecisionControlList(value: unknown): DecisionControlListSuccess {
  const receipt = readGuiActionResult(value) as GuiActionResult & {
    readonly evidence?: string;
    readonly nextAction?: string;
    readonly error?: { readonly code?: string; readonly hint?: string };
  };
  if (receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate")
    throw new Error(
      `${receipt.error?.code ?? receipt.outcome}: ${
        receipt.error?.hint ?? receipt.nextAction ?? "Decision list failed."
      }`,
    );
  try {
    const evidence = JSON.parse(receipt.evidence ?? "") as { readonly status?: unknown; readonly decisions?: unknown };
    if ((evidence.status !== "ready" && evidence.status !== "pending") || !Array.isArray(evidence.decisions))
      throw new Error();
    const decisionIds = evidence.decisions.flatMap((item) =>
      isRendererRecord(item) && typeof item.decisionId === "string" ? [item.decisionId] : [],
    );
    return {
      status: evidence.status,
      decisionIds,
      opId: receipt.opId,
      ...(receipt.nextAction ? { hint: receipt.nextAction } : {}),
    };
  } catch {
    throw new Error("Decision list receipt evidence is invalid.");
  }
}

export function readDecisionShowResult(value: unknown): DecisionShowSuccess {
  const receipt = readGuiActionResult(value) as GuiActionResult & {
    readonly evidence?: string;
    readonly nextAction?: string;
    readonly error?: { readonly code?: string; readonly hint?: string };
  };
  if (receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate") {
    const detail = receipt.error?.hint ?? receipt.nextAction ?? "Decision show failed.";
    throw new Error(`${receipt.error?.code ?? receipt.outcome}: ${detail}`);
  }
  try {
    const evidence = JSON.parse(receipt.evidence ?? "") as { readonly status?: unknown; readonly decision?: unknown };
    if ((evidence.status !== "ready" && evidence.status !== "pending") || !isDecisionProjectionRow(evidence.decision))
      throw new Error();
    return { status: evidence.status, decision: evidence.decision, hint: receipt.nextAction ?? null };
  } catch {
    throw new Error("Decision show receipt evidence is invalid.");
  }
}

function isDecisionProjectionRow(value: unknown): value is DecisionProjectionRow {
  return (
    isRendererRecord(value) &&
    value.schema === "decision-row/v1" &&
    typeof value.decisionId === "string" &&
    typeof value.title === "string" &&
    typeof value.state === "string" &&
    Number.isInteger(value.workspaceRevision) &&
    Array.isArray(value.claims)
  );
}
