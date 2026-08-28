import { createHash } from "node:crypto";
import { makeDecisionService, makeFactService } from "../../application/src/index.ts";
import {
  compileDecisionWrite,
  compileFactWrite,
  decisionWritePlan,
  factWritePlan,
  getExecutableEntityAction,
  timestamp,
  type AuthorizationDecision,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type DecisionEventV1,
  type EntityActionContract,
  type EntityActionDraft,
  type EntityActionExecutionContract,
  type EventPublicationKillpoint,
  type FactConfidence,
  type FactEventV1,
  type FactMemoryClass,
  type FactSearchFilters,
  type SessionIdentity,
  type TaskProjection,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import { authorizeAction } from "./authorization.ts";
import { prepareDecisionAmend, validateDecisionPackages } from "./decision-surface-actions.ts";
import { unknownFieldViolation } from "./protocol/json-rpc-types.ts";
import { roleBindingAuthorizationContext } from "./repo-cell-role-bindings.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

type ExecutableAction = EntityActionContract & { readonly execution: EntityActionExecutionContract };
type FactBundle = ReturnType<typeof compileFactWrite>;
type DecisionBundle = ReturnType<typeof compileDecisionWrite>;
type CatalogBundle = FactBundle | DecisionBundle;

export function makeEntityActionCatalogExecutor(input: {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly sessionIdentity: (binding: RepoCellBinding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
}) {
  const decisions = makeDecisionService({ eventStore: input.store, projection: input.projection }),
    facts = makeFactService({ eventStore: input.store, projection: input.projection });

  const run = (action: RepoTaskAction, binding: RepoCellBinding, opId: string): WriteReceipt => {
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

  const repinAll = (action: RepoTaskAction, binding: RepoCellBinding, opId: string): WriteReceipt => {
    const ids = decisions.list({}).decisions.map(({ decisionId }) => decisionId),
      receipts = ids.map((decisionId) =>
        run(
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
      action =
        contract.id === "amend"
          ? prepareDecisionAmend(
              rawAction,
              decisions.show(requiredCommandText(rawAction.decisionId, "decisionId")).decision,
            )
          : rawAction,
      dryRun = action.dryRun === true,
      existing = dryRun ? null : input.store.readEvent(opId),
      requestedTime = typeof action.decidedAt === "string" ? action.decidedAt : undefined,
      occurredAt = existing?.occurredAt ?? requestedTime ?? input.now();
    if (contract.target.kind === "decision" && !timestamp(occurredAt))
      reject("invalid_command", "decidedAt must be an ISO-8601 UTC timestamp ending in Z.");
    const bundle =
      matchingReplayBundle(input.store, contract, existing) ??
      compileAction(contract, action, binding, opId, occurredAt);
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
    return compileDraft(input.projection, draft);
  };

  return Object.freeze({ run });
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

function compileDraft(projection: TaskProjection, draft: EntityActionDraft): CatalogBundle {
  if (draft.kind === "fact") {
    if (draft.event.taskId) {
      const task = projection.read(draft.event.taskId);
      if (task.watermark !== task.sourceRevision || !task.packagePath || !task.snapshot.task)
        reject("content_not_ready", `Task ${draft.event.taskId} is not ready for fact record.`);
    }
    const current = projection.searchFacts(draft.event.taskId ? { taskId: draft.event.taskId } : {});
    if (current.watermark !== current.sourceRevision) reject("content_not_ready", "Fact projection is pending.");
    return compileFactWrite({ event: draft.event });
  }
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
): AuthorizationDecision | null {
  const judgment =
    ["decision-accept", "decision-reject", "decision-defer"].includes(action.kind) ||
    (action.kind === "decision-transition" &&
      ["in_effect", "rejected", "deferred"].includes(String(action.targetState)));
  if (!judgment) return null;
  const decisionId = requiredCommandText(action.decisionId, "decisionId"),
    decision = authorizeAction("decision.accept", `decision/${decisionId}`, binding.actor, opId, {
      ...roleBindingAuthorizationContext(binding),
      target: { proposalActor: input.projection.readDecision(decisionId).decision?.proposer ?? null },
      evaluatedAtCut: `canonical:${input.store.readHead()?.revision ?? 0}`,
    });
  if (decision.outcome !== "denied") return decision;
  const proposalAgentFailed = decision.bindingsUsed.some(
      (candidate) => candidate.predicate === "isNotProposalAgent" && candidate.satisfied === false,
    ),
    reviewIndependenceFailed = decision.bindingsUsed.some(
      (candidate) => candidate.predicate === "reviewIndependence" && candidate.satisfied === false,
    );
  reject(
    "actor_unauthorized",
    proposalAgentFailed
      ? "An agent cannot judge its own Decision proposal; use an independent reviewer."
      : reviewIndependenceFailed
        ? "Decision outcome requires a reviewer independent from the proposal actor."
        : "Decision outcome requires an active arbiter RoleBinding.",
  );
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
  authorizationDecision: AuthorizationDecision | null,
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

function missingProposalFactEvidenceHint(event: DecisionEventV1): string | null {
  if (event.type !== "decision_proposed") return null;
  const claimRefs = new Set(event.payload.claims.map((claim) => `decision/${event.decisionId}/${claim.id}`)),
    hasFactEvidence = event.payload.relations.some(
      (relation) =>
        relation.type === "evidenced-by" &&
        claimRefs.has(relation.source) &&
        /^fact\/F-[A-Za-z0-9_-]+$/u.test(relation.target),
    );
  return hasFactEvidence
    ? null
    : "First run `ha fact record`, then `ha decision relate --type evidenced-by` " +
        "to attach a fact evidence edge to a claim before accepting this Decision.";
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
function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  reject("invalid_command", `${field} must be an object.`);
}
function reject(code: "actor_unauthorized" | "content_not_ready" | "invalid_command", message: string): never {
  throw Object.assign(new Error(message), { code });
}
function publicationKillpoints(killpoint: ((point: EventPublicationKillpoint) => void) | undefined): void {
  killpoint?.("after_sqlite_commit");
  killpoint?.("before_response_write");
  killpoint?.("after_response_write");
}
