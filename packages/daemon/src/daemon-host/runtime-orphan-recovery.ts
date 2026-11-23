import type { DispatchTerminalOutcome } from "./dispatch-stream.ts";
import { runtimeSessionIdFromActor, sameWriteSource, sha256Text } from "@harness-anything/kernel";
import {
  orphanRuntimeLeaseStop,
  type OrphanRuntimeRecoveryAudit,
} from "@harness-anything/kernel/internal/domain/orphan-runtime-recovery.ts";
import type { RepoCellActionContext, RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import {
  observeRuntimeDispatchOwnerGroup,
  readRuntimeDispatchOwnerEvidence,
} from "./runtime-dispatch-owner-evidence.ts";

import { readOrphanRuntimeRecoveryAuthority } from "./runtime-online-binding.ts";

/** Read directory authority only for an explicit foreign RuntimeSession lease release. */
export async function prepareOrphanRuntimeLeaseRelease(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<RepoCellBinding> {
  const isTaskRelease =
    action.kind === "task-release" && action.forceTakeover === true && typeof action.taskId === "string";
  const isPeerTakeover =
    action.kind === "peer-takeover" &&
    typeof action.targetId === "string" &&
    typeof action.reason === "string" &&
    action.reason.trim().length > 0;
  if (!isTaskRelease && !isPeerTakeover) return binding;
  const targetTaskId = isTaskRelease ? (action.taskId as string) : (action.targetId as string);
  const reason = cell.requiredCellText(action.reason, "reason").trim(),
    lease = cell.projection.read(targetTaskId).snapshot.lease;
  if (!lease || lease.actor.principal.personId === binding.actor.principal.personId) return binding;
  const runtimeSessionId = runtimeSessionIdFromActor(lease.actor);
  if (!runtimeSessionId) return binding;
  const dispatch = cell.projection.readRuntimeDispatch(runtimeSessionId);
  if (
    !dispatch ||
    dispatch.actor.principal.personId !== lease.actor.principal.personId ||
    !sameWriteSource(lease.source, dispatch.source)
  )
    return binding;
  const read = cell.projection.readDispatchLifecycle({ by: "session", runtimeSessionId }),
    outcome = cell.projection
      .readRuntimeSessionEventsByType(runtimeSessionId, ["runtime_session_outcome_observed"])
      .findLast((event) => event.type === "runtime_session_outcome_observed"),
    stop = orphanRuntimeLeaseStop(lease, read.status === "ready" ? read.rows[0] : undefined, outcome);
  if (stop === null) return binding;
  if (dispatch.source === "local") {
    const pid = readRuntimeDispatchOwnerEvidence(cell.projection, runtimeSessionId)?.processGroupPid ?? null;
    if (observeRuntimeDispatchOwnerGroup(cell.rootDir, dispatch.payload.dispatchId, pid) === "running") return binding;
  }
  const audit = await readOrphanRuntimeRecoveryAuthority(
    cell.input.repoId,
    binding,
    lease.actor.principal.personId,
    reason,
  );
  return audit === null ? binding : { ...binding, orphanRecovery: { dispatchId: dispatch.payload.dispatchId, audit } };
}

/** Keep the provider's recorded outcome and include the recovery audit in its accepted result. */
export function auditedOrphanTerminal(
  terminal: DispatchTerminalOutcome,
  audit: OrphanRuntimeRecoveryAudit,
): DispatchTerminalOutcome {
  const body = `${terminal.body}\n\nOrphan runtime recovery: ${JSON.stringify(audit)}`,
    sha256 = sha256Text(body);
  return {
    ...terminal,
    body,
    payload: {
      ...terminal.payload,
      resultRef: `artifact:runtime-result/sha256/${sha256}`,
      result: {
        sha256,
        size: Buffer.byteLength(body),
        mediaType: terminal.payload.result?.mediaType ?? "text/plain; charset=utf-8",
      },
    },
  };
}
