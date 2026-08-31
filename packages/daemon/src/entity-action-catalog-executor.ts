import { createHash } from "node:crypto";
import { makeDecisionService, makeFactService } from "../../application/src/index.ts";
import {
  compileEntityUpsert,
  compileDecisionWrite,
  compileFactWrite,
  decisionWritePlan,
  entityUpsertWritePlan,
  factWritePlan,
  getExecutableEntityAction,
  isRelationEvent,
  isSameExecution,
  relationEventWritePlan,
  requireEntityStoreKindContract,
  timestamp,
  type AuthorizationDecision,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type DecisionEventV1,
  type EntityActionContract,
  type EntityActionDraft,
  type EntityActionExecutionContract,
  type EntityEventV1,
  type EntityUpsertBundle,
  type EventPublicationKillpoint,
  type FactConfidence,
  type FactEventV1,
  type FactMemoryClass,
  type FactSearchFilters,
  type SessionIdentity,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import { prepareDecisionAmend, validateDecisionPackages } from "./decision-surface-actions.ts";
import { unknownFieldViolation } from "./protocol/json-rpc-types.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

type ExecutableAction = EntityActionContract & { readonly execution: EntityActionExecutionContract };
type FactBundle = ReturnType<typeof compileFactWrite>;
type DecisionBundle = ReturnType<typeof compileDecisionWrite>;
type CatalogBundle = FactBundle | DecisionBundle | EntityUpsertBundle;
export type EntityActionCatalogRunner = (
  contract: ExecutableAction,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) => Promise<WriteReceipt>;
export type EntityActionCatalogPreparer = (
  contract: ExecutableAction,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
) => RepoTaskAction;
export interface EntityActionCatalogRuntimes {
  readonly schedule?: EntityActionCatalogRunner;
  readonly task?: EntityActionCatalogRunner;
  readonly prepare?: Readonly<Record<string, EntityActionCatalogPreparer>>;
}

export function makeEntityActionCatalogExecutor(input: {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly sessionIdentity: (binding: RepoCellBinding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
}) {
  const decisions = makeDecisionService({ eventStore: input.store, projection: input.projection }),
    facts = makeFactService({ eventStore: input.store, projection: input.projection });

  const runCompiled = (action: RepoTaskAction, binding: RepoCellBinding, opId: string): WriteReceipt => {
    const contract = executableAction(action.kind);
    if (contract.execution.read) {
      if (action.kind === "fact-search") return readReceipt("fact-search", facts.search(factFilters(action)));
      if (action.kind === "fact-show")
        return readReceipt("fact-show", facts.show(requiredCommandText(action.factId, "factId")));
      if (action.kind === "decision-list") {
        const read = decisions.list(decisionFilters(action));
        return readReceipt("decision-list", { ...read, decisions: read.decisions.map(decisionSummary) });
      }
      if (action.kind === "decision-show") {
        const read = decisions.show(requiredCommandText(action.decisionId, "decisionId"));
        return readReceipt("decision-show", {
          ...read,
          decision: { ...read.decision, body: action.includeBody === true ? read.decision.body : null },
        });
      }
      if (action.kind === "decision-validate")
        return readReceipt("decision-validate", validateDecisionPackages(action, decisions, input.projection));
      throw Object.assign(new Error(`Action ${action.kind} is declared as a read without a reader.`), {
        code: "invalid_store",
      });
    }
    if (action.kind === "decision-repin" && action.all === true) return repinAll(action, binding, opId);
    return runWrite(contract, action, binding, opId);
  };

  const run = (
    action: RepoTaskAction,
    binding: RepoCellBinding,
    opId: string,
    runtimes: EntityActionCatalogRuntimes = {},
  ): WriteReceipt | Promise<WriteReceipt> => {
    const contract = executableAction(action.kind),
      prepare = runtimes.prepare?.[contract.target.kind],
      preparedAction = prepare?.(contract, action, binding, opId) ?? action;
    if (contract.execution.implementation === "schedule-event") {
      if (!runtimes.schedule)
        throw Object.assign(new Error(`Action ${action.kind} requires the Schedule Action runtime.`), {
          code: "unsupported_command",
        });
      return runtimes
        .schedule(contract, action, binding)
        .then((receipt) => deriveActionResult(contract, action, receipt));
    }
    if (
      contract.execution.implementation !== "task-lifecycle" &&
      contract.execution.implementation !== "task-completion"
    )
      return runCompiled(preparedAction, binding, opId);
    if (!runtimes.task)
      throw Object.assign(new Error(`Action ${action.kind} requires the Task Action runtime.`), {
        code: "unsupported_command",
      });
    return runtimes.task(contract, action, binding).then((receipt) => deriveActionResult(contract, action, receipt));
  };

  const repinAll = (action: RepoTaskAction, binding: RepoCellBinding, opId: string): WriteReceipt => {
    const ids = decisions.list({}).decisions.map(({ decisionId }) => decisionId),
      receipts = ids.map((decisionId) =>
        runCompiled(
          { ...action, all: false, decisionId },
          binding,
          `${opId}-${createHash("sha256").update(decisionId).digest("hex").slice(0, 12)}`,
        ),
      ),
      revision = receipts.at(-1)?.revision ?? input.store.readHead()?.revision ?? 0,
      canonicalVisible =
        receipts.length > 0 &&
        receipts.every((receipt) => receipt.outcome === "applied" && receipt.proof?.canonicalVisible === true),
      base = {
        opId,
        revision,
        evidence: JSON.stringify({
          schema: "decision-repin-batch-report/v1",
          decisionIds: ids,
          migrationEvidence: action.migrationEvidence,
        }),
        visibility: "center" as const,
        proof: {
          committedRevision: revision,
          appliedCut: revision,
          durable: canonicalVisible,
          canonicalVisible,
          worktreeVisible: canonicalVisible,
        },
      };
    return canonicalVisible
      ? { outcome: "applied", ...base }
      : {
          outcome: "pending",
          ...base,
          nextAction:
            receipts.length === 0
              ? "No Decisions were available to repin; retry after a Decision is published."
              : "Query the child Decision receipts and retry after every repin is canonical.",
        };
  };

  const runWrite = (
    contract: ExecutableAction,
    rawAction: RepoTaskAction,
    binding: RepoCellBinding,
    opId: string,
  ): WriteReceipt => {
    const authorizationDecision = decisionAuthorization(rawAction, binding, opId, input),
      action = (
        contract.id === "amend"
          ? prepareDecisionAmend(
              rawAction,
              decisions.show(requiredCommandText(rawAction.decisionId, "decisionId")).decision,
            )
          : rawAction
      ) as RepoTaskAction,
      dryRun = action.dryRun === true,
      existing = dryRun ? null : input.store.readEvent(opId),
      requestedTime = typeof action.decidedAt === "string" ? action.decidedAt : undefined,
      occurredAt = existing?.occurredAt ?? requestedTime ?? input.now();
    if (contract.target.kind === "relation" && dryRun)
      reject("invalid_command", `${contract.execution.ingress} does not support --dry-run.`);
    if (contract.target.kind === "relation")
      return deriveActionResult(
        contract,
        rawAction,
        runRelationWrite(contract, rawAction, binding, opId, occurredAt, authorizationDecision),
      );
    if (contract.target.kind === "decision" && !timestamp(occurredAt))
      reject("invalid_command", "decidedAt must be an ISO-8601 UTC timestamp ending in Z.");
    const bundle =
      matchingReplayBundle(input.store, contract, existing) ??
      compileAction(contract, action, binding, opId, occurredAt);
    if (isEntityBundle(bundle)) {
      if (dryRun)
        return entityPreview(contract, action, bundle, input.store.readHead()?.revision ?? 0, authorizationDecision);
      return deriveActionResult(
        contract,
        action,
        runEntityWrite(bundle, action, existing !== null, authorizationDecision),
      );
    }
    if (dryRun) {
      if (bundle.event.schema !== "decision-event/v1")
        reject("invalid_command", `${contract.execution.ingress} does not support --dry-run.`);
      return { ...decisionPreview(bundle.event, input.store.readHead()?.revision ?? 0), authorizationDecision };
    }
    if (isFactBundle(bundle)) {
      const result = facts.record(bundle);
      publicationKillpoints(input.killpoint);
      return factReceipt(result, bundle.event);
    }
    const result = decisions.record(bundle);
    publicationKillpoints(input.killpoint);
    return decisionReceipt(result, bundle.event, authorizationDecision);
  };

  const runEntityWrite = (
    bundle: EntityUpsertBundle,
    action: RepoTaskAction,
    replay: boolean,
    authorizationDecision: AuthorizationDecision,
  ): WriteReceipt => {
    const appended = input.store.append(bundle);
    if (!replay) input.projection.apply(bundle.event, bundle.plan);
    publicationKillpoints(input.killpoint);
    const applied = input.projection.readOperation(bundle.event.opId),
      visible = !!applied && applied.watermark >= bundle.event.workspaceRevision,
      claim = bundle.event.payload.declarationDocumentClaim,
      receipt = {
        opId: bundle.event.opId,
        revision: appended.revision,
        evidence: JSON.stringify({
          report: preparedEntityReport(action),
          event: {
            schema: bundle.event.schema,
            eventId: bundle.event.eventId,
            opId: bundle.event.opId,
            path: claim.path,
          },
          commitSha: appended.commitSha?.sha ?? null,
          cut: appended.cut,
        }),
        visibility: "center" as const,
        proof: {
          committedRevision: appended.revision,
          appliedCut: applied?.watermark ?? 0,
          durable: true,
          canonicalVisible: visible,
          worktreeVisible: true,
        },
        detail: {
          kind: "entity_upsert" as const,
          entityKind: bundle.event.payload.entityKind,
          entityId: bundle.event.payload.entityId,
          schemaId: requireEntityStoreKindContract(bundle.event.payload.entityKind).schema.$id,
          path: claim.path,
        },
        commitSha: appended.commitSha?.sha ?? null,
        cut: appended.cut,
        authorizationDecision,
      };
    return visible
      ? { outcome: "applied", ...receipt }
      : {
          outcome: "pending",
          ...receipt,
          nextAction: `Retry after the projection records declaration event ${bundle.event.opId}.`,
        };
  };

  const runRelationWrite = (
    contract: ExecutableAction,
    action: RepoTaskAction,
    binding: RepoCellBinding,
    opId: string,
    occurredAt: string,
    authorizationDecision: AuthorizationDecision,
  ): WriteReceipt => {
    const expectedVersion = action.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0)
      reject("invalid_command", "Relation actions require a non-negative integer expectedVersion.");
    const replay = input.store.readEvent(opId),
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
          }),
      compiled = replay ?? (draft?.kind === "relation" ? draft.event : null);
    if (!compiled || !isRelationEvent(compiled))
      reject("invalid_command", `${action.kind} did not compile a Relation event.`);
    const relationId = compiled.relationId,
      current = input.projection.readRelationTruth().edges.find((edge) => edge.relationId === relationId) as
        | (ReturnType<TaskProjection["readRelationTruth"]>["edges"][number] & { readonly workspaceRevision?: number })
        | undefined;
    if (compiled.type === "relation_created" && current) {
      const candidate = compiled.payload.relation,
        same =
          current.sourceRef === candidate.source &&
          current.targetRef === candidate.target &&
          current.relationType === candidate.type &&
          current.direction === candidate.direction &&
          current.strength === candidate.strength &&
          current.origin === candidate.origin &&
          current.rationale === candidate.rationale &&
          current.state === "active";
      if (!same) reject("revision_conflict", `Relation ${relationId} already exists with different projected facets.`);
      const revision = current.workspaceRevision ?? headRevision;
      return {
        outcome: "no_changes",
        opId: `noop:${opId}`,
        revision,
        evidence: JSON.stringify({ relationId, idempotent: true, aggregateRevision: revision }),
        visibility: "center",
        proof: {
          committedRevision: revision,
          appliedCut: headRevision,
          durable: true,
          canonicalVisible: true,
          worktreeVisible: null,
        },
        authorizationDecision,
        relationId,
      } as WriteReceipt;
    }
    const aggregateRevision = current?.workspaceRevision ?? 0;
    if (Number(expectedVersion) !== aggregateRevision)
      reject(
        "revision_conflict",
        `Relation ${relationId} expected revision ${String(expectedVersion)}, ` +
          `current revision is ${aggregateRevision}.`,
      );
    if (compiled.type === "relation_retired" && (!current || current.state !== "active"))
      reject("entity_not_found", `Relation ${relationId} is not an active aggregate.`);
    if (
      compiled.type === "relation_created" &&
      compiled.payload.relation.type === "depends-on" &&
      relationPath(
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
        projected.state === (compiled.type === "relation_retired" ? "edge_retired" : "active");
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
  };

  const compileAction = (
    contract: ExecutableAction,
    action: Readonly<Record<string, unknown>>,
    binding: RepoCellBinding,
    opId: string,
    occurredAt: string,
  ): CatalogBundle => {
    const compile = contract.execution.compile;
    if (!compile) reject("invalid_command", `${contract.execution.ingress} has no write compiler.`);
    const headRevision = input.store.readHead()?.revision ?? 0,
      coverage = contract.id === "reckon" ? decisionCoverage(action, decisions) : undefined,
      draft = compile({
        action,
        actor: binding.actor,
        source: binding.source,
        session: input.sessionIdentity(binding),
        opId,
        occurredAt,
        workspaceRevision: headRevision + 1,
        ...(coverage ? { coverage } : {}),
      });
    return compileDraft(input.projection, draft, {
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      opId,
      workspaceRevision: headRevision + 1,
      actor: binding.actor,
      source: binding.source,
      occurredAt,
    });
  };

  return Object.freeze({ run });
}

export function deriveActionResult(
  contract: EntityActionContract,
  action: RepoTaskAction,
  receipt: WriteReceipt,
): WriteReceipt {
  const rejected = receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate",
    targetIdField = contract.execution?.targetIdField ?? contract.execution?.lifecycle?.targetIdField ?? null,
    receiptFields = receipt as WriteReceipt & Readonly<Record<string, unknown>>,
    targetId =
      targetIdField && typeof action[targetIdField] === "string"
        ? action[targetIdField]
        : targetIdField && typeof receiptFields[targetIdField] === "string"
          ? receiptFields[targetIdField]
          : null,
    unmetCriteria = rejected
      ? contract.criteria
          .filter((criterion) => criterion.failureCode === receipt.code)
          .map((criterion) => criterion.ref)
      : [],
    explanation = rejected
      ? (contract.criteria.find((criterion) => criterion.failureCode === receipt.code)?.explain ??
        receipt.nextAction ??
        `Action ${contract.target.kind}.${contract.id} was rejected.`)
      : null;
  return {
    ...receipt,
    unmetCriteria,
    effects: rejected ? [] : contract.effects.map(({ ref }) => ref),
    updatedProjection:
      rejected || !targetId
        ? null
        : {
            kind: contract.target.kind,
            ref: contract.target.refTemplate.replace("{id}", targetId),
            revision: receipt.revision ?? null,
          },
    rejectionExplanation: explanation,
    nextActions: receipt.nextAction ? [receipt.nextAction] : [],
  };
}

function executableAction(ingress: string): ExecutableAction {
  const action = getExecutableEntityAction(ingress);
  if (!action?.execution)
    throw Object.assign(new Error(`Action ${ingress} is not declared in the entity action catalog.`), {
      code: "unsupported_command",
    });
  return action as ExecutableAction;
}

function isFactBundle(bundle: CatalogBundle): bundle is FactBundle {
  return bundle.event.schema === "fact-event/v1";
}

function isEntityBundle(bundle: CatalogBundle): bundle is EntityUpsertBundle {
  return bundle.event.schema === "entity-event/v1";
}

function compileDraft(
  projection: TaskProjection,
  draft: EntityActionDraft,
  event: Omit<Parameters<typeof compileEntityUpsert>[0], "entityKind" | "entity">,
): CatalogBundle {
  if (draft.kind === "fact") return compileFactWrite({ event: draft.event });
  if (draft.kind === "entity")
    return compileEntityUpsert({ ...event, entityKind: draft.entityKind, entity: draft.entity });
  if (draft.kind === "schedule") reject("invalid_command", "Schedule drafts require the Schedule Action runtime.");
  if (draft.kind === "relation")
    reject("invalid_command", "Relation drafts are committed directly through the Relation aggregate executor.");
  const read = projection.readDecision(draft.event.decisionId);
  if (read.watermark !== read.sourceRevision)
    reject("content_not_ready", `Decision ${draft.event.decisionId} is pending.`);
  const path = `decisions/decision-${draft.event.decisionId}/decision.md`,
    document = projection.readDocument(path);
  if (document.watermark !== document.sourceRevision)
    reject("content_not_ready", `Decision document ${path} is pending.`);
  const relations = projection
    .readDecisionGraph()
    .edges.filter((edge) => edge.ownerRef === `decision/${draft.event.decisionId}`)
    .map((edge) => ({
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
  return compileDecisionWrite({
    event: draft.event,
    currentDecision: read.decision,
    currentRelations: relations,
    currentDocument: document.document,
  });
}

function matchingReplayBundle(
  store: CanonicalEventStore,
  contract: ExecutableAction,
  existing: ReturnType<CanonicalEventStore["readEvent"]>,
): CatalogBundle | null {
  const writesFact = contract.target.kind === "fact" || contract.id === "reckon";
  if (existing?.schema === "entity-event/v1" && existing.payload.entityKind === contract.target.kind) {
    const claim = existing.payload.declarationDocumentClaim,
      bytes = store.readContentBlob(claim.sha256);
    if (!bytes) reject("content_not_ready", `Entity content for ${claim.path} is unavailable.`);
    return {
      event: existing,
      plan: entityUpsertWritePlan(existing as EntityEventV1),
      blobs: [
        {
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
          body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        },
      ],
    };
  }
  if (existing?.schema === "fact-event/v1" && writesFact) {
    const claim = existing.payload.factsDocumentClaim,
      bytes = store.readContentBlob(claim.sha256);
    if (!bytes) reject("content_not_ready", `Facts content for ${existing.taskId} is unavailable.`);
    return {
      event: existing,
      plan: factWritePlan(existing),
      blobs: [
        {
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
          body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        },
      ],
      path: claim.path,
      body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  }
  if (existing?.schema === "decision-event/v1" && !writesFact) {
    const claim = existing.payload.decisionDocumentClaim,
      bytes = store.readContentBlob(claim.sha256);
    if (!bytes) reject("content_not_ready", `Decision content for ${existing.decisionId} is unavailable.`);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      event: existing,
      plan: decisionWritePlan(existing),
      blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
      path: claim.path,
      body,
    };
  }
  return null;
}

function decisionCoverage(action: Readonly<Record<string, unknown>>, service: ReturnType<typeof makeDecisionService>) {
  const decisionId = requiredCommandText(action.decisionId, "decisionId"),
    taskId = requiredCommandText(action.taskId, "taskId");
  service.show(decisionId);
  const graph = service.graph();
  return {
    decisionId,
    taskId,
    basisRevision: graph.watermark,
    rows: graph.coverageRows.filter((row) => row.decisionRef === `decision/${decisionId}`),
  };
}

function decisionAuthorization(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
  input: { readonly store: CanonicalEventStore; readonly projection: TaskProjection },
): AuthorizationDecision {
  const authorizationDecision = binding.authorizationDecision;
  if (!authorizationDecision || authorizationDecision.outcome !== "allowed")
    reject("actor_unauthorized", "Catalog execution requires the center AuthorizationPort decision.");
  const judgment =
    ["decision-accept", "decision-reject", "decision-defer"].includes(action.kind) ||
    (action.kind === "decision-transition" &&
      ["in_effect", "rejected", "deferred"].includes(String(action.targetState)));
  if (!judgment) return authorizationDecision;
  const decisionId = requiredCommandText(action.decisionId, "decisionId"),
    proposalActor = input.projection.readDecision(decisionId).decision?.proposer ?? null;
  if (proposalActor !== null && proposalActor.executor !== null && isSameExecution(proposalActor, binding.actor))
    reject("actor_unauthorized", "An agent cannot judge its own Decision proposal; use an independent reviewer.");
  return authorizationDecision;
}

function factReceipt(
  result: {
    readonly revision: number;
    readonly watermark: number;
    readonly commitSha: string | null;
    readonly cut: CanonicalEventCut;
    readonly path: string;
    readonly fact: { readonly factId: string; readonly evidenceSource: string };
  },
  event: FactEventV1,
): WriteReceipt & {
  readonly path: string;
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
  readonly worktreeVisible: true;
  readonly factId: string;
} {
  const canonicalVisible =
      result.cut.opId === event.opId &&
      result.cut.revision === result.revision &&
      result.revision === event.workspaceRevision,
    base = {
      opId: event.opId,
      revision: result.revision,
      evidence: JSON.stringify({
        ...result.fact,
        path: result.path,
        eventId: event.eventId,
        commitSha: result.commitSha,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: result.revision,
        appliedCut: result.watermark,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: true as const,
      },
      path: result.path,
      commitSha: result.commitSha,
      cut: result.cut,
      worktreeVisible: true as const,
      factId: result.fact.factId,
    };
  return canonicalVisible
    ? { outcome: "applied", ...base }
    : {
        outcome: "pending",
        ...base,
        nextAction: `Query receipt ${event.opId}; its canonical publication cut is not exact.`,
      };
}

function decisionReceipt(
  result: {
    readonly revision: number;
    readonly watermark: number;
    readonly commitSha: string | null;
    readonly cut: CanonicalEventCut;
    readonly path: string;
    readonly documentSha256: string;
    readonly decision: unknown;
  },
  event: DecisionEventV1,
  authorizationDecision: AuthorizationDecision,
): WriteReceipt {
  const consentId = "judgmentConsent" in event.payload ? event.payload.judgmentConsent.consentId : null,
    relationReplacement =
      event.type === "decision_relation_replaced"
        ? { retiredRelationId: event.payload.relationId, replacementRelationId: event.payload.replacement.relation_id }
        : null,
    proposalFactHint = missingProposalFactEvidenceHint(event),
    canonicalVisible =
      result.cut.opId === event.opId &&
      result.cut.revision === result.revision &&
      result.revision === event.workspaceRevision,
    base = {
      opId: event.opId,
      revision: result.revision,
      evidence: JSON.stringify({
        ...(result.decision as object),
        path: result.path,
        eventId: event.eventId,
        commitSha: result.commitSha,
        cut: result.cut,
        documentSha256: result.documentSha256,
        consentId,
        ...(relationReplacement ? { relationReplacement } : {}),
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: result.revision,
        appliedCut: result.watermark,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: true as const,
      },
      path: result.path,
      commitSha: result.commitSha,
      cut: result.cut,
      documentSha256: result.documentSha256,
      worktreeVisible: true as const,
      consentId,
      authorizationDecision,
    };
  return canonicalVisible
    ? { outcome: "applied", ...base, ...(proposalFactHint ? { nextAction: proposalFactHint } : {}) }
    : {
        outcome: "pending",
        ...base,
        nextAction: [`Query receipt ${event.opId}; its canonical publication cut is not exact.`, proposalFactHint]
          .filter((value): value is string => value !== null)
          .join(" "),
      };
}

function decisionPreview(event: DecisionEventV1, revision: number): WriteReceipt {
  return {
    outcome: "pending",
    opId: "preview:" + createHash("sha256").update(event.opId).digest("hex"),
    revision,
    evidence: JSON.stringify({
      schema: "decision-write-preview/v1",
      decisionId: event.decisionId,
      eventType: event.type,
      targetRevision: event.workspaceRevision,
      document: event.payload.decisionDocumentClaim,
      writePlan: decisionWritePlan(event),
      dryRun: true,
    }),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    nextAction: "Remove --dry-run to publish this validated Decision write plan.",
  };
}

function entityPreview(
  contract: ExecutableAction,
  action: RepoTaskAction,
  bundle: EntityUpsertBundle,
  revision: number,
  authorizationDecision: AuthorizationDecision,
): WriteReceipt {
  const claim = bundle.event.payload.declarationDocumentClaim;
  return {
    outcome: "pending",
    opId: `preview:${createHash("sha256").update(bundle.event.opId).digest("hex")}`,
    revision,
    evidence: JSON.stringify({
      report: preparedEntityReport(action),
      eventType: bundle.event.type,
      targetRevision: bundle.event.workspaceRevision,
      declaration: claim,
      writePlan: bundle.plan,
      dryRun: true,
    }),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    authorizationDecision,
    unmetCriteria: [],
    effects: [],
    updatedProjection: null,
    rejectionExplanation: null,
    nextActions: ["Remove --dry-run to publish this Agent declaration through the canonical event stream."],
    nextAction: `Remove --dry-run to run ${contract.execution.ingress}.`,
  };
}

function preparedEntityReport(action: RepoTaskAction): Readonly<Record<string, unknown>> {
  const prepared = action.preparedEntityAction;
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return {};
  const report = (prepared as Readonly<Record<string, unknown>>).report;
  return report && typeof report === "object" && !Array.isArray(report)
    ? (report as Readonly<Record<string, unknown>>)
    : {};
}

function missingProposalFactEvidenceHint(event: DecisionEventV1): string | null {
  if (event.type !== "decision_proposed") return null;
  return (
    "First run `ha fact record`, then `ha relation relate --source-ref decision/<id>/<claim> " +
    "--target-ref fact/<id> --type evidenced-by --expected-version 0` before accepting this Decision."
  );
}

function readReceipt<
  T extends { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
>(command: string, read: T): WriteReceipt {
  const base = {
    opId: `read:${command}`,
    revision: read.sourceRevision,
    evidence: JSON.stringify(read),
    visibility: "center" as const,
    proof: {
      committedRevision: read.sourceRevision,
      appliedCut: read.watermark,
      durable: true,
      canonicalVisible: read.status === "ready",
      worktreeVisible: null,
    },
  };
  return read.status === "ready"
    ? { outcome: "applied", ...base }
    : { outcome: "pending", ...base, nextAction: `Retry ${command} after projection catch-up.` };
}

function factFilters(action: Readonly<Record<string, unknown>>): FactSearchFilters {
  const allowed = [
      "kind",
      "query",
      "taskId",
      "confidence",
      "memoryClass",
      "observedAfter",
      "observedBefore",
      "limit",
      "cursor",
    ],
    unknownField = unknownFieldViolation(action, allowed);
  if (unknownField) reject("invalid_command", `Fact search filters contain an ${unknownField}`);
  const { query, taskId, confidence, memoryClass, observedAfter, observedBefore, limit, cursor } = action;
  if (query !== undefined && (typeof query !== "string" || !query.trim()))
    reject("invalid_command", "Fact search query must be a non-empty string.");
  if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim()))
    reject("invalid_command", "Fact search taskId must be a non-empty string.");
  if (
    confidence !== undefined &&
    (typeof confidence !== "string" || !(["low", "medium", "high"] as const).includes(confidence as FactConfidence))
  )
    reject("invalid_command", "Fact search confidence is invalid.");
  if (
    memoryClass !== undefined &&
    (typeof memoryClass !== "string" ||
      !(["semantic", "episodic", "procedural"] as const).includes(memoryClass as FactMemoryClass))
  )
    reject("invalid_command", "Fact search memory class is invalid.");
  if (observedAfter !== undefined && !timestamp(observedAfter))
    reject("invalid_command", "observedAfter must be an ISO-8601 UTC timestamp.");
  if (observedBefore !== undefined && !timestamp(observedBefore))
    reject("invalid_command", "observedBefore must be an ISO-8601 UTC timestamp.");
  if (
    typeof observedAfter === "string" &&
    typeof observedBefore === "string" &&
    Date.parse(observedAfter) > Date.parse(observedBefore)
  )
    reject("invalid_command", "observedAfter must not be later than observedBefore.");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500))
    reject("invalid_command", "Fact search limit must be an integer between 1 and 500.");
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.trim()))
    reject("invalid_command", "Fact search cursor is invalid.");
  return {
    ...(typeof query === "string" ? { query } : {}),
    ...(typeof taskId === "string" ? { taskId } : {}),
    ...(typeof confidence === "string" ? { confidence: confidence as FactConfidence } : {}),
    ...(typeof memoryClass === "string" ? { memoryClass: memoryClass as FactMemoryClass } : {}),
    ...(typeof observedAfter === "string" ? { observedAfter } : {}),
    ...(typeof observedBefore === "string" ? { observedBefore } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(typeof cursor === "string" ? { cursor } : {}),
  };
}

function decisionFilters(action: Readonly<Record<string, unknown>>) {
  const allowed = ["kind", "search", "legacyId", "legacyRange", "state", "module", "productLine"],
    range = action.legacyRange === undefined ? null : object(action.legacyRange, "legacyRange");
  if (
    Object.keys(action).some((field) => !allowed.includes(field)) ||
    ["search", "module", "productLine"].some(
      (field) => action[field] !== undefined && (typeof action[field] !== "string" || !String(action[field]).trim()),
    ) ||
    (action.legacyId !== undefined &&
      (typeof action.legacyId !== "string" || !/^E[1-9][0-9]*$/u.test(action.legacyId))) ||
    (action.state !== undefined &&
      !["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"].includes(
        String(action.state),
      )) ||
    (range &&
      (Object.keys(range).length !== 2 ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        Number(range.start) < 1 ||
        Number(range.end) < Number(range.start)))
  )
    reject("invalid_command", "Decision list filters are invalid or unknown.");
  return {
    ...(typeof action.search === "string" ? { search: action.search } : {}),
    ...(typeof action.legacyId === "string" ? { legacyId: action.legacyId } : {}),
    ...(range ? { legacyRange: range as { readonly start: number; readonly end: number } } : {}),
    ...(typeof action.state === "string" ? { state: action.state as never } : {}),
    ...(typeof action.module === "string" ? { module: action.module } : {}),
    ...(typeof action.productLine === "string" ? { productLine: action.productLine } : {}),
  };
}

function decisionSummary(row: {
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: readonly unknown[];
  readonly rejected: readonly unknown[];
  readonly path: string;
  readonly workspaceRevision: number;
}) {
  return {
    decisionId: row.decisionId,
    ...(row.legacyId ? { legacyId: row.legacyId } : {}),
    state: row.state,
    title: row.title,
    question: row.question,
    chosen: row.chosen,
    rejected: row.rejected,
    path: row.path,
    workspaceRevision: row.workspaceRevision,
  };
}

function requiredCommandText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  reject("invalid_command", `${field} is required.`);
}
function relationPath(
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
function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  reject("invalid_command", `${field} must be an object.`);
}
function reject(
  code:
    | "actor_unauthorized"
    | "content_not_ready"
    | "entity_not_found"
    | "invalid_command"
    | "relation_cycle"
    | "revision_conflict",
  message: string,
): never {
  throw Object.assign(new Error(message), { code });
}
function publicationKillpoints(killpoint: ((point: EventPublicationKillpoint) => void) | undefined): void {
  killpoint?.("after_sqlite_commit");
  killpoint?.("before_response_write");
  killpoint?.("after_response_write");
}
