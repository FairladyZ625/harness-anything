import {
  encodeTaskDecisionModuleCommandPayloadV2,
  type TaskDecisionModuleCommandPayloadV2
} from "@harness-anything/application";
import type { RegistryEntityRefV2 } from "@harness-anything/kernel";

export function acceptedTaskCompletionTransition(
  taskId: string,
  completionContractBodySha256: string | null
): {
  readonly commandName: "task.transition";
  readonly payload: Uint8Array;
  readonly mutations: ReadonlyArray<{ readonly entity: RegistryEntityRefV2; readonly action: "transition" }>;
  readonly baseRefs: ReadonlyArray<RegistryEntityRefV2>;
} {
  const taskRef = { registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` } as const;
  const payload: TaskDecisionModuleCommandPayloadV2 = {
    schema: "task.transition/v1",
    taskId,
    to: "done",
    completionContractBodySha256
  };
  return {
    commandName: "task.transition",
    payload: encodeTaskDecisionModuleCommandPayloadV2(payload),
    mutations: [{ entity: taskRef, action: "transition" }],
    baseRefs: [taskRef]
  };
}
