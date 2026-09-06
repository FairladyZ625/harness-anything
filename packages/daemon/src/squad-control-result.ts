import { isJsonObject } from "./protocol/json-rpc-types.ts";
import { isSquadControlResult } from "./protocol/daemon-protocol-validate-results.ts";
export { isSquadControlResult };
import type { WriteReceiptDraft } from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellRuntimeContext } from "./repo-cell-action-context.ts";

export type SquadControlCommand = "squad-run" | "squad-cancel";
type AcceptanceKeys =
  | "opId"
  | "proof"
  | "acceptance"
  | "status"
  | "projection"
  | "git"
  | "worktree"
  | "replica"
  | "wait"
  | "revision"
  | "cut"
  | "commitSha";
export type SquadControlResult = Partial<Omit<WriteReceiptDraft, AcceptanceKeys | "outcome">> & {
  readonly schema: "squad-control-result/v1";
  readonly command: SquadControlCommand;
  readonly outcome: "completed" | "op_rejected";
  readonly squadRunId?: string;
  readonly leaderRuntimeSessionId?: string;
  readonly phase?: string;
  readonly summary: string;
} & { readonly [K in AcceptanceKeys]?: never };

export function isSquadControlCommand(kind: string): kind is SquadControlCommand {
  return kind === "squad-run" || kind === "squad-cancel";
}
export function squadControlRejected(command: SquadControlCommand, receipt: WriteReceiptDraft): SquadControlResult {
  return {
    schema: "squad-control-result/v1",
    command,
    outcome: "op_rejected",
    code: receipt.code ?? "squad_control_failed",
    summary: receipt.rejectionExplanation ?? receipt.evidence ?? "Squad control failed.",
    ...(receipt.authorizationDecision ? { authorizationDecision: receipt.authorizationDecision } : {}),
    nextActions: receipt.nextActions ?? [],
    unmetCriteria: receipt.unmetCriteria ?? [],
  };
}
export async function executeSquadControl(
  cell: RepoCellRuntimeContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<SquadControlResult> {
  if (!isSquadControlCommand(action.kind)) throw new Error("not a Squad control command");
  const payload = Object.fromEntries(Object.entries(action).filter(([, value]) => value !== undefined));
  if (!isJsonObject(payload)) throw cell.cellCodedError("invalid_command", "Squad control requires JSON input.");
  const raw =
    action.kind === "squad-run"
      ? await cell.squadCoordinator.start(payload, binding)
      : await cell.squadCoordinator.cancel(cell.requiredCellText(action.squadRunId, "squadRunId"), binding);
  return {
    schema: "squad-control-result/v1",
    command: action.kind,
    outcome: "completed",
    squadRunId: cell.requiredCellText(raw.squadRunId, "squadRunId"),
    ...(typeof raw.leaderRuntimeSessionId === "string" ? { leaderRuntimeSessionId: raw.leaderRuntimeSessionId } : {}),
    phase: cell.requiredCellText(raw.status, "status"),
    summary: cell.requiredCellText(raw.summary, "summary"),
    evidence: JSON.stringify(raw),
    ...(binding.authorizationDecision ? { authorizationDecision: binding.authorizationDecision } : {}),
  };
}
