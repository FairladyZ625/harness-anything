import {
  applyTransition,
  TASK_LIFECYCLE_TRANSITIONS,
  TaskLifecycleContractError,
  validateTaskLifecycleCommandEnvelope,
  type ProofFor,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot,
} from "./task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "./task-lifecycle-publication.ts";
import type { ContractValidationIssue } from "./task.ts";
import {
  appendWriteTarget,
  assertCurrentWriter,
  createWriteReceipt,
  freezeDeclaredWritePlan,
  freezeWriteValue,
  isFrozenWritePlan,
  validateDeclaredWritePlan,
  type FrozenWritePlan,
  type WritePlan,
  type WriteReceipt,
  type WriteTarget,
  type WriterGeneration,
  type WriterGenerationToken,
} from "./write-chain.contract.ts";
export type TaskLifecycleCommandType = TaskLifecycleCommand["type"];
const commandTypes = TASK_LIFECYCLE_TRANSITIONS.map((transition) => transition.commandType);
export function validateWritePlan(plan: WritePlan<TaskLifecycleCommandType>): readonly ContractValidationIssue[] {
  return validateDeclaredWritePlan(plan, commandTypes).map((message) => ({ code: "invalid_write_plan", message }));
}
export function freezeWritePlan<C extends TaskLifecycleCommandType>(plan: WritePlan<C>): FrozenWritePlan<C> {
  const issues = validateWritePlan(plan);
  if (issues.length > 0) throw new TaskLifecycleContractError("frozen_write_plan", issues);
  return freezeDeclaredWritePlan(plan, commandTypes);
}
export function addWriteTarget<C extends TaskLifecycleCommandType>(
  plan: WritePlan<C> | FrozenWritePlan<C>,
  target: WriteTarget,
): WritePlan<C> {
  if (isFrozenWritePlan(plan))
    throw new TaskLifecycleContractError("frozen_write_plan", [
      { code: "frozen_write_plan", message: "a frozen write plan cannot accept late targets" },
    ]);
  return appendWriteTarget(plan, target);
}
export interface ExistingTaskOperation {
  readonly opId: string;
  readonly commandDigest: string;
  readonly event: TaskEventV1;
  readonly receipt: WriteReceipt;
}
export type TaskLifecycleWriteDecision =
  | {
      readonly accepted: true;
      readonly event: TaskEventV1;
      readonly frozenPlan: FrozenWritePlan<TaskLifecycleCommandType>;
      readonly receipt: WriteReceipt;
    }
  | { readonly accepted: false; readonly event: null; readonly frozenPlan: null; readonly receipt: WriteReceipt };
export function decideTaskLifecycleWrite<C extends TaskLifecycleCommand>(input: {
  readonly snapshot: TaskLifecycleSnapshot;
  readonly command: C;
  readonly proof: ProofFor<C>;
  readonly activeWriter: WriterGeneration;
  readonly writerToken: WriterGenerationToken;
  readonly existingOperation?: ExistingTaskOperation;
}): TaskLifecycleWriteDecision {
  try {
    assertCurrentWriter(input.activeWriter, input.writerToken, input.command.workspaceId);
    const envelopeIssues = validateTaskLifecycleCommandEnvelope(input.command);
    if (envelopeIssues.length > 0) throw new TaskLifecycleContractError("invalid_schema", envelopeIssues);
    if (
      input.existingOperation?.opId === input.command.opId &&
      input.existingOperation.commandDigest !== input.command.commandDigest
    )
      return rejectedDecision(
        input.command.opId,
        "operation_conflict",
        "the same opId already names a different command payload",
      );
    if (input.existingOperation?.opId === input.command.opId)
      return Object.freeze({
        accepted: true,
        event: freezeWriteValue(input.existingOperation.event),
        frozenPlan: taskLifecycleWritePlan(input.existingOperation.event) as FrozenWritePlan<TaskLifecycleCommandType>,
        receipt: input.existingOperation.receipt,
      });
    const event = freezeWriteValue(applyTransition(input.snapshot, input.command, input.proof).event);
    const frozenPlan = taskLifecycleWritePlan(event) as FrozenWritePlan<TaskLifecycleCommandType>;
    const receipt = createWriteReceipt({
      outcome: "indeterminate",
      opId: input.command.opId,
      visibility: "center",
      code: "publication_unverified",
      origin: "N/A",
      nextAction: `read operation ${input.command.opId} before retrying`,
    });
    return Object.freeze({ accepted: true, event, frozenPlan, receipt });
  } catch (error) {
    const rawCode =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "write_rejected";
    const code = rawCode === "frozen_write_plan" ? "invalid_write_plan" : rawCode;
    return rejectedDecision(input.command.opId, code, error instanceof Error ? error.message : String(error));
  }
}
function rejectedDecision(opId: string, code: string, detail: string): TaskLifecycleWriteDecision {
  return Object.freeze({
    accepted: false,
    event: null,
    frozenPlan: null,
    receipt: createWriteReceipt({
      outcome: "op_rejected",
      opId,
      visibility: "center",
      code,
      origin: "task-lifecycle-contract",
      evidence: `contract-rejection:${code}`,
      nextAction: `correct the command or writer proof before retrying: ${detail}`,
    }),
  });
}
