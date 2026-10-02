import { composeDurableActionEnvelope } from "@harness-anything/application/internal/durable-action-envelope";
import path from "node:path";
import {
  durablePolicyActions,
  isSameExecution,
  parseEntityRef,
  taskIsDescendantOf,
  stableStringify,
  verifyDelegatedExecutionToken,
  type AuthorizationDecision,
  type AuthorizationResource,
  type DelegatedExecutionToken,
  type DelegatedExecutionTokenReasonCode,
  type EntityActionUnmetCriterionV1,
  type WriteReceipt,
  type WriteReceiptDraft,
  type EntityRef,
  type ReceiptDiagnostic,
  type TaskProjection,
} from "@harness-anything/kernel";
import type { ExecutionDelegationRecord } from "@harness-anything/kernel";
import { authorizeAction } from "./authorization.ts";
import { KeycloakPolicyAdapter, type KeycloakPermissionDecision } from "./keycloak-policy-adapter.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

const repositoryTarget: EntityRef = "settings/repository";

export async function evaluateRepoCellAction(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly repoId: string;
  readonly revision: number;
  readonly now: string;
  readonly targetOverride?: EntityRef;
  readonly fetchPort?: typeof fetch;
}): Promise<AuthorizationDecision> {
  const target = input.targetOverride ?? actionTarget(input.action),
    envelope = composeDurableActionEnvelope({
      actionId: input.actionId,
      kind: input.action.kind,
      target,
      actor: input.binding.actor,
      idempotencyKey: typeof input.action.idempotencyKey === "string" ? input.action.idempotencyKey : input.actionId,
    });
  const credential = input.binding.keycloakAuthorization;
  if (!credential) return authorizeDurableRepoCellAction(input);
  const result = await evaluateKeycloakPerson({
    credential,
    personId: envelope.actor.principal.personId,
    action: input.action.kind,
    resource:
      target === repositoryTarget
        ? { kind: "repository", repoId: input.repoId }
        : { kind: "entity", repoId: input.repoId, entityRef: target },
    fetchPort: input.fetchPort,
  });
  const decision = keycloakDecision(envelope, `canonical:${input.revision}`, result.outcome, result.reasonCode),
    token = input.binding.delegatedExecutionToken;
  return token
    ? {
        ...decision,
        bindingsUsed: [
          ...decision.bindingsUsed,
          {
            proof: "delegated-execution-token",
            tokenId: token.tokenId,
            issuerPersonId: token.issuer.personId,
            runtimeSessionId: token.delegate.runtimeSessionId,
          },
        ],
      }
    : decision;
}

/**
 * One evaluation for every entry point: the acting person's Keycloak grants on one action and one
 * resource. A signed-in person presents their own token; a node's owner or the issuer behind an
 * execution token holds none here, so the center asks Keycloak about that person by id.
 */
export async function evaluateKeycloakPerson(input: {
  readonly credential: NonNullable<RepoCellBinding["keycloakAuthorization"]>;
  readonly personId: string;
  readonly action: string;
  readonly resource: AuthorizationResource;
  readonly fetchPort?: typeof fetch;
}): Promise<Pick<KeycloakPermissionDecision, "outcome" | "reasonCode">> {
  const { session, center } = input.credential;
  if (session?.personId === input.personId)
    return new KeycloakPolicyAdapter(
      { url: session.url, realm: session.realm, resourceServerClientId: session.clientId },
      input.fetchPort,
    ).authorize({ userAccessToken: session.accessToken, action: input.action, resource: input.resource });
  if (!center) return { outcome: "denied", reasonCode: "keycloak_denied" };
  return new KeycloakPolicyAdapter(
    { url: center.url, realm: center.realm, resourceServerClientId: center.clientId },
    input.fetchPort,
  ).authorizePerson({
    adminAccessToken: center.accessToken,
    personId: input.personId,
    action: input.action,
    resource: input.resource,
  });
}

export function authorizeRepoCellAction(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly revision: number;
  readonly now: string;
  readonly targetOverride?: EntityRef;
}): AuthorizationDecision {
  const target = input.targetOverride ?? actionTarget(input.action),
    envelope = composeDurableActionEnvelope({
      actionId: input.actionId,
      kind: input.action.kind,
      target,
      actor: input.binding.actor,
      idempotencyKey: typeof input.action.idempotencyKey === "string" ? input.action.idempotencyKey : input.actionId,
    }),
    decision = input.binding.authorizationDecision;
  return authorizeAction(envelope, {
    decision,
    evaluatedAtCut: `canonical:${input.revision}`,
  });
}

export function keycloakDecision(
  action: ReturnType<typeof composeDurableActionEnvelope>,
  evaluatedAtCut: string,
  outcome: AuthorizationDecision["outcome"],
  reasonCode: string,
): AuthorizationDecision {
  return Object.freeze({
    policyRef: "keycloak-policy@1",
    actor: action.actor,
    subject: action.target,
    bindingsUsed: Object.freeze([{ authority: "keycloak", scope: action.kind }]),
    outcome,
    reasonCodes: Object.freeze([reasonCode]),
    nextActions: Object.freeze(
      outcome === "allowed" ? [] : ["Sign in with Keycloak and request an applicable policy group."],
    ),
    evaluatedAtCut,
  });
}

/**
 * Concrete durable routes. Every case reaches the same port; no route grants authority here.
 * The exhaustive per-action cases look like duplication of durablePolicyActions, but they are
 * the static witness tools/gates/ontology-durable-action-authorization.mjs traces: each kind's
 * literal must sit in a region that provably reaches AuthorizationPort. Collapsing this into an
 * inventory-membership check breaks that trace for every action routed only here.
 */
function authorizeDurableRepoCellAction(input: Parameters<typeof authorizeRepoCellAction>[0]): AuthorizationDecision {
  switch (input.action.kind) {
    case "agent-delete":
      return authorizeRepoCellAction(input);
    case "agent-install":
      return authorizeRepoCellAction(input);
    case "agent-run":
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
    case "repo-purge":
      return authorizeRepoCellAction(input);
    case "repo-unbind":
      return authorizeRepoCellAction(input);
    case "daemon-service-install":
      return authorizeRepoCellAction(input);
    case "daemon-service-uninstall":
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
    case "decision-dispatch-review":
      return authorizeRepoCellAction(input);
    case "decision-propose":
      return authorizeRepoCellAction(input);
    case "decision-reckon":
      return authorizeRepoCellAction(input);
    case "decision-reject":
      return authorizeRepoCellAction(input);
    case "decision-rematerialize":
      return authorizeRepoCellAction(input);
    case "decision-repin":
      return authorizeRepoCellAction(input);
    case "decision-review":
      return authorizeRepoCellAction(input);
    case "decision-respond-review":
      return authorizeRepoCellAction(input);
    case "decision-override-review":
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
    case "entity-pin":
      return authorizeRepoCellAction(input);
    case "entity-unpin":
      return authorizeRepoCellAction(input);
    case "entity-update":
      return authorizeRepoCellAction(input);
    case "entity-archive":
      return authorizeRepoCellAction(input);
    case "entity-delete":
      return authorizeRepoCellAction(input);
    case "fact-archive":
      return authorizeRepoCellAction(input);
    case "fact-unarchive":
      return authorizeRepoCellAction(input);
    case "fact-reclassify":
      return authorizeRepoCellAction(input);
    case "fact-record":
      return authorizeRepoCellAction(input);
    case "fact-rematerialize":
      return authorizeRepoCellAction(input);
    case "fact-type-register":
      return authorizeRepoCellAction(input);
    case "migrate-import":
      return authorizeRepoCellAction(input);
    case "people-delegate":
      return authorizeRepoCellAction(input);
    case "people-revoke-delegation":
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
    case "squad-delete":
      return authorizeRepoCellAction(input);
    case "squad-install":
      return authorizeRepoCellAction(input);
    case "squad-run":
      return authorizeRepoCellAction(input);
    case "task-amend":
      return authorizeRepoCellAction(input);
    case "task-annotate":
      return authorizeRepoCellAction(input);
    case "task-archive":
      return authorizeRepoCellAction(input);
    case "task-artifact-add":
      return authorizeRepoCellAction(input);
    case "task-attest":
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
    case "task-dispatch-review":
      return authorizeRepoCellAction(input);
    case "task-pin":
      return authorizeRepoCellAction(input);
    case "task-rematerialize":
      return authorizeRepoCellAction(input);
    case "task-progress-append":
      return authorizeRepoCellAction(input);
    case "task-release":
      return authorizeRepoCellAction(input);
    case "task-reopen":
      return authorizeRepoCellAction(input);
    case "task-adjudicate":
      return authorizeRepoCellAction(input);
    case "task-review-consent":
      return authorizeRepoCellAction(input);
    case "task-review-execution":
      return authorizeRepoCellAction(input);
    case "task-settle":
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
    case "vertical-declaration-migrate":
      return authorizeRepoCellAction(input);
    case "vertical-kind-publish-schema":
      return authorizeRepoCellAction(input);
    case "vertical-kind-retire":
      return authorizeRepoCellAction(input);
    case "vertical-kind-upsert":
      return authorizeRepoCellAction(input);
    default:
      return authorizeRepoCellAction(input);
  }
}

export function bindVerifiedExecutorClaim(input: {
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly projection: Pick<
    TaskProjection,
    "read" | "readRuntimeSession" | "readRuntimeDispatch" | "currentLease" | "readDocument"
  >;
  readonly now: string;
  readonly executionDelegations?: readonly ExecutionDelegationRecord[];
}): { readonly action: RepoTaskAction; readonly binding: RepoCellBinding } {
  if (!Object.hasOwn(input.action, "executor")) return { action: input.action, binding: input.binding };
  const { executor: raw, ...action } = input.action;
  if (raw === undefined || raw === null) return { action, binding: input.binding };
  if (!isExecutorDescriptorRecord(raw) || raw.kind !== "agent" || typeof raw.id !== "string")
    throw invalidExecutorBindingFor(input, raw, "Executor claims must identify one agent actor.");
  if (!raw.id.startsWith("runtime-session:")) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(raw.id) ||
      Object.keys(raw).some((field) => field !== "kind" && field !== "id")
    )
      throw invalidExecutorBindingFor(input, raw, "Executor claims must use a valid agent id.");
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
    taskId = executorBindingTaskId(action),
    executionId = typeof action.executionId === "string" ? action.executionId : null;
  if (session === null)
    throw invalidExecutorBindingFor(
      input,
      raw,
      "The claimed RuntimeSession is not canonically bound to this Task action.",
    );
  const runtimeActor = {
    principal: input.binding.actor.principal,
    executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
  };
  // Review identity pins a submitted target, never ordinary write authority.
  if (action.kind === "decision-review") {
    const dispatch = input.projection.readRuntimeDispatch(runtimeSessionId),
      target = dispatch?.payload.reviewTarget;
    if (dispatch?.payload.role === "reviewer" && target?.kind === "decision" && target.decisionId === action.decisionId)
      return { action, binding: { ...input.binding, actor: runtimeActor } };
    throw invalidExecutorBindingFor(input, raw, "The reviewer is not dispatched to this Decision cut.");
  }
  if (action.kind === "task-review-execution" && taskId !== null && executionId !== null) {
    const target = input.projection
      .read(taskId)
      .snapshot.executions.find((candidate) => candidate.executionId === executionId && candidate.submission !== null);
    if (
      target &&
      session.taskBindings.some((candidate) => candidate.taskId === taskId && candidate.executionId === executionId)
    )
      return { action, binding: { ...input.binding, actor: runtimeActor } };
    throw invalidExecutorBindingFor(input, raw, "The reviewer is not bound to this submitted execution.");
  }
  const exactBinding =
      taskId === null
        ? session.taskBindings.length === 1
          ? session.taskBindings[0]
          : undefined
        : session.taskBindings.find((candidate) => candidate.taskId === taskId),
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
              candidateLease.phase === "held" &&
              isSameExecution(candidateLease.actor, candidateActor) &&
              stableStringify(candidateLease.source) === stableStringify(input.binding.source)
            );
          })
        : undefined,
    taskBinding = exactBinding ?? descendantBinding;
  if (!taskBinding) {
    // A DelegatedExecutionToken replaces exactly this one requirement — that the session itself is bound
    // to the target Task. Every other check still runs: the rewritten actor answers to the issuer's Policy
    // authority here, and the target Task's own lease rules apply downstream as if the issuer acted alone.
    const delegation = resolveDelegatedExecution(input, runtimeSessionId, action.kind);
    if (delegation.binding !== null) return { action, binding: delegation.binding };
    throw invalidExecutorBindingFor(
      input,
      raw,
      "The claimed RuntimeSession does not execute the target Task/Execution.",
      delegation.expectation ?? undefined,
    );
  }
  const lease = input.projection.currentLease(taskBinding.taskId, input.now),
    // Acquiring a lease is a lifecycle transition, not a write under a released lease.
    reacquiring = action.kind === "task-start" || action.kind === "task-contract-migrate";
  if (
    lease === null ||
    (lease.phase !== "held" && !(reacquiring && (lease.phase === "released" || lease.phase === "orphaned"))) ||
    (executionId !== null && executionId !== lease.executionId && action.kind !== "task-start") ||
    !isSameExecution(lease.actor, runtimeActor) ||
    stableStringify(lease.source) !== stableStringify(input.binding.source)
  )
    throw invalidExecutorBindingFor(
      input,
      raw,
      "The claimed RuntimeSession has no matching canonical execution lease.",
    );
  return { action, binding: { ...input.binding, actor: runtimeActor } };
}

interface DelegatedExecutionResolution {
  readonly binding: RepoCellBinding | null;
  readonly expectation: string | null;
}

interface DelegationFailure {
  readonly token: DelegatedExecutionToken;
  readonly reasonCode: DelegatedExecutionTokenReasonCode;
}

/** Resolve only records from the center private store at the current writer turn. */
function resolveDelegatedExecution(
  input: Parameters<typeof bindVerifiedExecutorClaim>[0],
  runtimeSessionId: string,
  actionKind: string,
): DelegatedExecutionResolution {
  const candidates = (input.executionDelegations ?? [])
    .filter(
      (record) =>
        stableStringify(record.source) === stableStringify(input.binding.source) &&
        record.token.issuer.personId === input.binding.actor.principal.personId &&
        record.token.delegate.runtimeSessionId === runtimeSessionId,
    )
    .map((record) => record.token);
  if (candidates.length === 0)
    return { binding: null, expectation: delegationAbsenceExpectation(runtimeSessionId, actionKind) };
  let failure: DelegationFailure | null = null;
  for (const token of candidates) {
    const actor = {
        principal: { personId: token.issuer.personId },
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      verification = verifyDelegatedExecutionToken(token, actor, actionKind, input.now);
    if (verification.ok)
      return {
        binding: {
          ...input.binding,
          actor,
          delegatedExecutionToken: token,
        },
        expectation: null,
      };
    failure ??= { token, reasonCode: verification.reasonCode };
  }
  return { binding: null, expectation: delegationFailureExpectation(failure!, runtimeSessionId, actionKind) };
}

function delegationAbsenceExpectation(runtimeSessionId: string, actionKind: string): string {
  return (
    `No DelegatedExecutionToken is issued to RuntimeSession ${runtimeSessionId}; ask the issuing principal to ` +
    `run ha people delegate --runtime-session-id ${runtimeSessionId} --action ${actionKind} ` +
    `--expires-at <timestamp>, then retry from that session.`
  );
}

function delegationFailureExpectation(
  failure: DelegationFailure,
  runtimeSessionId: string,
  actionKind: string,
): string {
  const token = failure.token,
    named = `DelegatedExecutionToken ${token.tokenId} for RuntimeSession ${runtimeSessionId}`,
    reissue =
      `ask the issuer to run ha people delegate --runtime-session-id ${runtimeSessionId} --action ${actionKind} ` +
      `--expires-at <timestamp>, then retry`;
  switch (failure.reasonCode) {
    case "delegated_token_expired":
      return `${named} expired at ${token.expiresAt}; ${reissue}.`;
    case "delegated_token_revoked":
      return `${named} was revoked at ${token.revokedAt}; ${reissue}.`;
    case "delegated_token_action_forbidden":
      return (
        `DelegatedExecutionToken ${token.tokenId} does not allow ${actionKind}; ask issuer ` +
        `${token.issuer.personId} to include the Action in the delegated set, then retry.`
      );
    case "delegated_token_not_yet_valid":
      return `${named} is not valid before ${token.issuedAt}; retry after that time.`;
    default:
      return `${named} failed verification (${failure.reasonCode}); ${reissue}.`;
  }
}

function actionTarget(action: RepoTaskAction): EntityRef {
  if (typeof action.entityRef === "string" && parseEntityRef(action.entityRef) !== null)
    return action.entityRef as EntityRef;
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
  delegationExpectation?: string,
): Error & { readonly code: "executor_binding_invalid" } {
  const taskId = executorBindingTaskId(input.action),
    requestedExecutionId = typeof input.action.executionId === "string" ? input.action.executionId : null,
    lease = taskId === null ? null : input.projection.currentLease(taskId, input.now),
    executionId = requestedExecutionId ?? lease?.executionId ?? null,
    actual =
      isExecutorDescriptorRecord(raw) && raw.kind === "agent" && typeof raw.id === "string"
        ? `agent:${raw.id}`
        : "malformed executor descriptor",
    expected = lease?.actor.executor ? `agent:${lease.actor.executor.id}` : null,
    retry = executorRetryCommand(input.action, taskId, executionId),
    runtimeSessionId =
      isExecutorDescriptorRecord(raw) &&
      raw.kind === "agent" &&
      typeof raw.id === "string" &&
      raw.id.startsWith("runtime-session:")
        ? raw.id.slice("runtime-session:".length)
        : null,
    runtimeSession = runtimeSessionId === null ? null : input.projection.readRuntimeSession(runtimeSessionId),
    canonicalTaskId =
      taskId === null || runtimeSession === null
        ? null
        : (runtimeSession.taskBindings.find((candidate) => {
            if (candidate.taskId === taskId) return false;
            const packagePath = input.projection.read(candidate.taskId).packagePath;
            return packagePath !== null && path.posix.basename(packagePath) === taskId;
          })?.taskId ?? null),
    reviewerRedispatch =
      input.action.kind === "task-review-execution" &&
      taskId !== null &&
      isExecutorDescriptorRecord(raw) &&
      raw.kind === "agent" &&
      typeof raw.id === "string" &&
      raw.id.startsWith("runtime-session:"),
    wrongExecution =
      !reviewerRedispatch &&
      requestedExecutionId !== null &&
      lease !== null &&
      requestedExecutionId !== lease.executionId,
    missingRequestedBinding =
      taskId !== null &&
      runtimeSession !== null &&
      !runtimeSession.taskBindings.some((candidate) => candidate.taskId === taskId),
    sameExecutor =
      lease?.actor.executor !== null &&
      runtimeSessionId !== null &&
      lease?.actor.executor?.kind === "agent" &&
      lease.actor.executor.id === `runtime-session:${runtimeSessionId}`,
    principalMismatch = sameExecutor && lease.actor.principal.personId !== input.binding.actor.principal.personId,
    sourceMismatch =
      sameExecutor && !principalMismatch && stableStringify(lease.source) !== stableStringify(input.binding.source),
    // Identity and write source already answer to the lease holder, so the only unmet requirement is
    // the phase; the expectation must name that phase (and, past submit, the frozen cut), never echo
    // the claimant's own executor id back as the missing party.
    leaseTargetTaskId =
      taskId ??
      (runtimeSession !== null && runtimeSession.taskBindings.length === 1
        ? runtimeSession.taskBindings[0]!.taskId
        : null),
    claimantLease = leaseTargetTaskId === null ? null : input.projection.currentLease(leaseTargetTaskId, input.now),
    claimantHoldsLeaseIdentity =
      claimantLease !== null &&
      claimantLease.phase !== "held" &&
      runtimeSessionId !== null &&
      isSameExecution(claimantLease.actor, {
        principal: input.binding.actor.principal,
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      }) &&
      stableStringify(claimantLease.source) === stableStringify(input.binding.source),
    claimantTaskStatus =
      claimantHoldsLeaseIdentity && leaseTargetTaskId !== null
        ? (input.projection.read(leaseTargetTaskId).snapshot.task?.status ?? null)
        : null,
    expectation = canonicalTaskId
      ? `The supplied taskId matches the bound package basename; use canonical taskId ${canonicalTaskId}, then retry ` +
        executorRetryCommand(input.action, canonicalTaskId, executionId)
      : reviewerRedispatch
        ? `Expected a reviewer RuntimeSession bound to execution ${executionId ?? "<execution-id>"}; run ` +
          `ha task dispatch-review ${taskId} --agent <reviewer-agent-id>, then retry ${retry}`
        : wrongExecution
          ? `Expected executionId ${lease!.executionId} from the current lease; received executionId ${requestedExecutionId}`
          : delegationExpectation
            ? delegationExpectation
            : missingRequestedBinding
              ? `Expected the claimed RuntimeSession to have canonical Task/Execution binding ` +
                `${taskId}/${executionId ?? "<execution-id>"}; retry ${retry} from that bound session`
              : principalMismatch
                ? `Expected principal ${lease.actor.principal.personId} from the held execution lease; received ` +
                  `principal ${input.binding.actor.principal.personId}`
                : sourceMismatch
                  ? `Expected write source ${stableStringify(lease.source)} from the held execution lease; received ` +
                    `write source ${stableStringify(input.binding.source)}`
                  : claimantHoldsLeaseIdentity
                    ? claimantTaskStatus === "submitted" || claimantTaskStatus === "in_review"
                      ? `Expected a held execution lease, but task ${leaseTargetTaskId} already left implementation: the ` +
                        `round was submitted and its cut is frozen — worker writes happen BEFORE ha task submit; if ` +
                        `artifacts must still land, the owner returns the cut with ha task adjudicate ` +
                        `${leaseTargetTaskId} --return and the work is resubmitted with them`
                      : `Expected a held execution lease, but the lease on task ${leaseTargetTaskId} is ` +
                        `${claimantLease!.phase}; reacquire it with ha task start ${leaseTargetTaskId}, then retry ${retry}`
                    : expected
                      ? `Expected ${expected} from the held execution lease; run from that executor, then retry ${retry}`
                      : "Expected a task-bound executor with a matching held execution lease; run ha task start " +
                        `${taskId ?? "<task-id>"}, then retry ${retry}`,
    diagnostic: ReceiptDiagnostic = {
      kind: "validation",
      entity: [taskId ? `task ${taskId}` : "repository", executionId ? `execution ${executionId}` : ""]
        .filter(Boolean)
        .join(" "),
      field: canonicalTaskId
        ? "taskId"
        : wrongExecution
          ? "executionId"
          : principalMismatch
            ? "principal"
            : sourceMismatch
              ? "source"
              : "executor",
      actual: canonicalTaskId
        ? taskId!
        : wrongExecution
          ? requestedExecutionId!
          : principalMismatch
            ? input.binding.actor.principal.personId
            : sourceMismatch
              ? stableStringify(input.binding.source)
              : actual,
      expectation,
    };
  return Object.assign(new Error(message), { code: "executor_binding_invalid" as const, diagnostic });
}

function executorBindingTaskId(action: RepoTaskAction): string | null {
  if (action.kind === "task-create" && typeof action.parentTaskId === "string") return action.parentTaskId;
  return typeof action.taskId === "string" ? action.taskId : null;
}

function executorRetryCommand(action: RepoTaskAction, taskId: string | null, executionId: string | null): string {
  const task = taskId ?? "<task-id>",
    execution = executionId ?? "<execution-id>";
  switch (action.kind) {
    case "task-submit":
      return `ha task submit ${task} --execution-id ${execution}`;
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

export function withAuthorizationDecision(
  receipt: WriteReceiptDraft,
  authorizationDecision: AuthorizationDecision,
  unmetCriteria: readonly EntityActionUnmetCriterionV1[] = receipt.unmetCriteria ?? [],
  rejectionExplanation: string | undefined = receipt.rejectionExplanation ?? undefined,
): WriteReceipt {
  const summary = (receipt as WriteReceipt & Readonly<{ readonly summary?: unknown }>).summary,
    summaryExplanation = typeof summary === "string" && summary.trim() ? summary : undefined;
  return {
    acceptance: null,
    projection: { state: "pending", cut: null },
    git: { state: "pending", cut: null, commitSha: null },
    worktree: { state: "pending", cut: null },
    replica: { state: "not_configured", cut: null },
    ...receipt,
    status: receipt.outcome === "no_changes" ? "settled_no_write" : "unknown",
    authorizationDecision,
    unmetCriteria,
    rejectionExplanation:
      receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate"
        ? (rejectionExplanation ??
          summaryExplanation ??
          `Action rejected after ${authorizationDecision.policyRef} qualification.`)
        : null,
    nextActions: Object.freeze([...new Set([...(receipt.nextActions ?? []), ...authorizationDecision.nextActions])]),
  };
}
