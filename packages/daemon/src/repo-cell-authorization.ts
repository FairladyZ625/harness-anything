import { composeDurableActionEnvelope } from "../../application/src/durable-action-envelope.ts";
import {
  durablePolicyActions,
  isSameExecution,
  isSamePerson,
  parseEntityRef,
  type AuthorizationContext,
  type AuthorizationDecision,
  type EntityRef,
  type ReceiptJsonValue,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { authorizeAction } from "./authorization.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

const repositoryTarget: EntityRef = "settings/repository";

export function authorizeRepoCellAction(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly revision: number;
  readonly now: string;
}): AuthorizationDecision {
  const target = actionTarget(input.action),
    assignment = input.binding.assignmentScope,
    assignmentSource =
      typeof input.binding.source === "object" && input.binding.source.kind === "assignment"
        ? input.binding.source
        : null,
    context: AuthorizationContext = {
      ...(input.binding.source === "local" && input.binding.authorizationBindingMode !== "declared"
        ? {
            defaultBinding: {
              principalPersonId: input.binding.actor.principal.personId,
              source: "local" as const,
            },
          }
        : {}),
      ...(input.binding.roleBindings === undefined ? {} : { roleBindings: input.binding.roleBindings }),
      roleBindingTargets: [repositoryTarget],
      ...(assignment
        ? {
            assignmentBinding: {
              repoId: assignment.repoId,
              nodeId: assignmentSource?.nodeId ?? "",
              assignmentId: assignmentSource?.assignmentId ?? "",
              scope: assignment.scope as unknown as Readonly<Record<string, ReceiptJsonValue>>,
              ...(input.binding.writerEpoch === undefined ? {} : { writerEpoch: input.binding.writerEpoch }),
            },
          }
        : {}),
      evaluatedAt: input.now,
      writeSource: input.binding.source,
      target: {},
      evaluatedAtCut: `canonical:${input.revision}`,
    },
    envelope = composeDurableActionEnvelope({
      actionId: input.actionId,
      kind: input.action.kind,
      target,
      actor: input.binding.actor,
      idempotencyKey: typeof input.action.idempotencyKey === "string" ? input.action.idempotencyKey : input.actionId,
    });
  return authorizeAction(envelope, context);
}

/** Concrete durable routes. Every case reaches the same port; no route grants authority here. */
export function authorizeDurableRepoCellAction(
  input: Parameters<typeof authorizeRepoCellAction>[0],
): AuthorizationDecision | null {
  switch (input.action.kind) {
    case "agent-create":
      return authorizeRepoCellAction(input);
    case "agent-install":
      return authorizeRepoCellAction(input);
    case "ci-observe-pull":
      return authorizeRepoCellAction(input);
    case "daemon-control-request":
      return authorizeRepoCellAction(input);
    case "daemon-fleet-center-start":
      return authorizeRepoCellAction(input);
    case "daemon-fleet-edge-sync":
      return authorizeRepoCellAction(input);
    case "daemon-repo-register":
      return authorizeRepoCellAction(input);
    case "daemon-repo-unregister":
      return authorizeRepoCellAction(input);
    case "daemon-start":
      return authorizeRepoCellAction(input);
    case "daemon-stop":
      return authorizeRepoCellAction(input);
    case "decision-accept":
      return authorizeRepoCellAction(input);
    case "decision-amend":
      return authorizeRepoCellAction(input);
    case "decision-claim-add":
      return authorizeRepoCellAction(input);
    case "decision-claim-fulfill":
      return authorizeRepoCellAction(input);
    case "decision-defer":
      return authorizeRepoCellAction(input);
    case "decision-propose":
      return authorizeRepoCellAction(input);
    case "decision-reckon":
      return authorizeRepoCellAction(input);
    case "decision-reject":
      return authorizeRepoCellAction(input);
    case "decision-relate":
      return authorizeRepoCellAction(input);
    case "decision-relation-replace":
      return authorizeRepoCellAction(input);
    case "decision-relation-retire":
      return authorizeRepoCellAction(input);
    case "decision-repin":
      return authorizeRepoCellAction(input);
    case "decision-retire":
      return authorizeRepoCellAction(input);
    case "decision-supersede":
      return authorizeRepoCellAction(input);
    case "decision-transition":
      return authorizeRepoCellAction(input);
    case "distill-candidate":
      return authorizeRepoCellAction(input);
    case "distill-promote":
      return authorizeRepoCellAction(input);
    case "doc-conflict-discard-local":
      return authorizeRepoCellAction(input);
    case "doc-conflict-overwrite-center":
      return authorizeRepoCellAction(input);
    case "doc-conflict-resolve":
      return authorizeRepoCellAction(input);
    case "doc-materialize":
      return authorizeRepoCellAction(input);
    case "doc-retire":
      return authorizeRepoCellAction(input);
    case "doc-submit":
      return authorizeRepoCellAction(input);
    case "fact-record":
      return authorizeRepoCellAction(input);
    case "fact-rekey":
      return authorizeRepoCellAction(input);
    case "ledger-migrate":
      return authorizeRepoCellAction(input);
    case "migrate-import":
      return authorizeRepoCellAction(input);
    case "people-add":
      return authorizeRepoCellAction(input);
    case "people-bind":
      return authorizeRepoCellAction(input);
    case "people-delegate":
      return authorizeRepoCellAction(input);
    case "people-remove":
      return authorizeRepoCellAction(input);
    case "people-revoke-delegation":
      return authorizeRepoCellAction(input);
    case "people-set-role":
      return authorizeRepoCellAction(input);
    case "preset-install":
      return authorizeRepoCellAction(input);
    case "preset-run-start":
      return authorizeRepoCellAction(input);
    case "preset-seed":
      return authorizeRepoCellAction(input);
    case "preset-uninstall":
      return authorizeRepoCellAction(input);
    case "preset-upgrade":
      return authorizeRepoCellAction(input);
    case "projection-rebuild":
      return authorizeRepoCellAction(input);
    case "repo-bootstrap":
      return authorizeRepoCellAction(input);
    case "runtime-batch":
      return authorizeRepoCellAction(input);
    case "runtime-cancel":
      return authorizeRepoCellAction(input);
    case "runtime-instance-create":
      return authorizeRepoCellAction(input);
    case "runtime-instance-delete":
      return authorizeRepoCellAction(input);
    case "runtime-instance-github-credential-set":
      return authorizeRepoCellAction(input);
    case "runtime-instance-github-credential-unset":
      return authorizeRepoCellAction(input);
    case "runtime-instance-list":
      return authorizeRepoCellAction(input);
    case "runtime-instance-login":
      return authorizeRepoCellAction(input);
    case "runtime-instance-logout":
      return authorizeRepoCellAction(input);
    case "runtime-instance-show":
      return authorizeRepoCellAction(input);
    case "runtime-instance-update":
      return authorizeRepoCellAction(input);
    case "runtime-run":
      return authorizeRepoCellAction(input);
    case "runtime-spawn":
      return authorizeRepoCellAction(input);
    case "schedule-claim":
      return authorizeRepoCellAction(input);
    case "schedule-create":
      return authorizeRepoCellAction(input);
    case "schedule-delete":
      return authorizeRepoCellAction(input);
    case "schedule-disable":
      return authorizeRepoCellAction(input);
    case "schedule-dispatch-link":
      return authorizeRepoCellAction(input);
    case "schedule-enable":
      return authorizeRepoCellAction(input);
    case "schedule-missed":
      return authorizeRepoCellAction(input);
    case "schedule-run-now":
      return authorizeRepoCellAction(input);
    case "schedule-settle":
      return authorizeRepoCellAction(input);
    case "schedule-update":
      return authorizeRepoCellAction(input);
    case "script-run":
      return authorizeRepoCellAction(input);
    case "settings-update":
      return authorizeRepoCellAction(input);
    case "squad-cancel":
      return authorizeRepoCellAction(input);
    case "squad-install":
      return authorizeRepoCellAction(input);
    case "squad-run":
      return authorizeRepoCellAction(input);
    case "task-amend":
      return authorizeRepoCellAction(input);
    case "task-archive":
      return authorizeRepoCellAction(input);
    case "task-artifact-add":
      return authorizeRepoCellAction(input);
    case "task-closeout":
      return authorizeRepoCellAction(input);
    case "task-code-doc-reconcile":
      return authorizeRepoCellAction(input);
    case "task-code-doc-repoint":
      return authorizeRepoCellAction(input);
    case "task-complete":
      return authorizeRepoCellAction(input);
    case "task-contract-migrate":
      return authorizeRepoCellAction(input);
    case "task-create":
      return authorizeRepoCellAction(input);
    case "task-declare-executor":
      return authorizeRepoCellAction(input);
    case "task-delete":
      return authorizeRepoCellAction(input);
    case "task-pin":
      return authorizeRepoCellAction(input);
    case "task-progress-append":
      return authorizeRepoCellAction(input);
    case "task-relate":
      return authorizeRepoCellAction(input);
    case "task-release":
      return authorizeRepoCellAction(input);
    case "task-reopen":
      return authorizeRepoCellAction(input);
    case "task-review-consent":
      return authorizeRepoCellAction(input);
    case "task-review-execution":
      return authorizeRepoCellAction(input);
    case "task-start":
      return authorizeRepoCellAction(input);
    case "task-submit":
      return authorizeRepoCellAction(input);
    case "task-supersede":
      return authorizeRepoCellAction(input);
    case "task-transition":
      return authorizeRepoCellAction(input);
    case "task-unpin":
      return authorizeRepoCellAction(input);
    case "terminal-input":
      return authorizeRepoCellAction(input);
    case "terminal-resize":
      return authorizeRepoCellAction(input);
    case "terminal-spawn":
      return authorizeRepoCellAction(input);
    case "terminal-terminate":
      return authorizeRepoCellAction(input);
    default:
      return null;
  }
}

export function bindVerifiedExecutorClaim(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly projection: Pick<TaskProjection, "readRuntimeSession" | "currentLease">;
  readonly now: string;
}): { readonly action: RepoTaskAction; readonly binding: RepoCellBinding } {
  if (!Object.hasOwn(input.action, "executor")) return { action: input.action, binding: input.binding };
  const { executor: raw, ...action } = input.action;
  if (typeof input.binding.source === "object" && input.binding.source.kind === "assignment") {
    if (raw !== undefined && raw !== null)
      throw invalidExecutorBinding("Assignment ingress already carries its verified executor binding.");
    return { action, binding: input.binding };
  }
  if (raw === undefined || raw === null) return { action, binding: input.binding };
  if (!isExecutorDescriptorRecord(raw) || raw.kind !== "agent" || typeof raw.id !== "string")
    throw invalidExecutorBinding("Executor claims must identify one agent actor.");
  if (!raw.id.startsWith("runtime-session:")) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(raw.id) ||
      Object.keys(raw).some((field) => field !== "kind" && field !== "id")
    )
      throw invalidExecutorBinding("Executor claims must use a valid agent id.");
    // Host-derived bindings always declare how authorization was projected. A binding without
    // that marker is the legacy direct RepoCell API, where action.executor was never authoritative.
    if (input.binding.authorizationBindingMode === undefined) return { action, binding: input.binding };
    const claimedActor = {
        principal: input.binding.actor.principal,
        executor: { kind: "agent" as const, id: raw.id },
      },
      taskId = typeof action.taskId === "string" ? action.taskId : null,
      lease = taskId === null ? null : input.projection.currentLease(taskId, input.now),
      attributedByCliSession = input.binding.sessionEnvironment?.HARNESS_ACTOR?.trim() === `agent:${raw.id}`;
    if (!attributedByCliSession && (lease === null || !isSameExecution(lease.actor, claimedActor)))
      throw invalidExecutorBinding(
        "Executor claims must use runtime-session:<runtime-id> or match the held execution.",
      );
    return {
      action,
      binding: {
        ...input.binding,
        actor: claimedActor,
      },
    };
  }
  // Runtime identities are durable authority only when the action itself is durable. Reads may
  // reuse an already-running daemon but must not fail merely because no task binding is projected.
  if (!(durablePolicyActions as readonly string[]).includes(input.action.kind))
    return { action, binding: input.binding };
  const match = /^runtime-session:([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(raw.id);
  if (!match || Object.keys(raw).some((field) => field !== "kind" && field !== "id"))
    throw invalidExecutorBinding("Executor claims must use runtime-session:<runtime-id>.");
  const runtimeSessionId = match[1]!,
    session = input.projection.readRuntimeSession(runtimeSessionId),
    taskId = typeof action.taskId === "string" ? action.taskId : null,
    executionId = typeof action.executionId === "string" ? action.executionId : null;
  if (session === null)
    throw invalidExecutorBinding("The claimed RuntimeSession is not canonically bound to this Task action.");
  const taskBinding =
    taskId === null
      ? session.taskBindings.length === 1
        ? session.taskBindings[0]
        : undefined
      : session.taskBindings.find(
          (candidate) => candidate.taskId === taskId && (executionId === null || candidate.executionId === executionId),
        );
  if (!taskBinding)
    throw invalidExecutorBinding("The claimed RuntimeSession does not execute the target Task/Execution.");
  const lease = input.projection.currentLease(taskBinding.taskId, input.now),
    runtimeActor = {
      principal: input.binding.actor.principal,
      executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
    };
  if (lease === null || lease.executionId !== taskBinding.executionId || !isSamePerson(lease.actor, runtimeActor))
    throw invalidExecutorBinding("The claimed RuntimeSession has no matching canonical execution lease.");
  return { action, binding: { ...input.binding, actor: runtimeActor } };
}

function actionTarget(action: RepoTaskAction): EntityRef {
  const candidates = [
    ["task", action.taskId],
    ["decision", action.decisionId],
    ["fact", action.factId],
    ["execution", action.executionId],
    ["schedule", action.scheduleId],
    ["agent", action.agentId],
  ] as const;
  for (const [kind, id] of candidates) {
    if (typeof id !== "string") continue;
    const ref = `${kind}/${id}`;
    if (parseEntityRef(ref) !== null) return ref as EntityRef;
  }
  return repositoryTarget;
}

function invalidExecutorBinding(message: string): Error & { readonly code: "executor_binding_invalid" } {
  return Object.assign(new Error(message), { code: "executor_binding_invalid" as const });
}

function isExecutorDescriptorRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
