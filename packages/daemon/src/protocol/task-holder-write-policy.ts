import {
  isTaskHolderError,
  taskStatusLeaseRequired,
  taskHolderPrincipalFromActor,
  type TaskHolderService
} from "@harness-anything/application";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { JsonRpcMethodContract } from "./method-registry.ts";
import { failureReceipt } from "./receipt-envelope.ts";
import { readTaskHolderExecutor } from "./task-holder-payload.ts";
import type { JsonObject } from "./json-rpc-types.ts";
import { toJsonValue } from "./json-value.ts";

interface TaskLeaseRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

interface TaskLeaseServices {
  readonly TaskHolderService?: TaskHolderService;
}

interface TaskLeaseOptions {
  readonly leaseEnforcementEnabled?: (repo: TaskLeaseRepo) => boolean;
}

export async function validateTaskLeaseForServiceWrite(
  contract: JsonRpcMethodContract,
  payload: JsonObject | undefined,
  services: TaskLeaseServices,
  actor: AuthenticatedActor | undefined,
  repo: TaskLeaseRepo | undefined,
  options: TaskLeaseOptions
): Promise<ReturnType<typeof failureReceipt> | undefined> {
  if (!repo || !options.leaseEnforcementEnabled?.(repo) || contract.leaseRequired !== true) return undefined;
  if (contract.method === "repo.tasks.status.set" && !taskStatusLeaseRequired(payload?.status)) return undefined;
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
  if (!taskId) return failureReceipt(contract.method, "task_id_required", "Required payload.taskId is missing from the raw RPC request, so lease enforcement did not run. Supply the intended concrete task id in payload.taskId and retry the same RPC; no task state was changed.");
  if (!services.TaskHolderService) {
    return failureReceipt(contract.method, "task_holder_service_unavailable", "Task holder service is absent from the running composition. Run `ha daemon logs --errors --json` to capture the missing service. Leave the daemon and current lease state unchanged; retry only after an operator verifies a replacement composition.");
  }
  if (!actor) return failureReceipt(contract.method, "actor_required", `Task lease enforcement requires a per-request authenticated actor, but this request has none. Run \`ha task holder ${taskId} --json\` through an authenticated CLI session, then retry the original command only if the holder state permits it.`);
  try {
    const executor = readTaskHolderExecutor(payload);
    await services.TaskHolderService.assertActiveLease({ taskId, principal: taskHolderPrincipalFromActor(actor, { executor }) });
    return undefined;
  } catch (error) {
    if (isTaskHolderError(error)) {
      return failureReceipt(contract.method, error.code, error.message, taskHolderErrorDetails(error));
    }
    return failureReceipt(contract.method, "task_holder_failed", `Task holder validation failed unexpectedly: ${error instanceof Error ? error.message : String(error)}. Inspect daemon diagnostics with \`ha daemon logs --errors --json\`, then retry the original command.`);
  }
}

export function taskHolderErrorDetails(error: {
  readonly code: string;
  readonly taskId: string;
  readonly holder?: unknown;
  readonly principal?: unknown;
  readonly leaseExpiresAt?: string | null;
  readonly orphan?: boolean;
}): JsonObject {
  return {
    taskId: error.taskId,
    code: error.code,
    ...(error.holder ? { holder: toJsonValue(error.holder) } : {}),
    ...(error.principal ? { principal: toJsonValue(error.principal) } : {}),
    leaseExpiresAt: error.leaseExpiresAt ?? null,
    ...(typeof error.orphan === "boolean" ? { orphan: error.orphan } : {})
  };
}
