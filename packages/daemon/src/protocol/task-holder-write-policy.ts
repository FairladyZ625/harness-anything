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
  if (!taskId) return failureReceipt(contract.method, "task_id_required", "Task lease enforcement requires payload.taskId.");
  if (!services.TaskHolderService) {
    return failureReceipt(contract.method, "task_holder_service_unavailable", "Task holder service is not configured.");
  }
  if (!actor) return failureReceipt(contract.method, "actor_required", "Task lease enforcement requires a per-request authenticated actor.");
  try {
    const executor = readTaskHolderExecutor(payload);
    await services.TaskHolderService.assertActiveLease({ taskId, principal: taskHolderPrincipalFromActor(actor, { executor }) });
    return undefined;
  } catch (error) {
    if (isTaskHolderError(error)) {
      return failureReceipt(contract.method, error.code, error.message, taskHolderErrorDetails(error));
    }
    return failureReceipt(contract.method, "task_holder_failed", error instanceof Error ? error.message : String(error));
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
