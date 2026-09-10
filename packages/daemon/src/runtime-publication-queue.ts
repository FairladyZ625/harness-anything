import { assertCurrentWriter, attachReceiptAcceptance, type WriteReceipt } from "../../kernel/src/index.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import { authorizeRepoCellAction, bindVerifiedExecutorClaim } from "./repo-cell-authorization.ts";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { chainRepoCellWrite } from "./repo-cell.ts";
import { admitRepoMode } from "./repo-mode.ts";

// Spawn, cancellation, and runtime ingress share this writer-fenced publication boundary.
export function enqueueRuntimePublication(
  context: RepoCellApiContext,
  commandKind: "runtime-run" | "runtime-cancel",
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
    if (context.state !== "attached") await context.attemptRecovery();
    const queuedAdmission = admitRepoMode(context.mode, command, binding.source);
    if (!queuedAdmission.ok) throw context.cellCodedError(queuedAdmission.code, queuedAdmission.nextAction);
    if (context.state !== "attached") throw context.cellCodedError("repo_unavailable", context.latched());
    assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
    // An executor claim is verified at the same writer cut that authorizes and executes it.
    const claimed = bindVerifiedExecutorClaim({
        action: policyAction,
        binding,
        projection: context.projection,
        now: context.now(),
      }),
      revision = context.store.readHead()?.revision ?? 0,
      authorizationDecision = authorizeRepoCellAction({
        ...claimed,
        actionId: context.operationId(claimed.action, claimed.binding, context.input.repoId, revision),
        revision,
        now: context.now(),
      });
    if (authorizationDecision.outcome === "denied")
      throw Object.assign(new Error(authorizationDecision.nextActions.join(" ")), {
        code: "authorization_denied",
        authorizationDecision,
      });
    context.activeWriterEpochGuard = binding.assertWriterEpoch ?? null;
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
      context.activeWriterEpochGuard = null;
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
