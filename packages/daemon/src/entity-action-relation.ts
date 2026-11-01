import { createHash } from "node:crypto";
import {
  compileRelationDocumentWrite,
  compileRelationRetiredEvent,
  DECISION_DOCUMENT_POLICY_ID,
  deriveRelationId,
  derivesRelationClause,
  FACT_DOCUMENT_POLICY_ID,
  factLiveness,
  isRelationEvent,
  parseEntityRef,
  reduceRelationEntity,
  relationRecord,
  findRelationCycleWitnesses,
  isAcyclicRelationType,
  relationEventWritePlan,
  assignmentRationale,
  relationStrengthForType,
  renderDecisionDocument,
  renderFactsDocument,
  type AuthorizationDecision,
  type CanonicalWriteBundle,
  type CanonicalEventStore,
  type EntityActionContract,
  type EntityActionExecutionContract,
  type EventPublicationKillpoint,
  type RelationDocumentUpdate,
  type RelationEventV1,
  type RelationCycleEdge,
  type RelationCycleWitness,
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
  readonly compileSupersededDecision?: (input: {
    readonly decisionId: string;
    readonly opId: string;
    readonly occurredAt: string;
    readonly workspaceRevision: number;
    readonly relationBundle: CanonicalWriteBundle | null;
  }) => CanonicalWriteBundle;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
}): WriteReceipt {
  const { action, authorizationDecision, binding, contract, opId, occurredAt } = input,
    expectedVersion = action.expectedVersion,
    assignment = contract.id === "assign" || contract.id === "unassign",
    sourceRef =
      action.kind === "relation-relate"
        ? requiredRelationText(action.sourceRef, "sourceRef")
        : assignment
          ? assignmentSourceRef(action, contract.target.kind)
          : null,
    requestedTargetRef =
      action.kind === "relation-relate"
        ? requiredRelationText(action.targetRef, "targetRef")
        : assignment && contract.id === "assign"
          ? assignmentTargetRef(action)
          : null;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)
    reject("invalid_command", "Relation actions require a non-negative integer expectedVersion.");
  const replay = input.store.readEvent(opId),
    assignmentRows = assignment
      ? input.projection.readRelationQuery({ source: sourceRef!, relationType: "assigned-to" }).rows
      : [],
    activeAssignments = assignmentRows.filter((row) => row.state === "active"),
    activeAssignment = activeAssignments[0] ?? null,
    assignmentRevision = assignmentRows.reduce((revision, row) => Math.max(revision, row.workspaceRevision ?? 0), 0);
  if (activeAssignments.length > 1)
    reject("invalid_store", `Entity ${sourceRef} has more than one active assigned-to relation.`);
  const requestedRelationId =
      action.kind === "relation-relate"
        ? deriveRelationId({
            source: sourceRef!,
            target: requestedTargetRef!,
            type: requiredRelationText(action.relationType, "relationType") as never,
            direction: (typeof action.direction === "string" ? action.direction : "directed") as "directed",
          })
        : assignment
          ? contract.id === "assign"
            ? deriveRelationId({
                source: sourceRef!,
                target: requestedTargetRef!,
                type: "assigned-to",
                direction: "directed",
              })
            : (activeAssignment?.relationId ?? (replay && isRelationEvent(replay) ? replay.relationId : ""))
          : requiredRelationText(action.relationId, "relationId"),
    supersedingDecisionTargetId = supersedesDecisionTargetId(action),
    supersedingReplay =
      replay?.schema === "decision-event/v1" &&
      replay.type === "decision_superseded" &&
      replay.decisionId === supersedingDecisionTargetId,
    supersededDecisionId =
      supersedingDecisionTargetId &&
      (input.projection.readDecision(supersedingDecisionTargetId).decision?.state === "proposed" || supersedingReplay)
        ? supersedingDecisionTargetId
        : null,
    current = input.projection.readRelationEdge(requestedRelationId),
    targetRef = requestedTargetRef ?? current?.targetRef,
    source = sourceRef ? input.projection.readEntityVersionWitness(sourceRef) : null,
    target = targetRef ? relationTargetWitness(input, targetRef) : null,
    headRevision = input.store.readHead()?.revision ?? 0,
    lookupCut = input.projection.readCut(),
    lookupNote = ` (looked up at projection watermark ${lookupCut.watermark}, write head ${headRevision}).`;
  if (supersedingReplay) {
    if (
      !supersededDecisionId ||
      current?.state !== "active" ||
      current.sourceRef !== sourceRef ||
      current.targetRef !== targetRef ||
      current.relationType !== "supersedes"
    )
      reject(
        "invalid_store",
        `Decision ${supersededDecisionId ?? "<unknown>"} supersession replay has no active Relation.`,
      );
    const transitionEvent = replay!;
    return {
      outcome: "applied",
      opId,
      revision: transitionEvent.workspaceRevision,
      evidence: JSON.stringify({
        schema: "relation-action-history/v1",
        relationId: requestedRelationId,
        eventType: "relation_created",
        aggregateRevision: transitionEvent.workspaceRevision,
        executor: binding.actor.executor,
        executionId: null,
      }),
      visibility: "center",
      proof: {
        committedRevision: transitionEvent.workspaceRevision,
        appliedCut: input.projection.readCut().watermark,
        durable: true,
        canonicalVisible: input.projection.readCut().watermark >= transitionEvent.workspaceRevision,
        worktreeVisible: null,
      },
      authorizationDecision,
      relationId: requestedRelationId,
    } as WriteReceipt;
  }
  if (action.kind === "relation-relate") {
    if (!assignment && action.relationType === "assigned-to")
      reject("invalid_command", "assigned-to is managed by the entity assign Action; use ha <kind> assign.");
    // A ref the grammar does not recognize and a ref whose entity is absent both read as
    // `currentVersion: null`, so the existence check below would answer a spelling mistake with
    // "does not exist ... (looked up at projection watermark N, write head N)" and send the caller
    // hunting a projection delay. Judge the grammar first and name the accepted spelling.
    requireRelationEndpointRef(sourceRef!, "source");
    if (!assignment) requireRelationEndpointRef(targetRef!, "target");
    if (source?.currentVersion === null)
      reject("entity_not_found", `Relation source ${sourceRef} does not exist${lookupNote}`);
    if (target?.currentVersion === null && !assignment)
      reject("entity_not_found", `Relation target ${targetRef} does not exist${lookupNote}`);
    // The dispatch gate's own clause judgment, applied at the write boundary: a task derives from a decision clause,
    // never from the decision as a whole. Other derives targets are not dispatch prerequisites and keep their shape.
    if (
      !replay &&
      action.relationType === "derives" &&
      requestedTargetRef?.startsWith("task/") &&
      derivesRelationClause(sourceRef!) === null
    ) {
      const ref = parseEntityRef(sourceRef!),
        decision = ref?.kind === "decision" ? input.projection.readDecision(ref.id).decision : null,
        hint =
          ref?.kind === "decision"
            ? [...(decision?.chosen ?? []), ...(decision?.claims ?? [])].map(({ id }) => `decision/${ref.id}/${id}`)
            : [];
      reject(
        "relation_source_anchor_invalid",
        `derives requires a decision clause source of the form decision/<decision-id>/<clause-id>; ` +
          `${sourceRef} is not one. Use --source-ref ${
            hint.join(" or ") || `decision/${ref?.kind === "decision" ? ref.id : "<decision-id>"}/<clause-id>`
          }.`,
      );
    }
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
  if (
    assignment &&
    (parseEntityRef(sourceRef!)?.kind !== contract.target.kind ||
      (contract.id === "assign" && !["person", "node", "team"].includes(parseEntityRef(targetRef ?? "")?.kind ?? "")))
  )
    reject(
      "invalid_command",
      `${contract.execution.ingress} requires a ${contract.target.kind} source and a person, node or team target.`,
    );
  if (assignment && source?.currentVersion === null)
    reject("entity_not_found", `Assignment source ${sourceRef} does not exist${lookupNote}`);
  if (!assignment && action.kind === "relation-unrelate" && current?.relationType === "assigned-to")
    reject("invalid_command", "assigned-to is managed by the entity unassign Action; use ha <kind> unassign.");
  if (assignment && contract.id === "unassign" && activeAssignment === null && !replay)
    reject("entity_not_found", `Entity ${sourceRef} has no active assignment${lookupNote}`);
  const requestedRationale =
      typeof action.expiresAt === "string" && action.expiresAt.trim()
        ? assignmentRationale(action.expiresAt)
        : "assigned-to",
    replacing =
      assignment &&
      contract.id === "assign" &&
      activeAssignment !== null &&
      (activeAssignment.targetRef !== targetRef || activeAssignment.rationale !== requestedRationale),
    eventRevision = headRevision + (replacing ? 2 : 1),
    relationOpId =
      supersededDecisionId && replay === null
        ? derivedRelationOperationId(opId, "supersedes-relation", requestedRelationId)
        : opId,
    draft = replay
      ? null
      : contract.execution.compile?.({
          action: assignment && contract.id === "unassign" ? { ...action, relationId: requestedRelationId } : action,
          actor: binding.actor,
          source: binding.source,
          session: input.sessionIdentity(binding),
          opId: relationOpId,
          occurredAt,
          workspaceRevision: eventRevision,
          priorTargetVersion: current?.targetObservedVersion ?? null,
          currentTargetVersion: target?.currentVersion ?? null,
          ...(assignment
            ? {}
            : { relationDirections: relationDirectionRegistry(input.projection, input.repositoryId) }),
        }),
    compiled = replay ?? (draft?.kind === "relation" ? draft.event : null);
  if (!compiled || !isRelationEvent(compiled))
    reject("invalid_command", `${action.kind} did not compile a Relation event.`);
  const relationId = compiled.relationId;
  if (relationId !== requestedRelationId) reject("invalid_command", "Relation action identity changed during compile.");
  const dependenciesCaughtUp = lookupCut.status === "ready" && lookupCut.watermark === headRevision;
  if (!replay && !dependenciesCaughtUp) reject("content_not_ready", `Relation dependencies are pending${lookupNote}`);
  // A retired aggregate falls through to the revision fence below: relating the same endpoints at
  // its current revision reactivates it (F-007522DF), so an answered awaits can be asked again.
  const aggregateRevision = assignment
    ? Math.max(assignmentRevision, typeof source?.currentVersion === "number" ? source.currentVersion : 0)
    : (current?.workspaceRevision ?? 0);
  let sameActiveRelation = false;
  if (!replay && compiled.type === "relation_created" && current?.state === "active") {
    const candidate = compiled.payload.relation,
      same =
        current.sourceRef === candidate.source &&
        current.targetRef === candidate.target &&
        current.relationType === candidate.type &&
        current.direction === candidate.direction &&
        current.strength === relationStrengthForType(candidate.type) &&
        current.origin === candidate.origin &&
        current.rationale === candidate.rationale;
    if (!same && !(assignment && replacing))
      reject(
        "revision_conflict",
        `Relation ${relationId} is still active with different projected facets. ` +
          `To ask again, retire it first (ha relation unrelate ${relationId} --reason <text> ` +
          `--expected-version ${current.workspaceRevision}), then relate with --expected-version <its retired revision>.`,
      );
    sameActiveRelation = same;
    if (!assignment && !supersededDecisionId)
      return relationNoChanges({
        relationId,
        revision: current.workspaceRevision,
        headRevision,
        opId,
        authorizationDecision,
      });
  }
  if (!replay && Number(expectedVersion) !== aggregateRevision)
    reject(
      compiled.type === "relation_reconfirmed" ? "version_conflict" : "revision_conflict",
      compiled.type === "relation_created" && current?.state === "retired"
        ? `Relation ${relationId} was retired at revision ${aggregateRevision}; ` +
            `relate the same endpoints with --expected-version ${aggregateRevision} to ask again.`
        : `Relation ${relationId} expected revision ${String(expectedVersion)}, current revision is ${aggregateRevision}.`,
    );
  if (
    (compiled.type === "relation_retired" || compiled.type === "relation_reconfirmed") &&
    !replay &&
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
  if (compiled.type === "relation_created" && isAcyclicRelationType(compiled.payload.relation.type)) {
    const relation = compiled.payload.relation,
      cycle = readRelationCycleWitnessAtCut({
        projection: input.projection,
        headRevision,
        candidate: {
          relationId: compiled.relationId,
          sourceRef: relation.source,
          targetRef: relation.target,
          relationType: relation.type,
          direction: relation.direction,
          state: relation.state,
        },
      });
    if (cycle)
      reject(
        "relation_cycle",
        `The requested ${cycle.relationType} Relation would create a cycle ` +
          `(${cycle.nodeRefs.join(" -> ")}; relations: ${cycle.relationIds.join(", ")}).`,
      );
  }
  const relationWriteNeeded = replay === null && !sameActiveRelation,
    bundle = replay
      ? relationReplayBundle(input.store, compiled)
      : assignment
        ? { event: compiled, plan: relationEventWritePlan(compiled), blobs: [] }
        : compileRelationDocumentWrite(compiled, relationDocumentUpdates(input.projection, compiled, current)),
    plan = bundle.plan,
    published = bundle.event,
    replacement = replacing
      ? compileRelationRetirementForReplacement(input, activeAssignment!.relationId, headRevision + 1)
      : null,
    superseding = supersededDecisionId
      ? (input.compileSupersededDecision?.({
          decisionId: supersededDecisionId,
          opId,
          occurredAt,
          workspaceRevision: headRevision + (relationWriteNeeded ? 2 : 1),
          relationBundle: sameActiveRelation || replay !== null ? null : bundle,
        }) ?? null)
      : null;
  if (supersededDecisionId && !superseding)
    reject("invalid_command", "Decision supersession has no Decision lifecycle compiler.");
  let appended: ReturnType<CanonicalEventStore["append"]>;
  if (superseding) {
    appended = input.store.append({
      ...superseding,
      ...(relationWriteNeeded ? { preceding: [bundle] } : {}),
    });
    if (relationWriteNeeded) input.projection.apply(bundle.event, bundle.plan);
    input.projection.apply(superseding.event, superseding.plan);
  } else {
    appended = input.store.append({
      event: published,
      plan,
      blobs: bundle.blobs,
      ...(replacement === null ? {} : { preceding: [replacement] }),
    });
    if (replay === null) {
      if (replacement !== null) input.projection.apply(replacement.event, replacement.plan);
      input.projection.apply(published, plan);
    }
  }
  publicationKillpoints(input.killpoint);
  const projected = input.projection.readRelationEdge(relationId),
    visible =
      replay !== null ||
      (projected !== null &&
        projected.state === (compiled.type === "relation_retired" ? "retired" : "active") &&
        (compiled.type !== "relation_reconfirmed" || projected.freshness === "current"));
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
      executionId: null,
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

function relationTargetWitness(
  input: Parameters<typeof executeRelationAction>[0],
  targetRef: string,
): ReturnType<TaskProjection["readEntityVersionWitness"]> {
  const witness = input.projection.readEntityVersionWitness(targetRef),
    parsed = parseEntityRef(targetRef),
    userId = parsed?.kind === "person" ? input.binding.personIdentityWitnesses?.get(parsed.id) : undefined;
  if (witness.currentVersion !== null || userId === undefined || parsed?.kind !== "person") return witness;
  return {
    entityRef: targetRef,
    freshness: "current",
    currentVersion: `keycloak-user:${parsed.id}:${userId}`,
  };
}

export function relationDocumentUpdates(
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

/**
 * The Relation write boundary judges an endpoint's grammar before its existence. Both failures
 * collapse to `currentVersion: null` further down, and only one of them is the caller's typo:
 * `task:<id>` reads as an external harness alias, a bare id has no kind segment, and neither can
 * name a local entity no matter how current the projection is.
 */
function requireRelationEndpointRef(ref: string, endpoint: "source" | "target"): void {
  const flag = endpoint === "source" ? "--source-ref" : "--target-ref",
    parsed = parseEntityRef(ref);
  if (parsed !== null && !parsed.externalHarness) return;
  reject(
    "invalid_entity_ref",
    parsed?.externalHarness
      ? `Relation ${endpoint} ${ref} names harness ${String(parsed.harnessAlias)} and cannot be related in this ` +
          `repository. Use a local ref: ${flag} task/<task-id>.`
      : `Relation ${endpoint} "${ref}" is not an Entity ref. Write <kind>/<id>, e.g. ${flag} task/<task-id> ` +
          `(the id alone and "kind:id" are both unrecognized).`,
  );
}

function supersedesDecisionTargetId(action: RepoTaskAction): string | null {
  if (action.kind !== "relation-relate" || action.relationType !== "supersedes") return null;
  const source = parseEntityRef(typeof action.sourceRef === "string" ? action.sourceRef : ""),
    target = parseEntityRef(typeof action.targetRef === "string" ? action.targetRef : "");
  return source?.kind === "decision" && target?.kind === "decision" && source.id !== target.id ? target.id : null;
}

function derivedRelationOperationId(parentOpId: string, purpose: string, relationId: string): string {
  return `op_${createHash("sha256").update(`${parentOpId}:${purpose}:${relationId}`).digest("hex")}`;
}

function assignmentTargetRef(action: RepoTaskAction): string {
  if (typeof action.personId === "string" && action.personId.trim()) return `person/${action.personId}`;
  if (typeof action.nodeId === "string" && action.nodeId.trim()) return `node/${action.nodeId}`;
  if (typeof action.teamId === "string" && action.teamId.trim()) return `team/${action.teamId}`;
  reject("invalid_command", "Assignment requires one of personId, nodeId or teamId.");
}

function assignmentSourceRef(action: RepoTaskAction, kind: string): string {
  if (typeof action.entityRef === "string" && action.entityRef.trim()) return action.entityRef;
  const idField = `${kind.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())}Id`;
  const id = action[idField];
  if (typeof id === "string" && id.trim()) return `${kind}/${id}`;
  reject("invalid_command", "Assignment requires an entity reference.");
}

function compileRelationRetirementForReplacement(
  input: Parameters<typeof executeRelationAction>[0],
  relationId: string,
  workspaceRevision: number,
) {
  const event = compileRelationRetiredEvent({
    relationId,
    reason: "assignment replaced",
    actor: input.binding.actor,
    source: input.binding.source,
    opId: `${input.opId}-retire`,
    occurredAt: input.occurredAt,
    workspaceRevision,
  });
  return { event, plan: relationEventWritePlan(event), blobs: [] as const };
}

export function readRelationCycleWitnessAtCut(input: {
  readonly projection: Pick<TaskProjection, "readRelationQuery">;
  readonly headRevision: number;
  readonly candidate: RelationCycleEdge;
}): RelationCycleWitness | null {
  return (
    findRelationCycleWitnesses(
      {
        readOutgoing: (relationType, sourceRef) => {
          const rows: RelationCycleEdge[] = [];
          let cursor: string | undefined;
          const seenCursors = new Set<string>();
          do {
            const cut = input.projection.readRelationQuery({
              source: sourceRef,
              relationType,
              state: "active",
              direction: "directed",
              limit: 100,
              ...(cursor === undefined ? {} : { cursor }),
            });
            if (
              cut.status !== "ready" ||
              cut.watermark !== input.headRevision ||
              cut.sourceRevision !== input.headRevision
            )
              reject(
                "content_not_ready",
                `Relation cycle check requires the current canonical cut: status ${cut.status}, ` +
                  `watermark ${cut.watermark}, source revision ${cut.sourceRevision}, write head ${input.headRevision}.`,
              );
            if (!cut.page)
              reject("content_not_ready", "Relation cycle check requires pagination metadata for every source page.");
            rows.push(...cut.rows);
            cursor = cut.page.nextCursor ?? undefined;
            if (cursor !== undefined) {
              if (seenCursors.has(cursor))
                reject("content_not_ready", "Relation cycle check received a repeated source-page cursor.");
              seenCursors.add(cursor);
            }
          } while (cursor !== undefined);
          return rows;
        },
      },
      input.candidate,
    )[0] ?? null
  );
}

export function publicationKillpoints(killpoint: ((point: EventPublicationKillpoint) => void) | undefined): void {
  killpoint?.("after_store_commit");
  killpoint?.("before_response_write");
  killpoint?.("after_response_write");
}
