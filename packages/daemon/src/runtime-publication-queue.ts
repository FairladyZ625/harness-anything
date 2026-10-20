import { assertCurrentWriter, attachReceiptAcceptance, type WriteReceipt } from "@harness-anything/kernel";
import { commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { evaluateRepoCellAction, bindVerifiedExecutorClaim } from "./repo-cell-authorization.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { chainRepoCellWrite } from "./repo-cell.ts";
import { admitRepoMode } from "./repo-mode.ts";

function mayRescueInfrastructureLatch(
  context: RepoCellApiContext,
  commandKind: "runtime-run" | "runtime-cancel" | "runtime-steer" | "runtime-handoff-claim",
  policyAction: RepoTaskAction,
  binding: RepoCellBinding,
): boolean {
  if (
    context.state === "attached" ||
    context.recoveryUncertain ||
    context.causeClass !== "infrastructure" ||
    commandKind !== "runtime-run" ||
    policyAction.kind !== "runtime-spawn" ||
    policyAction.taskId != null ||
    binding.source !== "local"
  )
    return false;
  const cut = context.projection.readCut(),
    revision = context.store.readHead()?.revision ?? 0;
  return cut.status === "ready" && cut.watermark === revision && cut.sourceRevision === revision;
}

// Spawn, cancellation, and runtime ingress share this writer-fenced publication boundary.
export function enqueueRuntimePublication(
  context: RepoCellApiContext,
  commandKind: "runtime-run" | "runtime-cancel" | "runtime-steer" | "runtime-handoff-claim",
  policyAction: RepoTaskAction,
  binding: RepoCellBinding,
  execute: (authorizedBinding: RepoCellBinding, revision: number) => JsonObject | Promise<JsonObject>,
): Promise<JsonObject> {
  const command = commandDescriptorForAction(commandKind),
    admission = admitRepoMode(context.mode, command, binding.source);
  if (!admission.ok) return Promise.reject(context.cellCodedError(admission.code, admission.nextAction));
  context.queueDepth += 1;
  const pending = chainRepoCellWrite(context.tail, async () => {
    context.queueDepth -= 1;
    const rescueLatch = mayRescueInfrastructureLatch(context, commandKind, policyAction, binding);
    if (context.state !== "attached" && !rescueLatch) await context.attemptRecovery();
    const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
    if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
    if (context.state !== "attached" && !rescueLatch)
      throw context.cellCodedError("repo_unavailable", context.latched());
    assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
    // An executor claim is verified at the same writer cut that authorizes and executes it.
    const claimed = bindVerifiedExecutorClaim({
        action: policyAction,
        binding,
        projection: context.projection,
        now: context.now(),
      }),
      revision = context.store.readHead()?.revision ?? 0,
      authorizationDecision = await evaluateRepoCellAction({
        ...claimed,
        actionId: context.operationId(claimed.action, claimed.binding, context.input.repoId, revision),
        repoId: context.input.repoId,
        revision,
        now: context.now(),
      });
    if (authorizationDecision.outcome === "denied")
      throw Object.assign(new Error(authorizationDecision.nextActions.join(" ")), {
        code: "authorization_denied",
        authorizationDecision,
      });
    context.activeWriterEpochFence = binding.withWriterEpochFence ?? null;
    context.activeWriterEpochFenceDescriptor = binding.writerEpochFence ?? null;
    try {
      const result = await execute({ ...claimed.binding, authorizationDecision }, revision);
      const receipt =
        typeof result.opId === "string" && typeof result.outcome === "string"
          ? attachReceiptAcceptance(result as unknown as WriteReceipt, context.store, context.projection)
          : result;
      return {
        ...receipt,
        authorizationDecision: authorizationDecision as unknown as JsonObject,
      } as unknown as JsonObject;
    } finally {
      context.activeWriterEpochFence = null;
      context.activeWriterEpochFenceDescriptor = null;
    }
  });
  context.tail = pending.then(
    () => undefined,
    () => undefined,
  );
  void pending.then(
    () => context.replica.kick(),
    () => context.replica.kick(),
  );
  return pending;
}
