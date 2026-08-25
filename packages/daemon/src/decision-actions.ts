import { createHash } from "node:crypto";
import { makeDecisionService, makeFactService } from "../../application/src/index.ts";
import {
  compileDecisionWrite,
  decisionWritePlan,
  deriveRelationId,
  sessionProvenance,
  type ActorIdentity,
  type AuthorizationDecision,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type DecisionAmendableSnapshot,
  type DecisionEventDraftV1,
  type DecisionEventV1,
  type EventPublicationKillpoint,
  type FactEventDraftV1,
  type SessionIdentity,
  type TaskProjection,
  type WriteReceipt,
  type WriteSource,
} from "../../kernel/src/index.ts";
import { authorizeAction } from "./authorization.ts";
import { prepareDecisionAmend, validateDecisionPackages } from "./decision-surface-actions.ts";
import {
  compileFact,
  factActionError,
  factReceipt,
  factStringList,
  readReceipt,
  requiredFactText,
} from "./fact-actions.ts";

interface Binding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
}
export function makeDecisionActions(input: {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly sessionIdentity: (binding: Binding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
}) {
  const service = makeDecisionService({ eventStore: input.store, projection: input.projection }),
    facts = makeFactService({ eventStore: input.store, projection: input.projection });
  const run = (
    action: Readonly<Record<string, unknown>> & { readonly kind: string },
    binding: Binding & { readonly roles?: readonly string[] },
    opId: string,
  ): WriteReceipt => {
    if (action.kind === "decision-list") {
      const read = service.list(decisionFilters(action));
      return readReceipt("decision-list", { ...read, decisions: read.decisions.map(decisionSummary) });
    }
    if (action.kind === "decision-show") {
      const read = service.show(requiredFactText(action.decisionId, "decisionId")),
        shown = {
          ...read,
          decision: { ...read.decision, body: action.includeBody === true ? read.decision.body : null },
        };
      return readReceipt("decision-show", shown);
    }
    if (action.kind === "decision-validate")
      return readReceipt("decision-validate", validateDecisionPackages(action, service, input.projection));
    if (action.kind === "decision-repin" && action.all === true) {
      const ids = service.list({}).decisions.map(({ decisionId }) => decisionId),
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
    }
    if (action.kind === "decision-reckon") {
      const id = requiredFactText(action.decisionId, "decisionId");
      service.show(id);
      const graph = service.graph(),
        rows = graph.coverageRows.filter((row) => row.decisionRef === `decision/${id}`),
        basisRevision = graph.watermark,
        occurredAt = input.now(),
        draft = reckonFact(
          action,
          binding,
          input.sessionIdentity(binding),
          opId,
          occurredAt,
          (input.store.readHead()?.revision ?? 0) + 1,
          rows,
          basisRevision,
        ),
        bundle = compileFact(input, draft),
        result = facts.record(bundle);
      return factReceipt(result, bundle.event);
    }
    const judgmentAction =
        ["decision-accept", "decision-reject", "decision-defer"].includes(action.kind) ||
        (action.kind === "decision-transition" &&
          ["in_effect", "rejected", "deferred"].includes(String(action.targetState))),
      authorizationDecision = judgmentAction
        ? authorizeAction(
            "decision.accept",
            `decision/${requiredFactText(action.decisionId, "decisionId")}`,
            binding.actor,
            opId,
            {
              commandClasses: binding.roles?.map((role) => role.replace(/^\$/u, "")) ?? [],
              target: {
                proposalActor:
                  input.projection.readDecision(requiredFactText(action.decisionId, "decisionId")).decision?.proposer ??
                  null,
              },
              evaluatedAtCut: `canonical:${input.store.readHead()?.revision ?? 0}`,
            },
          )
        : null;
    if (authorizationDecision?.outcome === "denied")
      throw factActionError(
        "actor_unauthorized",
        authorizationDecision.bindingsUsed.some(
          (binding) => binding.predicate === "reviewIndependence" && binding.satisfied === false,
        )
          ? "Decision outcome requires a reviewer independent from the proposal actor."
          : "Decision outcome requires a transport-bound $arbiter.",
      );
    const normalized =
        action.kind === "decision-amend"
          ? prepareDecisionAmend(action, service.show(requiredFactText(action.decisionId, "decisionId")).decision)
          : action,
      dryRun = normalized.dryRun === true,
      existing = dryRun ? null : input.store.readEvent(opId),
      requestedTime = typeof normalized.decidedAt === "string" ? normalized.decidedAt : undefined,
      occurredAt = existing?.occurredAt ?? requestedTime ?? input.now();
    if (!Number.isFinite(Date.parse(occurredAt)))
      throw factActionError("invalid_command", "decidedAt must be an ISO-8601 timestamp.");
    const bundle =
      existing?.schema === "decision-event/v1"
        ? replayDecisionBundle(input, existing)
        : compileDecision(
            input,
            decisionEvent(
              normalized,
              binding,
              input.sessionIdentity(binding),
              opId,
              occurredAt,
              (input.store.readHead()?.revision ?? 0) + 1,
            ),
          );
    if (dryRun)
      return {
        ...decisionPreview(bundle.event, input.store.readHead()?.revision ?? 0),
        authorizationDecision,
      };
    const result = service.record(bundle);
    input.killpoint?.("after_sqlite_commit");
    input.killpoint?.("before_response_write");
    input.killpoint?.("after_response_write");
    return decisionReceipt(result, bundle.event, authorizationDecision);
  };
  return Object.freeze({ run });
}
function decisionEvent(
  action: Readonly<Record<string, unknown>>,
  binding: Binding,
  identity: SessionIdentity,
  opId: string,
  occurredAt: string,
  workspaceRevision: number,
): DecisionEventDraftV1 {
  const decisionId =
      action.kind === "decision-propose"
        ? `dec_${createHash("sha256").update(opId).digest("hex").slice(0, 26).toUpperCase()}`
        : requiredFactText(action.decisionId, "decisionId"),
    base = {
      schema: "decision-event/v1" as const,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision,
      opId,
      decisionId,
      actor: binding.actor,
      source: binding.source,
      occurredAt,
    };
  if (action.kind === "decision-propose")
    return {
      ...base,
      type: "decision_proposed",
      payload: {
        title: requiredFactText(action.title, "title"),
        question: requiredFactText(action.question, "question"),
        riskTier: choice(action.riskTier, ["low", "medium", "high"], "riskTier"),
        urgency: choice(action.urgency, ["low", "medium", "high"], "urgency"),
        vertical: requiredFactText(action.vertical, "vertical"),
        preset: requiredFactText(action.preset, "preset"),
        appliesTo: object(action.appliesTo, "appliesTo") as never,
        decisionClass: choice(action.decisionClass, ["ordinary", "standing_policy"], "decisionClass"),
        chosen: requiredFactArray(action.chosen, "chosen") as never,
        rejected: requiredFactArray(action.rejected, "rejected") as never,
        body: typeof action.body === "string" ? action.body : `\n# ${requiredFactText(action.title, "title")}\n`,
        claims: items(action.claims, "claims") as never,
        fulfillments: items(action.fulfillments, "fulfillments") as never,
        relations: proposalRelations(action.relations, decisionId),
        provenance: [sessionProvenance(identity, occurredAt)],
      },
    };
  if (action.kind === "decision-transition") {
    const state = choice(
        action.targetState,
        ["in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
        "targetState",
      ),
      reason = `Transitioned to ${state} via the canonical Decision lifecycle command.`;
    if (state === "in_effect")
      return {
        ...base,
        type: "decision_accepted",
        payload: {
          rationale:
            typeof action.judgmentOnlyRationale === "string"
              ? short(action.judgmentOnlyRationale, "judgmentOnlyRationale")
              : reason,
          judgmentOnlyRationale:
            typeof action.judgmentOnlyRationale === "string"
              ? short(action.judgmentOnlyRationale, "judgmentOnlyRationale")
              : null,
          fulfillments: items(action.fulfillments, "fulfillments") as never,
          standingPolicy: action.standingPolicy === true,
        },
      };
    if (state === "rejected") return { ...base, type: "decision_rejected", payload: { reason } };
    if (state === "deferred") return { ...base, type: "decision_deferred", payload: { reason } };
    return state === "superseded"
      ? { ...base, type: "decision_superseded", payload: { reason } }
      : { ...base, type: "decision_retired", payload: { reason } };
  }
  if (action.kind === "decision-accept")
    return {
      ...base,
      type: "decision_accepted",
      payload: {
        rationale: short(action.rationale, "rationale"),
        judgmentOnlyRationale:
          typeof action.judgmentOnlyRationale === "string"
            ? short(action.judgmentOnlyRationale, "judgmentOnlyRationale")
            : null,
        fulfillments: [],
        standingPolicy: false,
      },
    };
  if (action.kind === "decision-reject")
    return { ...base, type: "decision_rejected", payload: { reason: short(action.reason, "reason") } };
  if (action.kind === "decision-defer")
    return { ...base, type: "decision_deferred", payload: { reason: short(action.reason, "reason") } };
  if (action.kind === "decision-supersede")
    return { ...base, type: "decision_superseded", payload: { reason: short(action.reason, "reason") } };
  if (action.kind === "decision-retire")
    return { ...base, type: "decision_retired", payload: { reason: short(action.reason, "reason") } };
  if (action.kind === "decision-amend")
    return {
      ...base,
      type: "decision_amended",
      payload: {
        next: object(action.next, "next") as unknown as DecisionAmendableSnapshot,
        fields: factStringList(action.fields),
        body: typeof action.body === "string" ? action.body : null,
      },
    };
  if (action.kind === "decision-repin")
    return {
      ...base,
      type: "decision_repinned",
      payload: { migrationEvidence: requiredFactText(action.migrationEvidence, "migrationEvidence") },
    };
  if (action.kind === "decision-claim-add")
    return {
      ...base,
      type: "decision_claim_declared",
      payload: {
        claimId: requiredFactText(action.claimId, "claimId"),
        text: requiredFactText(action.text, "text"),
        loadBearing: action.loadBearing !== false,
      },
    };
  if (action.kind === "decision-claim-fulfill")
    return {
      ...base,
      type: "decision_claim_fulfillment_declared",
      payload: {
        claimId: requiredFactText(action.claimId, "claimId"),
        mode: choice(action.mode, ["evidenced", "delivered", "standing_policy"], "mode"),
      },
    };
  if (action.kind === "decision-relate") {
    const source = `decision/${decisionId}/${requiredFactText(action.anchor, "anchor")}`,
      identity = {
        source,
        target: requiredFactText(action.target, "target"),
        type: requiredFactText(action.relationType, "relationType") as never,
        direction: "directed" as const,
      };
    return {
      ...base,
      type: "decision_related",
      payload: {
        relation: {
          relation_id: deriveRelationId(identity),
          ...identity,
          strength: "strong",
          origin: "declared",
          rationale: requiredFactText(action.rationale, "rationale"),
          state: "active",
        },
      },
    };
  }
  if (action.kind === "decision-relation-retire")
    return {
      ...base,
      type: "decision_relation_retired",
      payload: {
        relationId: requiredFactText(action.relationId, "relationId"),
        reason: requiredFactText(action.reason, "reason"),
      },
    };
  if (action.kind === "decision-relation-replace") {
    const source = `decision/${decisionId}/${requiredFactText(action.anchor, "anchor")}`,
      identity = {
        source,
        target: requiredFactText(action.target, "target"),
        type: requiredFactText(action.relationType, "relationType") as never,
        direction: "directed" as const,
      },
      replacement = {
        relation_id: deriveRelationId(identity),
        ...identity,
        strength: "strong" as const,
        origin: "declared" as const,
        rationale: short(action.rationale, "rationale"),
        state: "active" as const,
      };
    return {
      ...base,
      type: "decision_relation_replaced",
      payload: {
        relationId: requiredFactText(action.relationId, "relationId"),
        reason: `Replaced atomically by ${replacement.relation_id}.`,
        replacement,
        body: typeof action.body === "string" ? action.body : null,
      },
    };
  }
  throw factActionError("invalid_command", "Use a canonical Decision command.");
}
function reckonFact(
  action: Readonly<Record<string, unknown>>,
  binding: Binding,
  identity: SessionIdentity,
  opId: string,
  occurredAt: string,
  workspaceRevision: number,
  rows: readonly { readonly claimRef: string; readonly status: string; readonly basisRevision: number }[],
  basisRevision: number,
): FactEventDraftV1 {
  const decisionId = requiredFactText(action.decisionId, "decisionId"),
    taskId = requiredFactText(action.taskId, "taskId"),
    report = rows.map((row) => `${row.claimRef}=${row.status}`).join(", ") || "no load-bearing claims";
  return {
    schema: "fact-event/v1",
    eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
    workspaceRevision,
    opId,
    taskId,
    factId: `F-${createHash("sha256").update(opId).digest("hex").slice(0, 8).toUpperCase()}`,
    type: "fact_recorded",
    actor: binding.actor,
    source: binding.source,
    occurredAt,
    payload: {
      statement: `Decision ${decisionId} coverage at basisRevision ${basisRevision}: ${report}.`,
      evidenceSource: `decision/${decisionId}@${basisRevision}`,
      observedAt: occurredAt,
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: ["abstract_rule"],
      provenance: [sessionProvenance(identity, occurredAt)],
    },
  };
}
function proposalRelations(value: unknown, decisionId: string) {
  return items(value, "relations").map((entry) => {
    const input = object(entry, "relation"),
      identity = {
        source: `decision/${decisionId}/${requiredFactText(input.anchor, "anchor")}`,
        target: requiredFactText(input.target, "target"),
        type: requiredFactText(input.type, "type") as never,
        direction: "directed" as const,
      };
    return {
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong" as const,
      origin: "declared" as const,
      rationale: short(input.rationale, "rationale"),
      state: "active" as const,
    };
  });
}
function compileDecision(
  input: { readonly store: CanonicalEventStore; readonly projection: TaskProjection },
  draft: DecisionEventDraftV1,
) {
  const read = input.projection.readDecision(draft.decisionId);
  if (read.watermark !== read.sourceRevision)
    throw factActionError("content_not_ready", `Decision ${draft.decisionId} is pending.`);
  const current = read.decision,
    path = `decisions/decision-${draft.decisionId}/decision.md`,
    document = input.projection.readDocument(path);
  if (document.watermark !== document.sourceRevision)
    throw factActionError("content_not_ready", `Decision document ${path} is pending.`);
  const relations = input.projection
    .readDecisionGraph()
    .edges.filter((edge) => edge.ownerRef === `decision/${draft.decisionId}`)
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
    event: draft,
    currentDecision: current,
    currentRelations: relations,
    currentDocument: document.document,
  });
}
function replayDecisionBundle(input: { readonly store: CanonicalEventStore }, event: DecisionEventV1) {
  const claim = event.payload.decisionDocumentClaim,
    bytes = input.store.readContentBlob(claim.sha256);
  if (!bytes) throw factActionError("content_not_ready", `Decision content for ${event.decisionId} is unavailable.`);
  return {
    event,
    plan: decisionWritePlan(event),
    blobs: [
      {
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
        body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      },
    ],
  } as const;
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
): WriteReceipt & {
  readonly path: string;
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
  readonly documentSha256: string;
  readonly worktreeVisible: true;
  readonly consentId: string | null;
} {
  const consentId = "judgmentConsent" in event.payload ? event.payload.judgmentConsent.consentId : null,
    relationReplacement =
      event.type === "decision_relation_replaced"
        ? { retiredRelationId: event.payload.relationId, replacementRelationId: event.payload.replacement.relation_id }
        : null,
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
    ? { outcome: "applied", ...base }
    : {
        outcome: "pending",
        ...base,
        nextAction: `Query receipt ${event.opId}; its canonical publication cut is not exact.`,
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
    throw factActionError("invalid_command", "Decision list filters are invalid or unknown.");
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
function short(value: unknown, field: string): string {
  const text = requiredFactText(value, field);
  if ([...text].length <= 199) return text;
  throw factActionError("invalid_command", `${field} must contain at most 199 characters.`);
}
function requiredFactArray(value: unknown, field: string): readonly unknown[] {
  if (Array.isArray(value) && value.length) return value;
  throw factActionError("invalid_command", `${field} must be a non-empty array.`);
}
function items(value: unknown, field: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  throw factActionError("invalid_command", `${field} must be an array.`);
}
function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  throw factActionError("invalid_command", `${field} must be an object.`);
}
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value === "string" && choices.includes(value as T)) return value as T;
  throw factActionError("invalid_command", `${field} is invalid.`);
}
