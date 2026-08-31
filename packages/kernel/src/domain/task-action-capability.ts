import { isIndependentFrom, isSamePerson } from "./actor-domain-services.ts";
import { closeoutReadiness, currentSubmittedExecutions } from "./closeout-readiness.ts";
import type { EntityActionCriterionStatus } from "./entity-action-explanation.ts";
import type { EntityActionContract } from "./entity-kind-registry.ts";
import { canStartExecution } from "./task-lifecycle-command-transitions.ts";
import { heldLeaseForExecutionActor } from "./task-lifecycle-contract-support.ts";
import { revisionIssues } from "./task-lifecycle-contract-support.ts";
import type { TaskLifecycleCommand } from "./task-lifecycle.contract.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle-contract-internal-types.ts";
import type { ActorIdentity } from "./actor-identity.ts";

export interface TaskActionCapabilityCriterionResult {
  readonly criterionRef: string;
  readonly status: Exclude<EntityActionCriterionStatus, "not-evaluated">;
  readonly nextActions: readonly string[];
}

export interface TaskActionCapabilityInput {
  readonly action: EntityActionContract;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly actor: ActorIdentity;
}

type Evaluation = (input: TaskActionCapabilityInput) => Exclude<EntityActionCriterionStatus, "not-evaluated">;

const invocationRequired: Evaluation = () => "invocation-required";
const revisionCurrent: Evaluation = ({ snapshot }) =>
  revisionIssues(snapshot, {
    expectedRevision: snapshot.revision,
    workspaceRevision: snapshot.revision + 1,
  } as TaskLifecycleCommand).length === 0
    ? "met"
    : "unmet";

const taskCapabilityEvaluators = Object.freeze(
  new Map<string, Evaluation>([
    [key("start", "task-lifecycle-contract-support/revisionIssues"), revisionCurrent],
    [
      key("start", "task-lifecycle-command-transitions/canStartExecution"),
      ({ snapshot }) =>
        ["entity-action-explanation", ...snapshot.executions.map(({ executionId }) => executionId)].some(
          (executionId) => canStartExecution(snapshot, executionId),
        )
          ? "met"
          : "unmet",
    ],
    [
      key("start", "task-lifecycle-command-transitions/start.validate"),
      ({ snapshot }) =>
        ["entity-action-explanation", ...snapshot.executions.map(({ executionId }) => executionId)].some(
          (executionId) => canStartExecution(snapshot, executionId),
        )
          ? "met"
          : "unmet",
    ],
    [key("submit", "task-lifecycle-contract-support/revisionIssues"), revisionCurrent],
    [key("submit", "task-lifecycle-command-transitions/submit.validate"), invocationRequired],
    [
      key("submit", "actor-domain-services/heldLeaseForExecutionActor"),
      ({ snapshot, actor }) => (heldLeaseForExecutionActor(snapshot, undefined, actor) ? "met" : "unmet"),
    ],
    [key("review", "task-lifecycle-contract-support/revisionIssues"), revisionCurrent],
    [
      key("review", "task-lifecycle-review-transitions/review.validate"),
      ({ snapshot }) => (currentSubmittedExecutions(snapshot).length > 0 ? "invocation-required" : "unmet"),
    ],
    [
      key("review", "repo-cell-proof/proofFor.RecordReview"),
      ({ snapshot, actor }) =>
        currentSubmittedExecutions(snapshot).some((execution) => isIndependentFrom(execution.actor, actor))
          ? "met"
          : "unmet",
    ],
    [key("complete", "task-lifecycle-contract-support/revisionIssues"), revisionCurrent],
    [
      key("complete", "closeout-readiness/closeoutReadiness"),
      ({ snapshot }) => (closeoutReadiness(snapshot).readiness === "ready" ? "met" : "unmet"),
    ],
    [
      key("complete", "task-lifecycle-review-transitions/complete.validate"),
      ({ snapshot, actor }) =>
        snapshot.task !== null && isSamePerson(snapshot.task.createdBy, actor) && snapshot.lease === null
          ? "met"
          : "unmet",
    ],
  ]),
);

export function evaluateTaskActionCapability(
  input: TaskActionCapabilityInput,
): readonly TaskActionCapabilityCriterionResult[] {
  return input.action.criteria.map((criterion) => {
    const evaluate = taskCapabilityEvaluators.get(key(input.action.id, criterion.ref));
    if (evaluate === undefined)
      throw new Error(`Task Action ${input.action.id} criterion ${criterion.ref} has no capability classification.`);
    const status = evaluate(input);
    return Object.freeze({
      criterionRef: criterion.ref,
      status,
      nextActions: Object.freeze(
        status === "met"
          ? []
          : status === "invocation-required"
            ? invocationNextActions(input.action)
            : [`${criterion.explain} ${retryUsage(input.action, input.snapshot.task?.taskId)}`],
      ),
    });
  });
}

export function taskActionUsage(action: EntityActionContract, taskId = "<task-id>"): string {
  const ingress = action.execution?.ingress;
  if (ingress === undefined || !ingress.startsWith("task-"))
    throw new Error(`Task Action ${action.id} has no Task command ingress.`);
  const flags = action.input.fields.flatMap((field) => {
    if (!field.cli) return [];
    const value = field.cli.kind === "boolean" ? "" : ` ${field.cli.format ?? `<${field.cli.name.slice(2)}>`}`;
    return [field.required ? `${field.cli.name}${value}` : `[${field.cli.name}${value}]`];
  });
  return ["ha", "task", ingress.slice("task-".length), taskId, ...flags].join(" ");
}

function invocationNextActions(action: EntityActionContract): readonly string[] {
  const required = action.input.fields.flatMap((field) =>
      field.required && field.cli ? [field.cli.error.nextAction] : [],
    ),
    alternatives = action.input.exactlyOneOf.flatMap((group) =>
      group.flatMap((fieldName) => {
        const field = action.input.fields.find((candidate) => candidate.field === fieldName);
        return field?.cli ? [field.cli.error.nextAction] : [];
      }),
    );
  return [...new Set([...required, ...alternatives])];
}

function retryUsage(action: EntityActionContract, taskId = "<task-id>"): string {
  return `Then retry ${taskActionUsage(action, taskId)}.`;
}

function key(actionId: string, criterionRef: string): string {
  return `${actionId}\u0000${criterionRef}`;
}
