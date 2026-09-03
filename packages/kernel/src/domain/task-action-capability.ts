import { isIndependentFrom, isSameExecution, isSamePerson } from "./actor-domain-services.ts";
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
  readonly invocation?: TaskActionCapabilityInvocation;
}

export interface TaskActionCapabilityInvocation {
  readonly taskId: string;
  readonly executionId?: string;
  readonly reviewId?: string;
  readonly amend?: boolean;
  readonly runtimeTaskBound?: boolean;
}

interface PredicateEvaluation {
  readonly status: Exclude<EntityActionCriterionStatus, "not-evaluated">;
  readonly nextActions?: readonly string[];
}

type Evaluation = (
  input: TaskActionCapabilityInput,
) => Exclude<EntityActionCriterionStatus, "not-evaluated"> | PredicateEvaluation;

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
    [key("start", "task-lifecycle-command-transitions/canStartExecution"), startAvailability],
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
    [key("submit", "task-lifecycle-command-transitions/submit.validate"), submitValidation],
    [
      key("submit", "repo-cell-proof/proofFor.SubmitExecution"),
      ({ snapshot, actor }) =>
        heldLeaseForExecutionActor(snapshot, undefined, actor) ||
        currentSubmittedExecutions(snapshot).some((execution) => isSameExecution(execution.actor, actor))
          ? "met"
          : "unmet",
    ],
    [key("review", "task-lifecycle-contract-support/revisionIssues"), revisionCurrent],
    [key("review", "task-lifecycle-review-transitions/review.validate"), reviewValidation],
    [key("review", "repo-cell-proof/proofFor.RecordReview"), reviewIndependence],
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
    [key("release", "repo-cell-task-mutation/release"), releaseAvailability],
    [key("amend", "repo-cell-task-mutation/amend"), mutationInvocation],
    [key("archive", "repo-cell-task-mutation/archive"), activeDispositionInvocation],
    [key("supersede", "repo-cell-task-mutation/supersede"), activeDispositionInvocation],
    [key("delete", "repo-cell-task-mutation/delete"), activeDispositionInvocation],
    [key("reopen", "repo-cell-task-mutation/reopen"), reopenInvocation],
    [key("contract-migrate", "repo-cell-task-mutation/contract-migrate"), mutationInvocation],
  ]),
);

export function evaluateTaskActionCapability(
  input: TaskActionCapabilityInput,
): readonly TaskActionCapabilityCriterionResult[] {
  return input.action.criteria.map((criterion) => {
    const evaluate = taskCapabilityEvaluators.get(key(input.action.id, criterion.ref));
    if (evaluate === undefined)
      throw new Error(`Task Action ${input.action.id} criterion ${criterion.ref} has no capability classification.`);
    const evaluated = evaluate(input),
      status = typeof evaluated === "string" ? evaluated : evaluated.status;
    return Object.freeze({
      criterionRef: criterion.ref,
      status,
      nextActions: Object.freeze(
        typeof evaluated !== "string" && evaluated.nextActions
          ? [...evaluated.nextActions]
          : status === "met"
            ? []
            : status === "invocation-required"
              ? invocationNextActions(input.action)
              : [`${criterion.explain} ${retryUsage(input.action, input.snapshot.task?.taskId)}`],
      ),
    });
  });
}

function releaseAvailability({ snapshot, actor }: TaskActionCapabilityInput): "met" | "unmet" {
  return snapshot.lease && isSameExecution(snapshot.lease.actor, actor) ? "met" : "unmet";
}

function mutationInvocation(): "invocation-required" {
  return "invocation-required";
}

function activeDispositionInvocation({ snapshot }: TaskActionCapabilityInput): "invocation-required" | "unmet" {
  return snapshot.lease === null && (snapshot.task?.packageDisposition ?? "active") === "active"
    ? "invocation-required"
    : "unmet";
}

function reopenInvocation({ snapshot }: TaskActionCapabilityInput): "invocation-required" | "unmet" {
  return snapshot.lease === null &&
    snapshot.task !== null &&
    !["done", "cancelled"].includes(snapshot.task.status) &&
    ["archived", "tombstoned"].includes(snapshot.task.packageDisposition ?? "active")
    ? "invocation-required"
    : "unmet";
}

function submitValidation(input: TaskActionCapabilityInput): PredicateEvaluation | "invocation-required" {
  if (["done", "cancelled"].includes(input.snapshot.task?.status ?? "")) return { status: "unmet" };
  const submitted = submittedExecution(input);
  if (!submitted) return "invocation-required";
  const taskId = invocationTaskId(input),
    executionId = submitted.executionId,
    amend = `ha task submit ${taskId} --execution-id ${executionId} ` + "--amend --json-input '<submission-json>'";
  return {
    status: input.invocation?.amend === false ? "unmet" : "invocation-required",
    nextActions: [
      `Execution ${executionId} is already submitted; use ${amend} to correct it, or run ` +
        `${reviewCommand(taskId, executionId, "<review-id>")}.`,
    ],
  };
}

function startAvailability(input: TaskActionCapabilityInput): PredicateEvaluation | "met" | "unmet" {
  const executionIds = [
      "entity-action-explanation",
      ...input.snapshot.executions.map(({ executionId }) => executionId),
    ],
    startable = executionIds.some((executionId) => canStartExecution(input.snapshot, executionId));
  if (startable) return "met";
  const lease = input.snapshot.lease;
  if (!lease || heldLeaseForExecutionActor(input.snapshot, lease.executionId, input.actor)) return "unmet";
  const taskId = invocationTaskId(input),
    executor = lease.actor.executor ? `${lease.actor.executor.kind}:${lease.actor.executor.id}` : "none",
    holder = `personId=${lease.actor.principal.personId}, executor=${executor}`;
  return {
    status: "unmet",
    nextActions: [
      lease.phase === "reserving"
        ? `Task ${taskId} is being reserved by ${holder}; wait for that reservation to publish ` +
          `or lapse at ${lease.expiresAt}, then retry ha task start ${taskId}.`
        : `Task ${taskId} is held by ${holder}; that holder must run ha task release ${taskId}. ` +
          `This caller must wait for release, then retry ha task start ${taskId}.`,
    ],
  };
}

function reviewValidation(input: TaskActionCapabilityInput): PredicateEvaluation | "invocation-required" {
  if (
    input.invocation?.reviewId !== undefined &&
    input.snapshot.reviews.some(({ reviewId }) => reviewId === input.invocation?.reviewId)
  )
    return { status: "unmet" };
  if (currentSubmittedExecutions(input.snapshot).length > 0) return "invocation-required";
  const taskId = invocationTaskId(input),
    executionId = input.invocation?.executionId ?? "<execution-id>",
    reviewId = input.invocation?.reviewId ?? "<review-id>";
  return {
    status: "unmet",
    nextActions: [
      [
        "Execution Review requires a submitted execution; run ha task start ",
        `${taskId}`,
        " --execution-id ",
        `${executionId}`,
        ", then ha task submit ",
        `${taskId}`,
        " --execution-id ",
        `${executionId}`,
        " --json-input '<submission-json>', then retry ",
        `${reviewCommand(taskId, executionId, reviewId)}`,
        ".",
      ].join(""),
    ],
  };
}

function reviewIndependence(input: TaskActionCapabilityInput): PredicateEvaluation | "met" {
  const submitted = submittedExecutions(input),
    dependent = !submitted.some((execution) => isIndependentFrom(execution.actor, input.actor));
  if (!input.invocation?.runtimeTaskBound && !dependent) return "met";
  const taskId = invocationTaskId(input),
    executionId = submitted[0]?.executionId ?? input.invocation?.executionId ?? "<execution-id>",
    reviewId = input.invocation?.reviewId ?? "<review-id>",
    command = reviewCommand(taskId, executionId, reviewId);
  if (input.invocation?.runtimeTaskBound)
    return {
      status: "unmet",
      nextActions: [
        `This runtime is bound to task ${taskId} and execution ${executionId} and cannot review its own work; ` +
          `have an independent human or a runtime with no binding to this task and execution run ${command}.`,
      ],
    };
  if (submitted[0]?.actor.executor === null && input.actor.executor === null)
    return {
      status: "unmet",
      nextActions: [
        `The submitted execution's original start declared no executor, so only a different person can review it. ` +
          `Run ha task declare-executor ${taskId} --execution-id ${executionId} --agent <dispatch-agent> ` +
          `--reason <reason> before same-person review, or have a different person run ${command}.`,
      ],
    };
  return {
    status: "unmet",
    nextActions: [`Have a reviewer independent of the submitting executor run ${command}.`],
  };
}

function submittedExecution(input: TaskActionCapabilityInput) {
  return submittedExecutions(input)[0];
}

function submittedExecutions(input: TaskActionCapabilityInput) {
  const submitted = currentSubmittedExecutions(input.snapshot),
    executionId = input.invocation?.executionId;
  return executionId === undefined ? submitted : submitted.filter((execution) => execution.executionId === executionId);
}

function invocationTaskId(input: TaskActionCapabilityInput): string {
  return input.invocation?.taskId ?? input.snapshot.task?.taskId ?? "<task-id>";
}

function reviewCommand(taskId: string, executionId: string, reviewId: string): string {
  return (
    `ha task review-execution ${taskId} --execution-id ${executionId} ` +
    `--review-id ${reviewId} --from-file <review.json>`
  );
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
  const hasRequiredInvocation =
    action.input.fields.some((field) => field.required && field.cli !== undefined) ||
    action.input.exactlyOneOf.length > 0;
  return hasRequiredInvocation ? [taskActionUsage(action)] : [];
}

function retryUsage(action: EntityActionContract, taskId = "<task-id>"): string {
  return `Then retry ${taskActionUsage(action, taskId)}.`;
}

function key(actionId: string, criterionRef: string): string {
  return `${actionId}\u0000${criterionRef}`;
}
