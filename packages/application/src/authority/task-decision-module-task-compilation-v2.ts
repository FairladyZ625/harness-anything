import { taskEntityId, type WriteOpKind } from "@harness-anything/kernel";
import { semanticAdmissionV2 as admission, semanticMutationPlanV2 as taskDecisionModulePlan } from "./semantic-authority-helpers-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type { RegistryEntityRefV2 } from "./semantic-mutation-envelope-v2.ts";
import type {
  CompiledTaskDecisionModuleCommandV2,
  TaskDecisionModuleAuthorityStateV2
} from "./task-decision-module-semantic-compiler-types.ts";

/**
 * Shared task compilation primitives. These live outside the command compilers
 * so that per-family modules (lifecycle, disposition, relations) can use them
 * without importing each other.
 */
export function taskCompilation(
  taskId: string,
  action: "create" | "transition" | "append" | "document",
  kind: WriteOpKind,
  payload: unknown,
  requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>,
  requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }> = []
): CompiledTaskDecisionModuleCommandV2 {
  const documentPath = "path" in (payload as object)
    ? (payload as { readonly path: string }).path
    : "INDEX.md";
  return {
    mutationPlan: taskDecisionModulePlan([{ entityKind: "task", identity: { taskId }, action, storageContext: { documentPath } }]),
    operation: { opId: "authority-overrides-this", entityId: taskEntityId(taskId), kind, payload },
    requiredBaseRefs,
    requiredPathSnapshots
  };
}

export async function requiredTaskDecisionModuleDocument(
  state: TaskDecisionModuleAuthorityStateV2,
  path: string,
  code: string
): Promise<HostedDocumentSnapshotV2> {
  const snapshot = await state.readHostedDocument(path);
  if (!snapshot) throw admission(code);
  return snapshot;
}
