import {
  deriveRelationId,
  isRelationEvent,
  relationEventWritePlan,
  relationStrengthForType,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type EntityActionContract,
  type EntityActionExecutionContract,
  type EventPublicationKillpoint,
  type SessionIdentity,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

type ExecutableRelationAction = EntityActionContract & { readonly execution: EntityActionExecutionContract };

export function executeRelationAction(input: {
  readonly contract: ExecutableRelationAction;
  readonly action: RepoTaskAction;
  readonly binding: RepoCellBinding;
  readonly opId: string;
  readonly occurredAt: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly sessionIdentity: (binding: RepoCellBinding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
}): WriteReceipt {
  const { action, authorizationDecision, binding, contract, opId, occurredAt } = input,
    expectedVersion = action.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)
    reject("invalid_command", "Relation actions require a non-negative integer expectedVersion.");
  const requestedRelationId =
      action.kind === "relation-relate"
        ? deriveRelationId({
            source: requiredText(action.sourceRef, "sourceRef"),
            target: requiredText(action.targetRef, "targetRef"),
            type: requiredText(action.relationType, "relationType") as never,
            direction: (typeof action.direction === "string" ? action.direction : "directed") as "directed",
          })
        : requiredText(action.relationId, "relationId"),
    current = input.projection.readRelationTruth().edges.find((edge) => edge.relationId === requestedRelationId) as
      | (ReturnType<TaskProjection["readRelationTruth"]>["edges"][number] & {
          readonly workspaceRevision?: number;
        })
      | undefined,
    targetRef = action.kind === "relation-relate" ? String(action.targetRef) : current?.targetRef,
    target = targetRef ? input.projection.readEntityVersionWitness(targetRef) : null,
    replay = input.store.readEvent(opId),
    headRevision = input.store.readHead()?.revision ?? 0,
    draft = replay
      ? null
      : contract.execution.compile?.({
          action,
          actor: binding.actor,
          source: binding.source,
          session: input.sessionIdentity(binding),
          opId,
          occurredAt,
          workspaceRevision: headRevision + 1,
          priorTargetVersion: current?.targetObservedVersion ?? null,
          currentTargetVersion: target?.currentVersion ?? null,
        }),
    compiled = replay ?? (draft?.kind === "relation" ? draft.event : null);
  if (!compiled || !isRelationEvent(compiled))
    reject("invalid_command", `${action.kind} did not compile a Relation event.`);
  const relationId = compiled.relationId;
  if (relationId !== requestedRelationId) reject("invalid_command", "Relation action identity changed during compile.");
  if (compiled.type === "relation_created" && current) {
    const candidate = compiled.payload.relation,
      same =
        current.sourceRef === candidate.source &&
        current.targetRef === candidate.target &&
        current.relationType === candidate.type &&
        current.direction === candidate.direction &&
        current.strength === relationStrengthForType(candidate.type) &&
        current.origin === candidate.origin &&
        current.rationale === candidate.rationale &&
        current.state === "active";
    if (!same) reject("revision_conflict", `Relation ${relationId} already exists with different projected facets.`);
    const revision = current.workspaceRevision ?? headRevision;
    return noChanges({ relationId, revision, headRevision, opId, authorizationDecision });
  }
  const aggregateRevision = current?.workspaceRevision ?? 0;
  if (Number(expectedVersion) !== aggregateRevision)
    reject(
      compiled.type === "relation_reconfirmed" ? "version_conflict" : "revision_conflict",
      `Relation ${relationId} expected revision ${String(expectedVersion)}, current revision is ${aggregateRevision}.`,
    );
  if (
    (compiled.type === "relation_retired" || compiled.type === "relation_reconfirmed") &&
    (!current || current.state !== "active")
  )
    reject("entity_not_found", `Relation ${relationId} is not an active aggregate.`);
  if (
    compiled.type === "relation_reconfirmed" &&
    current?.targetObservedVersion === compiled.payload.targetObservedVersion
  )
    return noChanges({
      relationId,
      revision: aggregateRevision,
      headRevision,
      opId,
      authorizationDecision,
      sameResult: true,
    });
  if (
    compiled.type === "relation_created" &&
    compiled.payload.relation.type === "depends-on" &&
    hasRelationPath(
      input.projection.readRelationTruth().edges,
      compiled.payload.relation.target,
      compiled.payload.relation.source,
    )
  )
    reject("relation_cycle", "The requested depends-on Relation would create a blocking cycle.");
  const plan = relationEventWritePlan(compiled),
    appended = input.store.append({ event: compiled, plan, blobs: [] });
  if (replay === null) input.projection.apply(compiled, plan);
  publicationKillpoints(input.killpoint);
  const projected = input.projection.readRelationTruth().edges.find((edge) => edge.relationId === relationId),
    visible =
      projected !== undefined &&
      projected.state === (compiled.type === "relation_retired" ? "retired" : "active") &&
      (compiled.type !== "relation_reconfirmed" || projected.freshness === "current");
  return {
    outcome: visible ? "applied" : "pending",
    opId,
    revision: appended.revision,
    evidence: JSON.stringify({
      schema: "relation-action-history/v1",
      relationId,
      eventType: compiled.type,
      aggregateRevision: appended.revision,
      executor: binding.actor.executor,
      executionId: binding.assignmentScope?.scope.kind === "task" ? binding.assignmentScope.scope.executionId : null,
    }),
    visibility: "center",
    proof: {
      committedRevision: appended.revision,
      appliedCut: appended.revision,
      durable: visible,
      canonicalVisible: visible,
      worktreeVisible: null,
    },
    authorizationDecision,
    relationId,
    ...(!visible ? { nextAction: `Query receipt ${opId} after the Relation projection catches up.` } : {}),
  } as WriteReceipt;
}

function noChanges(input: {
  readonly relationId: string;
  readonly revision: number;
  readonly headRevision: number;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly sameResult?: true;
}): WriteReceipt {
  return {
    outcome: "no_changes",
    opId: `noop:${input.opId}`,
    revision: input.revision,
    evidence: JSON.stringify({
      relationId: input.relationId,
      idempotent: true,
      ...(input.sameResult ? { sameResult: true } : {}),
      aggregateRevision: input.revision,
    }),
    visibility: "center",
    proof: {
      committedRevision: input.revision,
      appliedCut: input.headRevision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: null,
    },
    authorizationDecision: input.authorizationDecision,
    relationId: input.relationId,
  } as WriteReceipt;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  reject("invalid_command", `${field} is required.`);
}

function hasRelationPath(
  edges: ReturnType<TaskProjection["readRelationTruth"]>["edges"],
  start: string,
  goal: string,
): boolean {
  const graph = new Map<string, string[]>();
  for (const edge of edges)
    if (edge.state === "active" && edge.relationType === "depends-on")
      graph.set(edge.sourceRef, [...(graph.get(edge.sourceRef) ?? []), edge.targetRef]);
  const queue = [start],
    seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(graph.get(current) ?? []));
  }
  return false;
}

function reject(
  code: "entity_not_found" | "invalid_command" | "relation_cycle" | "revision_conflict" | "version_conflict",
  message: string,
): never {
  throw Object.assign(new Error(message), { code });
}

function publicationKillpoints(killpoint: ((point: EventPublicationKillpoint) => void) | undefined): void {
  killpoint?.("after_sqlite_commit");
  killpoint?.("before_response_write");
  killpoint?.("after_response_write");
}
