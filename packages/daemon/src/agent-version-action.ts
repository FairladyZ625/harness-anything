import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import { readAgentDiff, readAgentHistory, readAgentVersion, type AgentVersionPorts } from "./agent-version-read.ts";

/** The named Agent version reads. They answer off the same projection cut as every other catalog
 *  read (agent-list / agent-inspect), so they are dispatched beside doctor-health instead of
 *  pretending to be Kernel action catalog entries: no write, no action contract, no fence. */
export function isAgentVersionRead(kind: string): boolean {
  return kind === "agent-history" || kind === "agent-diff" || kind === "agent-version-read";
}

export function runAgentVersionRead(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const ports: AgentVersionPorts = { projection: cell.projection, store: cell.store },
    revision = cell.projection.readCut().sourceRevision,
    opId = cell.operationId(action, binding, cell.input.repoId, revision);
  if (action.kind === "agent-history")
    return cell.readResult(
      opId,
      readAgentHistory(ports, {
        agentId: cell.requiredCellText(action.agentId, "agentId"),
        ...(action.limit === undefined ? {} : { limit: Number(action.limit) }),
        ...(typeof action.cursor === "string" ? { cursor: action.cursor } : {}),
        summaries: action.noSummary !== true,
      }),
      revision,
      null,
    ) as WriteReceipt;
  if (action.kind === "agent-diff") {
    const agentId = cell.requiredCellText(action.agentId, "agentId"),
      // --to defaults to the live declaration revision; the same read supplies it, so the
      // default cannot drift from the fence value a rollback would use.
      current = readAgentHistory(ports, { agentId, limit: 1, summaries: false }).revision;
    return cell.readResult(
      opId,
      readAgentDiff(ports, {
        agentId,
        from: Number(action.from),
        to: action.to === undefined ? current : Number(action.to),
      }),
      revision,
      null,
    ) as WriteReceipt;
  }
  return cell.readResult(
    opId,
    readAgentVersion(ports, {
      agentId: cell.requiredCellText(action.agentId, "agentId"),
      revision: Number(action.revision),
    }),
    revision,
    null,
  ) as WriteReceipt;
}
