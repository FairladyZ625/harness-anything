import { composeDurableActionEnvelope } from "../../application/src/durable-action-envelope.ts";
import {
  durablePolicyActions,
  isSameExecution,
  isSamePerson,
  parseEntityRef,
  taskIsDescendantOf,
  type AuthorizationContext,
  type AuthorizationDecision,
  type EntityRef,
  type ReceiptJsonValue,
  type ReceiptDiagnostic,
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
  readonly targetOverride?: EntityRef;
}): AuthorizationDecision {
  const target = input.targetOverride ?? actionTarget(input.action),
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

/**
 * Concrete durable routes. Every case reaches the same port; no route grants authority here.
 * The exhaustive per-action cases look like duplication of durablePolicyActions, but they are
 * the static witness tools/gates/ontology-durable-action-authorization.mjs traces: each kind's
 * literal must sit in a region that provably reaches AuthorizationPort. Collapsing this into an
 * inventory-membership check breaks that trace for every action routed only here.
 */
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
    case "entity-import":
      return authorizeRepoCellAction(input);
    case "entity-migrate-squads":
      return authorizeRepoCellAction(input);
    case "fact-reclassify":
      return authorizeRepoCellAction(input);
    case "fact-record":
      return authorizeRepoCellAction(input);
    case "decision-digests-migrate":
      return authorizeRepoCellAction(input);
    case "dispatch-records-migrate":
      return authorizeRepoCellAction(input);
    case "fact-rekey":
      return authorizeRepoCellAction(input);
    case "relation-events-migrate":
      return authorizeRepoCellAction(input);
    case "fact-type-register":
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
    case "relation-reconfirm":
      return authorizeRepoCellAction(input);
    case "relation-relate":
      return authorizeRepoCellAction(input);
    case "relation-unrelate":
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
  readonly projection: Pick<TaskProjection, "read" | "readRuntimeSession" | "currentLease">;
  readonly now: string;
}): { readonly action: RepoTaskAction; readonly binding: RepoCellBinding } {
  if (!Object.hasOwn(input.action, "executor")) return { action: input.action, binding: input.binding };
  const { executor: raw, ...action } = input.action;
  if (typeof input.binding.source === "object" && input.binding.source.kind === "assignment") {
    if (raw !== undefined && raw !== null)
      throw invalidExecutorBindingFor(input, raw, "Assignment ingress already carries its verified executor binding.");
    return { action, binding: input.binding };
  }
  if (raw === undefined || raw === null) return { action, binding: input.binding };
  if (!isExecutorDescriptorRecord(raw) || raw.kind !== "agent" || typeof raw.id !== "string")
    throw invalidExecutorBindingFor(input, raw, "Executor claims must identify one agent actor.");
  if (!raw.id.startsWith("runtime-session:")) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(raw.id) ||
      Object.keys(raw).some((field) => field !== "kind" && field !== "id")
    )
      throw invalidExecutorBindingFor(input, raw, "Executor claims must use a valid agent id.");
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
      throw invalidExecutorBindingFor(
        input,
        raw,
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
    throw invalidExecutorBindingFor(input, raw, "Executor claims must use runtime-session:<runtime-id>.");
  const runtimeSessionId = match[1]!,
    session = input.projection.readRuntimeSession(runtimeSessionId),
    taskId = typeof action.taskId === "string" ? action.taskId : null,
    executionId = typeof action.executionId === "string" ? action.executionId : null;
  if (session === null)
    throw invalidExecutorBindingFor(
      input,
      raw,
      "The claimed RuntimeSession is not canonically bound to this Task action.",
    );
  const exactBinding =
      taskId === null
        ? session.taskBindings.length === 1
          ? session.taskBindings[0]
          : undefined
        : session.taskBindings.find(
            (candidate) =>
              candidate.taskId === taskId && (executionId === null || candidate.executionId === executionId),
          ),
    descendantBinding =
      exactBinding === undefined && taskId !== null && (action.kind === "doc-submit" || action.kind === "runtime-spawn")
        ? session.taskBindings.find((candidate) => {
            if (
              !taskIsDescendantOf(
                taskId,
                candidate.taskId,
                (current) => input.projection.read(current).snapshot.task?.metadata?.parentTaskId ?? null,
              )
            )
              return false;
            const candidateLease = input.projection.currentLease(candidate.taskId, input.now),
              candidateActor = {
                principal: input.binding.actor.principal,
                executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
              };
            return (
              candidateLease !== null &&
              candidateLease.executionId === candidate.executionId &&
              isSamePerson(candidateLease.actor, candidateActor)
            );
          })
        : undefined,
    taskBinding = exactBinding ?? descendantBinding;
  if (!taskBinding)
    throw invalidExecutorBindingFor(
      input,
      raw,
      "The claimed RuntimeSession does not execute the target Task/Execution.",
    );
  const lease = input.projection.currentLease(taskBinding.taskId, input.now),
    runtimeActor = {
      principal: input.binding.actor.principal,
      executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
    };
  if (lease === null || lease.executionId !== taskBinding.executionId || !isSamePerson(lease.actor, runtimeActor))
    throw invalidExecutorBindingFor(
      input,
      raw,
      "The claimed RuntimeSession has no matching canonical execution lease.",
    );
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
    ["squad", action.squadId],
  ] as const;
  for (const [kind, id] of candidates) {
    if (typeof id !== "string") continue;
    const ref = `${kind}/${id}`;
    if (parseEntityRef(ref) !== null) return ref as EntityRef;
  }
  return repositoryTarget;
}

function invalidExecutorBindingFor(
  input: Parameters<typeof bindVerifiedExecutorClaim>[0],
  raw: unknown,
  message: string,
): Error & { readonly code: "executor_binding_invalid" } {
  const taskId = typeof input.action.taskId === "string" ? input.action.taskId : null,
    requestedExecutionId = typeof input.action.executionId === "string" ? input.action.executionId : null,
    lease = taskId === null ? null : input.projection.currentLease(taskId, input.now),
    executionId = requestedExecutionId ?? lease?.executionId ?? null,
    actual =
      isExecutorDescriptorRecord(raw) && raw.kind === "agent" && typeof raw.id === "string"
        ? `agent:${raw.id}`
        : "malformed executor descriptor",
    expected = lease?.actor.executor ? `agent:${lease.actor.executor.id}` : null,
    retry = executorRetryCommand(input.action, taskId, executionId),
    reviewerRedispatch =
      input.action.kind === "task-review-execution" &&
      taskId !== null &&
      isExecutorDescriptorRecord(raw) &&
      raw.kind === "agent" &&
      typeof raw.id === "string" &&
      raw.id.startsWith("runtime-session:"),
    expectation = reviewerRedispatch
      ? `Expected a reviewer RuntimeSession bound to execution ${executionId ?? "<execution-id>"}; run ` +
        `ha runtime run <runtime-instance-id> --role reviewer --task ${taskId}, then retry ${retry}`
      : expected
        ? `Expected ${expected} from the held execution lease; run from that executor, then retry ${retry}`
        : "Expected a task-bound executor with a matching held execution lease; run ha task start " +
          `${taskId ?? "<task-id>"}, then retry ${retry}`,
    diagnostic: ReceiptDiagnostic = {
      kind: "validation",
      entity: [taskId ? `task ${taskId}` : "repository", executionId ? `execution ${executionId}` : ""]
        .filter(Boolean)
        .join(" "),
      field: "executor",
      actual,
      expectation,
    };
  return Object.assign(new Error(message), { code: "executor_binding_invalid" as const, diagnostic });
}

function executorRetryCommand(action: RepoTaskAction, taskId: string | null, executionId: string | null): string {
  const task = taskId ?? "<task-id>",
    execution = executionId ?? "<execution-id>";
  switch (action.kind) {
    case "task-submit":
      return `ha task submit ${task} --execution-id ${execution} --from-file <submission.json>`;
    case "task-progress-append":
      return `ha task progress append ${task} --text <progress-text>`;
    case "fact-record":
      return `ha fact record ${task} --statement <observation> --source <source>`;
    case "task-artifact-add":
      return `ha task artifact add ${task} --source <path> --destination <artifact-path>`;
    case "doc-submit":
      return `ha doc sync --submit --task ${task}`;
    default:
      return `the ha ${action.kind.replaceAll("-", " ")} command`;
  }
}

function isExecutorDescriptorRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
