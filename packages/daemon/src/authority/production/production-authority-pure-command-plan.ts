import type { ProductionAuthorityCommand } from "@harness-anything/application";
import {
  decisionEntityId,
  moduleEntityId,
  taskEntityId,
  type WriteOp
} from "@harness-anything/kernel";

export function directTypedCommandEntityId(
  command: ProductionAuthorityCommand
): WriteOp["entityId"] | undefined {
  const action = command.action;
  switch (action.kind) {
    case "new-task":
      return action.taskId ? taskEntityId(action.taskId) : undefined;
    case "task-retire-execution":
      return `entity/execution/${action.executionId}`;
    case "status-set":
      if (action.executionSubmission && !action.executionSubmission.executionId) {
        return undefined;
      }
      return action.executionSubmission?.executionId
        ? `execution/${action.executionSubmission.executionId}`
        : taskEntityId(action.taskId);
    case "progress-append":
    case "task-code-doc-reconcile":
    case "fact-invalidate":
    case "record-fact":
      return taskEntityId(action.taskId);
    case "decision-propose":
    case "decision-relate":
      return decisionEntityId(action.decisionId);
    case "session-export":
      return action.sessionId && action.runtime && action.transcriptFile
        ? `entity/session/${action.sessionId}`
        : undefined;
    case "module-register":
    case "module-unregister":
    case "module-step":
      return moduleEntityId(action.moduleKey);
    default:
      return undefined;
  }
}

/**
 * True only when the normalized command fixes its canonical entity without
 * running an application materializer or allocating an operation-derived id.
 */
export function productionAuthorityCommandHasPurePlan(
  command: ProductionAuthorityCommand
): boolean {
  return directTypedCommandEntityId(command) !== undefined
    && !(command.action.kind === "new-task" && command.action.registerModule);
}
