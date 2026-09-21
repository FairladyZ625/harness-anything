import {
  compileRelationDocumentWrite,
  DECISION_DOCUMENT_POLICY_ID,
  deriveRelationId,
  FACT_DOCUMENT_POLICY_ID,
  factLiveness,
  isRelationEvent,
  parseEntityRef,
  reduceRelationEntity,
  relationRecord,
  relationEventWritePlan,
  relationStrengthForType,
  renderDecisionDocument,
  renderFactsDocument,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type EntityActionContract,
  type EntityActionExecutionContract,
  type EventPublicationKillpoint,
  type RelationDocumentUpdate,
  type RelationEventV1,
  type SessionIdentity,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { relationDirectionRegistry } from "./artifact-entity-action.ts";
import { decisionRelationLinkResolver } from "./entity-document-links.ts";
import { noChanges, reject } from "./entity-action-write-helpers.ts";
export { reject } from "./entity-action-write-helpers.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

type ExecutableRelationAction = EntityActionContract & { readonly execution: EntityActionExecutionContract };

export function executeRelationAction(input: {
  readonly rootDir: string;
  readonly repositoryId: string;
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
    expectedVersion = action.expectedVersion,
    sourceRef = action.kind === "relation-relate" ? requiredRelationText(action.sourceRef, "sourceRef") : null,
    requestedTargetRef = action.kind === "relation-relate" ? requiredRelationText(action.targetRef, "targetRef") : null;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)
    reject("invalid_command", "Relation actions require a non-negative integer expectedVersion.");
  const requestedRelationId =
      action.kind === "relation-relate"
        ? deriveRelationId({
            source: sourceRef!,
            target: requestedTargetRef!,
            type: requiredRelationText(action.relationType, "relationType") as never,
            direction: (typeof action.direction === "string" ? action.direction : "directed") as "directed",
          })
        : requiredRelationText(action.relationId, "relationId"),
    current = input.projection.readRelationEdge(requestedRelationId),
    targetRef = requestedTargetRef ?? current?.targetRef,
    source = sourceRef ? input.projection.readEntityVersionWitness(sourceRef) : null,
    target = targetRef ? input.projection.readEntityVersionWitness(targetRef) : null,
    replay = input.store.readEvent(opId),
    headRevision = input.store.readHead()?.revision ?? 0,
    lookupCut = input.projection.readCut(),
    lookupNote = ` (looked up at projection watermark ${lookupCut.watermark}, write head ${headRevision}).`;
  if (action.kind === "relation-relate") {
    if (source?.currentVersion === null)
      reject("entity_not_found", `Relation source ${sourceRef} does not exist${lookupNote}`);
    if (target?.currentVersion === null)
      reject("entity_not_found", `Relation target ${targetRef} does not exist${lookupNote}`);
    if (!replay && action.relationType === "evidenced-by") {
      const ref = parseEntityRef(sourceRef!),
        claims = ref?.kind === "decision" ? input.projection.readDecision(ref.id).decision?.claims : undefined;
      if (claims && !claims.some((claim) => claim.id === ref?.anchor))
        reject(
          "relation_source_anchor_invalid",
          `evidenced-by requires a declared claim source; ${sourceRef} is not a claim. ` +
            `Use --source-ref ${
              claims.map((claim) => `decision/${ref!.id}/${claim.id}`).join(" or ") ||
              `decision/${ref!.id}/<claim-id> (declare a claim first)`
            }.`,
        );
    }
  }
  const draft = replay
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
          relationDirections: relationDirectionRegistry(input.projection, input.repositoryId),
        }),
    compiled = replay ?? (draft?.kind === "relation" ? draft.event : null);
  if (!compiled || !isRelationEvent(compiled))
    reject("invalid_command", `${action.kind} did not compile a Relation event.`);
  const relationId = compiled.relationId;
  if (relationId !== requestedRelationId) reject("invalid_command", "Relation action identity changed during compile.");
  const dependenciesCaughtUp = lookupCut.status === "ready" && lookupCut.watermark === headRevision;
  if (!replay && !dependenciesCaughtUp) reject("content_not_ready", `Relation dependencies are pending${lookupNote}`);
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
    return relationNoChanges({
      relationId,
      revision: current.workspaceRevision,
      headRevision,
      opId,
      authorizationDecision,
    });
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
    reject("entity_not_found", `Relation ${relationId} is not an active aggregate${lookupNote}`);
  if (
    compiled.type === "relation_reconfirmed" &&
    current?.targetObservedVersion === compiled.payload.targetObservedVersion
  )
    return relationNoChanges({
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
    hasRelationPath(input.projection, compiled.payload.relation.target, compiled.payload.relation.source)
  )
    reject("relation_cycle", "The requested depends-on Relation would create a blocking cycle.");
  const bundle = replay
      ? relationReplayBundle(input.store, compiled)
      : compileRelationDocumentWrite(compiled, relationDocumentUpdates(input.projection, compiled, current)),
    plan = bundle.plan,
    published = bundle.event,
    appended = input.store.append({ event: published, plan, blobs: bundle.blobs });
  if (replay === null) input.projection.apply(published, plan);
  publicationKillpoints(input.killpoint);
  const projected = input.projection.readRelationEdge(relationId),
    visible =
      projected !== null &&
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
  } as WriteReceipt;
}

function relationDocumentUpdates(
  projection: TaskProjection,
  event: RelationEventV1,
  current: ReturnType<TaskProjection["readRelationEdge"]>,
): readonly RelationDocumentUpdate[] {
  const next = reduceRelationEntity(current?.entity ?? null, event),
    endpoints = [current?.entity, next].filter((value) => value !== undefined),
    decisionIds = new Set<string>(),
    factIds = new Set<string>();
  for (const endpoint of endpoints) {
    const source = parseEntityRef(endpoint.source),
      target = parseEntityRef(endpoint.target);
    if (source?.kind === "decision") decisionIds.add(source.id);
    if (target?.kind === "decision") decisionIds.add(target.id);
    if (endpoint.type === "supersedes-fact" && target?.kind === "fact") factIds.add(target.id);
  }
  return [
    ...[...decisionIds].sort().map((decisionId) => decisionDocumentUpdate(projection, event, next, decisionId)),
    ...[...factIds].sort().map((factId) => factDocumentUpdate(projection, event, next, factId)),
  ];
}

function decisionDocumentUpdate(
  projection: TaskProjection,
  event: RelationEventV1,
  next: ReturnType<typeof reduceRelationEntity>,
  decisionId: string,
): RelationDocumentUpdate {
  const state = projection.readDecisionDocumentState?.(decisionId),
    path = `decisions/decision-${decisionId}/decision.md`,
    document = projection.readDocument(path).document;
  if (!state || !document) reject("content_not_ready", `Decision document ${path} is unavailable.`);
  const relations = overlayRelation(
      relationRows(projection.readRelationQuery({ ownerRef: `decision/${decisionId}` }).rows),
      next,
    ).filter(({ source }) => {
      const owner = parseEntityRef(source);
      return owner?.kind === "decision" && owner.id === decisionId;
    }),
    incoming = overlayRelation(relationRows(projection.readDecisionIncomingRelations(decisionId)), next).filter(
      ({ target }) => {
        const owner = parseEntityRef(target);
        return owner?.kind === "decision" && owner.id === decisionId;
      },
    );
  return {
    path,
    policyId: DECISION_DOCUMENT_POLICY_ID,
    body: renderDecisionDocument(
      { ...state, workspaceRevision: event.workspaceRevision, relations },
      document.body,
      undefined,
      null,
      incoming,
      decisionRelationLinkResolver(projection),
    ),
  };
}

function factDocumentUpdate(
  projection: TaskProjection,
  event: RelationEventV1,
  next: ReturnType<typeof reduceRelationEntity>,
  factId: string,
): RelationDocumentUpdate {
  const fact = projection.readFact(factId).fact,
    path = `facts/${factId}.md`;
  if (!fact || !projection.readDocument(path).document)
    reject("content_not_ready", `Fact document ${path} is unavailable.`);
  const incoming = overlayRelation(
      relationRows(projection.readRelationQuery({ target: `fact/${factId}`, relationType: "supersedes-fact" }).rows),
      next,
    ).filter(
      ({ target, type, state }) => target === `fact/${factId}` && type === "supersedes-fact" && state === "active",
    ),
    state = factLiveness(
      { ref: fact.ref },
      incoming.map(({ source, target, type, state: relationState }) => ({
        sourceRef: source,
        targetRef: target,
        relationType: type,
        state: relationState,
      })),
    );
  return {
    path,
    policyId: FACT_DOCUMENT_POLICY_ID,
    body: renderFactsDocument([
      {
        factId,
        ...(fact.taskId ? { taskId: fact.taskId } : {}),
        statement: fact.statement,
        evidenceSource: fact.evidenceSource,
        observedAt: fact.observedAt,
        confidence: fact.confidence,
        state,
        supersededBy: incoming.map(({ source, rationale }) => ({ factRef: source, rationale })),
        workspaceRevision: event.workspaceRevision,
      },
    ]),
  };
}

type RelationRowSource = Pick<
  ReturnType<TaskProjection["readRelationQuery"]>["rows"][number],
  | "relationId"
  | "sourceRef"
  | "targetRef"
  | "relationType"
  | "strength"
  | "direction"
  | "origin"
  | "rationale"
  | "state"
>;

function relationRows(rows: readonly RelationRowSource[]) {
  return rows.map((edge) => ({
    relation_id: edge.relationId,
    source: edge.sourceRef,
    target: edge.targetRef,
    type: edge.relationType,
    strength: edge.strength,
    direction: edge.direction,
    origin: edge.origin,
    rationale: edge.rationale,
    state: edge.state,
  }));
}

function overlayRelation(
  relations: ReturnType<typeof relationRows>,
  next: ReturnType<typeof reduceRelationEntity>,
): ReturnType<typeof relationRows> {
  const { targetObservedVersion: _targetObservedVersion, ...record } = relationRecord(next);
  return [...relations.filter(({ relation_id }) => relation_id !== record.relation_id), record].sort((left, right) =>
    left.relation_id.localeCompare(right.relation_id),
  );
}

function relationReplayBundle(
  store: Pick<CanonicalEventStore, "readContentBlob">,
  event: RelationEventV1,
): ReturnType<typeof compileRelationDocumentWrite> {
  const blobs = (event.payload.documentClaims ?? []).map((claim) => {
    const bytes = store.readContentBlob(claim.sha256);
    if (!bytes) reject("content_not_ready", `Relation content for ${claim.path} is unavailable.`);
    return {
      sha256: claim.sha256,
      size: claim.size,
      mediaType: claim.mediaType,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  });
  return { event, plan: relationEventWritePlan(event), blobs };
}

function relationNoChanges(input: {
  readonly relationId: string;
  readonly revision: number;
  readonly headRevision: number;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly sameResult?: true;
}): WriteReceipt {
  return noChanges({
    opId: `noop:${input.opId}`,
    revision: input.revision,
    headRevision: input.headRevision,
    evidence: JSON.stringify({
      relationId: input.relationId,
      idempotent: true,
      ...(input.sameResult ? { sameResult: true } : {}),
      aggregateRevision: input.revision,
    }),
    authorizationDecision: input.authorizationDecision,
    relationId: input.relationId,
  }) as WriteReceipt;
}

function requiredRelationText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  reject("invalid_command", `${field} is required.`);
}

function hasRelationPath(projection: TaskProjection, start: string, goal: string): boolean {
  const queue = [start],
    seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(
      ...projection
        .readRelationQuery({ source: current, relationType: "depends-on", state: "active" })
        .rows.map((edge) => edge.targetRef),
    );
  }
  return false;
}

export function publicationKillpoints(killpoint: ((point: EventPublicationKillpoint) => void) | undefined): void {
  killpoint?.("after_sqlite_commit");
  killpoint?.("before_response_write");
  killpoint?.("after_response_write");
}
