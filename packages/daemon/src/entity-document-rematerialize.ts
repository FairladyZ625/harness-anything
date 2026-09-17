import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compileEntityDocumentRematerialization,
  DECISION_DOCUMENT_POLICY_ID,
  factLiveness,
  FACT_DOCUMENT_POLICY_ID,
  parseEntityRef,
  readAcceptedCommandOutcome,
  rematerializeTaskDocuments,
  renderDecisionDocument,
  renderFactsDocument,
  resolveHarnessLayout,
  sha256Text,
  type DecisionRelationLinkResolver,
  type EntityDocumentUpdate,
  type LifecycleDocumentState,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { reject } from "./entity-action-write-helpers.ts";
import { decisionRelationLinkResolver } from "./entity-document-links.ts";
import { publicationKillpoints } from "./entity-action-relation.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

type RematerializeEntityKind = "decision" | "fact" | "task";

/**
 * Explicitly re-renders the current managed documents of Decisions, Facts, and Tasks from the
 * canonical SQLite projection and appends every changed document in one entity-document/v1 event
 * through the central write queue. Historical events, blobs, prose, pins, and business state are
 * untouched; documents that already match the current render produce no writes at all. A path whose
 * authored file is dirty relative to the canonical document is excluded from the write set and
 * reported as a conflict instead of being clobbered by follower publication.
 */
export function runEntityDocumentRematerialize(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const entityKind = action.kind.split("-", 1)[0] as RematerializeEntityKind,
    idField = `${entityKind}Id` as const,
    all = action.all === true,
    entityId = typeof action[idField] === "string" ? action[idField] : null;
  if (all === (entityId !== null))
    throw cell.cellCodedError("invalid_field", `ha ${entityKind} rematerialize requires exactly one of --all or --id.`);
  const headRevision = cell.store.readHead()?.revision ?? 0,
    opId = cell.operationId(action, binding, cell.input.repoId, headRevision),
    pendingCut = cell.projection.readCut(),
    projectionCaughtUp = pendingCut.status === "ready" && pendingCut.watermark === headRevision;
  if (!projectionCaughtUp)
    throw cell.cellCodedError(
      "content_not_ready",
      `Entity document rematerialization requires a caught-up projection ` +
        `(watermark ${pendingCut.watermark}, write head ${headRevision}); ` +
        "run ha daemon projection rebuild, then retry.",
    );
  const authorizationDecision = binding.authorizationDecision,
    existingOutcome = readAcceptedCommandOutcome(cell.store, opId),
    evidenceBase = {
      schema: "entity-document-rematerialize/v1",
      entityKind,
      ...(all ? { all: true } : { entityId }),
    },
    base = {
      opId,
      revision: existingOutcome?.lastRevision ?? headRevision,
      evidence: JSON.stringify(evidenceBase),
      visibility: "center" as const,
      proof: {
        committedRevision: existingOutcome?.lastRevision ?? headRevision,
        appliedCut: pendingCut.watermark,
        durable: existingOutcome !== null,
        canonicalVisible: existingOutcome !== null && pendingCut.watermark >= existingOutcome.lastRevision,
        worktreeVisible: false,
      },
      ...(authorizationDecision ? { authorizationDecision } : {}),
    };
  if (existingOutcome !== null) return { outcome: "applied", ...base };
  const entityIds = resolveEntityIds(cell, entityKind, all, entityId),
    linkResolver = decisionRelationLinkResolver(cell.projection),
    targets = entityIds.map((id) => {
      const entityRef = `${entityKind}/${id}`,
        updates = currentEntityDocumentUpdates(cell.projection, entityKind, id, linkResolver),
        conflictPaths = worktreeConflictPaths(cell, updates),
        conflicts = new Set(conflictPaths),
        changed = updates.filter(
          (update) =>
            !conflicts.has(update.path) &&
            cell.projection.readDocument(update.path).document?.blobSha256 !== sha256Text(update.body),
        ),
        changedPaths = new Set(changed.map(({ path: target }) => target));
      return {
        entityRef,
        updates: changed,
        paths: updates.map(({ path: target }) => target),
        changedPaths: [...changedPaths],
        unchangedPaths: updates.flatMap(({ path: target }) =>
          changedPaths.has(target) || conflicts.has(target) ? [] : [target],
        ),
        conflictPaths,
      };
    }),
    updates = targets.flatMap((target) => target.updates),
    report = {
      ...evidenceBase,
      mode: action.dryRun === true ? "preview" : "apply",
      writeStatus: action.dryRun === true ? "not_requested" : updates.length === 0 ? "not_needed" : "accepted",
      targetCount: targets.length,
      pathCount: targets.reduce((count, target) => count + target.paths.length, 0),
      changedCount: updates.length,
      unchangedCount: targets.reduce((count, target) => count + target.unchangedPaths.length, 0),
      conflictCount: targets.reduce((count, target) => count + target.conflictPaths.length, 0),
      targets: targets.map(({ updates: _updates, ...target }) => target),
    };
  if (updates.length === 0)
    return {
      outcome: report.conflictCount === 0 ? "no_changes" : "pending",
      ...base,
      opId: `noop:${opId}`,
      evidence: JSON.stringify(report),
      proof: {
        committedRevision: headRevision,
        appliedCut: pendingCut.watermark,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: report.conflictCount === 0,
      },
    };
  if (action.dryRun === true)
    return {
      outcome: "pending",
      ...base,
      opId: `preview:${opId}`,
      evidence: JSON.stringify(report),
    };
  const bundle = compileEntityDocumentRematerialization({
    opId,
    entityRefs: targets.flatMap(({ entityRef, updates: changed }) => (changed.length === 0 ? [] : [entityRef])),
    updates,
    rationale: "rematerialize current entity documents from the canonical projection",
    actor: binding.actor,
    source: binding.source,
    occurredAt: cell.now(),
    workspaceRevision: headRevision + 1,
  });
  cell.store.append(bundle);
  cell.projection.apply(bundle.event, bundle.plan);
  publicationKillpoints(cell.input.killpoint);
  const outcome = readAcceptedCommandOutcome(cell.store, opId),
    revision = outcome?.lastRevision ?? bundle.event.workspaceRevision,
    appliedCut = cell.projection.readCut().watermark,
    canonicalVisible = appliedCut >= revision;
  return {
    // Skipped dirty paths still await a rerun, so a partial batch never reports itself applied.
    outcome: canonicalVisible && report.conflictCount === 0 ? "applied" : "pending",
    ...base,
    revision,
    evidence: JSON.stringify({
      ...report,
      changedPaths: bundle.event.payload.documentClaims.map((claim) => claim.path),
    }),
    proof: {
      committedRevision: revision,
      appliedCut,
      durable: outcome !== null,
      canonicalVisible,
      worktreeVisible: false,
    },
  };
}

function worktreeConflictPaths(
  cell: RepoCellOperationalContext,
  updates: readonly EntityDocumentUpdate[],
): readonly string[] {
  const authoredRoot = resolveHarnessLayout(cell.rootDir).authoredRoot;
  return updates.flatMap((update) => {
    const current = cell.projection.readDocument(update.path).document,
      absolute = path.join(authoredRoot, ...update.path.split("/"));
    if (!current || !existsSync(absolute)) return [];
    return readFileSync(absolute, "utf8") === current.body ? [] : [update.path];
  });
}

function resolveEntityIds(
  cell: RepoCellOperationalContext,
  entityKind: RematerializeEntityKind,
  all: boolean,
  entityId: string | null,
): string[] {
  if (!all) {
    const id = entityId!;
    if (entityKind === "decision" && cell.projection.readDecision(id).decision === null)
      throw cell.cellCodedError("entity_not_found", `Decision ${id} does not exist.`);
    if (entityKind === "fact" && cell.projection.readFact(id).fact === null)
      throw cell.cellCodedError("entity_not_found", `Fact ${id} does not exist.`);
    if (entityKind === "task") {
      const read = cell.projection.read(id);
      if (read.snapshot.task === null || read.packagePath === null)
        throw cell.cellCodedError("entity_not_found", `Task ${id} has no published package.`);
    }
    return [id];
  }
  if (entityKind === "decision")
    return cell.projection
      .listDecisions({})
      .decisions.map(({ decisionId }) => decisionId)
      .sort();
  if (entityKind === "fact")
    return cell.projection
      .searchFacts({})
      .facts.map(({ factId }) => factId)
      .sort();
  return cell.projection
    .list({})
    .rows.filter(({ packagePath }) => packagePath !== null)
    .map(({ taskId }) => taskId)
    .sort();
}

/** The current managed documents of one entity, re-rendered at this projection cut. */
function currentEntityDocumentUpdates(
  projection: TaskProjection,
  entityKind: RematerializeEntityKind,
  entityId: string,
  resolveLink: DecisionRelationLinkResolver,
): readonly EntityDocumentUpdate[] {
  if (entityKind === "decision") return decisionDocumentUpdates(projection, entityId, resolveLink);
  if (entityKind === "fact") return factDocumentUpdates(projection, entityId);
  return taskDocumentUpdates(projection, entityId);
}

function decisionDocumentUpdates(
  projection: TaskProjection,
  decisionId: string,
  resolveLink: DecisionRelationLinkResolver,
): readonly EntityDocumentUpdate[] {
  const path = `decisions/decision-${decisionId}/decision.md`,
    state = projection.readDecisionDocumentState?.(decisionId),
    document = projection.readDocument(path).document;
  if (!state || !document) reject("content_not_ready", `Decision document ${path} is unavailable.`);
  const outgoing = relationRecords(projection.readRelationQuery({ ownerRef: `decision/${decisionId}` }).rows).filter(
      ({ source }) => {
        const owner = parseEntityRef(source);
        return owner?.kind === "decision" && owner.id === decisionId;
      },
    ),
    incoming = relationRecords(projection.readDecisionIncomingRelations(decisionId)).filter(({ target }) => {
      const owner = parseEntityRef(target);
      return owner?.kind === "decision" && owner.id === decisionId;
    });
  return [
    {
      path,
      policyId: DECISION_DOCUMENT_POLICY_ID,
      mediaType: "text/markdown",
      body: renderDecisionDocument(
        { ...state, relations: outgoing },
        document.body,
        undefined,
        null,
        incoming,
        resolveLink,
      ),
    },
  ];
}

function factDocumentUpdates(projection: TaskProjection, factId: string): readonly EntityDocumentUpdate[] {
  const fact = projection.readFact(factId).fact,
    path = `facts/${factId}.md`;
  if (!fact || !projection.readDocument(path).document)
    reject("content_not_ready", `Fact document ${path} is unavailable.`);
  const incoming = relationRecords(
      projection.readRelationQuery({ target: `fact/${factId}`, relationType: "supersedes-fact" }).rows,
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
  return [
    {
      path,
      policyId: FACT_DOCUMENT_POLICY_ID,
      mediaType: "text/markdown",
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
          workspaceRevision: fact.workspaceRevision,
        },
      ]),
    },
  ];
}

function taskDocumentUpdates(projection: TaskProjection, taskId: string): readonly EntityDocumentUpdate[] {
  const read = projection.read(taskId),
    packagePath = read.packagePath;
  const taskReadable = read.status === "ready" && read.snapshot.task !== null && packagePath !== null;
  if (!taskReadable) reject("content_not_ready", `Task ${taskId} package is unavailable.`);
  const prefix = `${packagePath}/`,
    candidates = [
      `${prefix}INDEX.md`,
      `${prefix}task-contract.json`,
      `${prefix}module.md`,
      ...read.snapshot.executions.map(({ executionId }) => `${prefix}executions/${executionId}.md`),
      ...read.snapshot.reviews.map(({ reviewId }) => `${prefix}reviews/${reviewId}.md`),
    ],
    currentDocuments: LifecycleDocumentState[] = candidates.flatMap((path) => {
      const document = projection.readDocument(path).document;
      return document === null ? [] : [document];
    }),
    paths = currentDocuments.map(({ path }) => path);
  return rematerializeTaskDocuments({
    snapshot: read.snapshot,
    packagePath,
    paths,
    currentDocuments,
  }).map(({ path, body }) => ({
    path,
    policyId: "typed-machine-writer/v1",
    mediaType: path.endsWith(".json") ? ("application/json" as const) : ("text/markdown" as const),
    body,
  }));
}

function relationRecords(
  rows: readonly Pick<
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
  >[],
) {
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
