import { taskEntityId } from "@harness-anything/kernel";
import type {
  TaskArchivePayloadV2,
  TaskDeletePayloadV2,
  TaskReopenPayloadV2,
  TaskSupersedePayloadV2
} from "./task-decision-module-command-v2.ts";
import { semanticAdmissionV2 as admission, semanticMutationPlanV2 as taskDecisionModulePlan } from "./semantic-authority-helpers-v2.ts";
import type {
  CompiledTaskDecisionModuleCommandV2,
  TaskDecisionModuleAuthorityStateV2
} from "./task-decision-module-semantic-compiler-types.ts";
import {
  taskDecisionModuleEntityRef,
  taskDecisionModulePath as taskPath
} from "./task-decision-module-refs.ts";
import {
  requiredTaskDecisionModuleDocument,
  taskCompilation
} from "./task-decision-module-task-compilation-v2.ts";
import { parseTaskIndex, sameTaskLifecycleCore } from "./task-index-v2.ts";
import { enteringExecutionWip } from "./task-wip-policy.ts";
import { taskExecutionAdmissionPublicationRevalidation, type TaskExecutionAdmissionPortsV1 } from "./task-execution-admission-policy.ts";

export async function compileTaskDisposition(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskArchivePayloadV2 | TaskDeletePayloadV2 | TaskReopenPayloadV2,
  disposition: "active" | "archived" | "tombstoned",
  kind: "package_archive" | "package_tombstone" | "package_reopen",
  executionAdmission?: TaskExecutionAdmissionPortsV1
): Promise<CompiledTaskDecisionModuleCommandV2> {
  const path = taskPath(payload.taskId, "INDEX.md");
  const snapshot = await requiredTaskDecisionModuleDocument(state, path, "TASK_INDEX_NOT_FOUND");
  const current = parseTaskIndex(snapshot.body);
  const next = parseTaskIndex(payload.body);
  if (current.taskId !== payload.taskId || next.taskId !== payload.taskId) throw admission("TASK_ID_MISMATCH");
  if (next.packageDisposition !== disposition || !sameTaskLifecycleCore(current, next)) {
    throw admission("TASK_DISPOSITION_BODY_INVALID");
  }
  if (!payload.body.includes(payload.reason)) throw admission("TASK_DISPOSITION_REASON_REQUIRED");
  const compiled = taskCompilation(payload.taskId, "document", kind, { path: "INDEX.md", body: payload.body }, [
    taskDecisionModuleEntityRef("task", `task/${payload.taskId}`)
  ], [{ path, snapshot }]);
  return enteringExecutionWip(
    current.status,
    current.packageDisposition,
    next.status,
    next.packageDisposition
  )
    ? {
      ...compiled,
      publicationRevalidation: taskExecutionAdmissionPublicationRevalidation(executionAdmission ?? {}, payload.taskId)
    }
    : compiled;
}

export async function compileTaskSupersede(
  state: TaskDecisionModuleAuthorityStateV2,
  payload: TaskSupersedePayloadV2
): Promise<CompiledTaskDecisionModuleCommandV2> {
  if (payload.body !== undefined) {
    if (!payload.replacementTaskId || payload.writes) throw admission("TASK_SUPERSEDE_PAYLOAD_INVALID");
    const compiled = await compileTaskDisposition(state, {
      schema: "task.archive/v1", taskId: payload.taskId, reason: `supersededBy=${payload.replacementTaskId}`, body: payload.body
    }, "archived", "package_archive");
    const replacementPath = taskPath(payload.replacementTaskId, "INDEX.md");
    const replacementSnapshot = await requiredTaskDecisionModuleDocument(state, replacementPath, "TASK_SUPERSEDE_TARGET_NOT_FOUND");
    return {
      ...compiled,
      requiredBaseRefs: [...compiled.requiredBaseRefs, taskDecisionModuleEntityRef("task", `task/${payload.replacementTaskId}`)],
      requiredPathSnapshots: [...compiled.requiredPathSnapshots, { path: replacementPath, snapshot: replacementSnapshot }]
    };
  }
  if (!payload.replacementTaskId || !payload.writes) throw admission("TASK_SUPERSEDE_PAYLOAD_INVALID");
  const oldPath = taskPath(payload.taskId, "INDEX.md");
  const oldSnapshot = await requiredTaskDecisionModuleDocument(state, oldPath, "TASK_INDEX_NOT_FOUND");
  const oldWrite = payload.writes.find((write) => write.taskId === payload.taskId && write.path === "INDEX.md");
  const newWrite = payload.writes.find((write) => write.taskId === payload.replacementTaskId && write.path === "INDEX.md");
  const relationWrite = payload.writes.find((write) => write.taskId === payload.replacementTaskId && write.path === "relations.md");
  if (!oldWrite || !newWrite || !relationWrite || parseTaskIndex(oldWrite.body).packageDisposition !== "archived"
    || parseTaskIndex(newWrite.body).status !== "planned"
    || !relationWrite.body.includes(`task/${payload.replacementTaskId} supersedes task/${payload.taskId}`)) {
    throw admission("TASK_SUPERSEDE_WRITES_INVALID");
  }
  // Every replacement document must be declared. An undeclared create locates
  // the package directory itself, and that bare prefix path is never covered by
  // the exact portable-path scopes minted from the observed write set.
  const replacementDocumentPaths = [...new Set(payload.writes
    .filter((write) => write.taskId === payload.replacementTaskId)
    .map((write) => write.path))].sort();
  const [replacementDocumentPath, ...additionalReplacementDocumentPaths] = replacementDocumentPaths;
  if (!replacementDocumentPath) throw admission("TASK_SUPERSEDE_WRITES_INVALID");
  return {
    mutationPlan: taskDecisionModulePlan([
      { entityKind: "task", identity: { taskId: payload.taskId }, action: "document", storageContext: { documentPath: "INDEX.md" } },
      {
        entityKind: "task",
        identity: { taskId: payload.replacementTaskId },
        action: "create",
        storageContext: { documentPath: replacementDocumentPath },
        ...(additionalReplacementDocumentPaths.length > 0 ? {
          additionalStorageContexts: additionalReplacementDocumentPaths.map((documentPath) => ({ documentPath }))
        } : {})
      }
    ]),
    operation: { opId: "authority-overrides-this", entityId: taskEntityId(payload.taskId), kind: "package_supersede", payload: { writes: payload.writes } },
    requiredBaseRefs: [taskDecisionModuleEntityRef("task", `task/${payload.taskId}`), taskDecisionModuleEntityRef("task", `task/${payload.replacementTaskId}`)],
    requiredPathSnapshots: [{ path: oldPath, snapshot: oldSnapshot }]
  };
}
