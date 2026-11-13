import type { DecisionDocumentState } from "./decision-event-types.ts";
import {
  assertDecisionContentPin,
  assertDecisionJudgmentConsent,
  decisionTransitionDefinitions,
  type DecisionEventV1,
} from "./decision-event.ts";
import { decisionClaimsOpen } from "./decision-board-projection.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { FactProjectionError } from "./fact-admission.ts";
import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

export interface DecisionAdmissionState {
  readonly document: DecisionDocumentState | null;
  readonly hasSupersedes: boolean;
  readonly relations: readonly {
    readonly relation_id: string;
    readonly source_ref: string;
    readonly target_ref: string;
  }[];
}

export function assertDecisionAdmissionAtCut(state: DecisionAdmissionState, event: DecisionEventV1): void {
  const row = state.document;
  if (event.type === "decision_proposed") {
    if (row) fail("invalid_transition", `Decision ${event.decisionId} already exists.`);
    return;
  }
  if (!row) fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
  const transition = decisionTransitionDefinitions.find(({ eventType }) => eventType === event.type);
  const supersedingProposedDecision = event.type === "decision_superseded" && row.state === "proposed";
  if (transition && row.state !== transition.sourceState && !supersedingProposedDecision)
    fail("invalid_transition", `${event.type} requires ${transition.sourceState} state.`);
  if (supersedingProposedDecision && !state.hasSupersedes)
    fail(
      "invalid_transition",
      `Decision ${event.decisionId} can leave proposed for superseded only with an active supersedes Relation from another Decision.`,
    );
  if (["decision_accepted", "decision_rejected", "decision_deferred"].includes(event.type)) {
    const current = row;
    try {
      assertDecisionJudgmentConsent(
        current,
        event as Extract<
          DecisionEventV1,
          {
            readonly type: "decision_accepted" | "decision_rejected" | "decision_deferred";
          }
        >,
      );
      assertDecisionContentPin(current, event);
    } catch (error) {
      throw new FactProjectionError("invalid_transition", error instanceof Error ? error.message : String(error));
    }
    if (event.type === "decision_accepted") {
      for (const fulfillment of event.payload.fulfillments ?? []) {
        const claim = current.claims.find((entry) => entry.id === fulfillment.claimId);
        if (!claim) fail("anchor_not_found", `Claim ${fulfillment.claimId} does not exist.`);
        if (claim.fulfillment && claim.fulfillment !== fulfillment.mode)
          fail(
            "invalid_transition",
            `Claim ${fulfillment.claimId} already has fulfillment ${claim.fulfillment}; ` +
              `cannot change it to ${fulfillment.mode}.`,
          );
      }
      if (
        event.payload.standingPolicy &&
        current.appliesTo.modules.length + current.appliesTo.productLines.length === 0
      )
        fail("invalid_transition", "Standing policy acceptance requires a non-empty applies_to scope.");
    }
    return;
  }
  if (
    event.type === "decision_superseded" ||
    event.type === "decision_retired" ||
    event.type === "decision_amended" ||
    event.type === "decision_repinned"
  ) {
    if (event.type === "decision_amended") assertAmendment(state, event);
    try {
      assertDecisionContentPin(row, event);
    } catch (error) {
      throw new FactProjectionError("invalid_transition", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (event.type === "decision_claim_declared") {
    if (!decisionClaimsOpen(row.state)) fail("invalid_transition", "Claims require proposed or in_effect state.");
    if (row.claims.some(({ id }) => id === event.payload.claimId))
      fail("invalid_transition", `Claim ${event.payload.claimId} already exists.`);
    return;
  }
  if (event.type === "decision_claim_fulfillment_declared") {
    const claim = row.claims.find(({ id }) => id === event.payload.claimId);
    if (!claim) fail("anchor_not_found", `Claim ${event.payload.claimId} does not exist.`);
    if (claim.fulfillment) fail("invalid_transition", `Claim ${event.payload.claimId} already has a fulfillment.`);
    return;
  }
  if (
    event.type === "decision_related" ||
    event.type === "decision_relation_retired" ||
    event.type === "decision_relation_replaced"
  ) {
    return;
  }
  if (event.type === "decision_review_recorded") return;
  if (event.type === "decision_review_responded" || event.type === "decision_review_overridden") {
    if (row.state !== "proposed") fail("invalid_transition", `${event.type} requires proposed state.`);
    return;
  }
  fail("invalid_transition", "Unsupported Decision event.");
}

function assertAmendment(
  state: DecisionAdmissionState,
  event: Extract<DecisionEventV1, { readonly type: "decision_amended" }>,
): void {
  const current = state.document;
  if (!current) fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
  const next = event.payload.next,
    fields = new Set(event.payload.fields),
    changed = new Set<string>(),
    auditedAmendment = event.payload.reason !== undefined,
    beforeAnchors = [...current.chosen, ...current.rejected, ...current.claims].map(({ id }) => id),
    afterAnchors = new Set([...next.chosen, ...next.rejected, ...next.claims].map(({ id }) => id));
  if (next.title !== current.title) changed.add("title");
  if (next.decisionClass !== current.decisionClass) changed.add("decisionClass");
  if (stableStringify(next.chosen) !== stableStringify(current.chosen)) changed.add("chosen");
  if (stableStringify(next.rejected) !== stableStringify(current.rejected)) changed.add("rejected");
  for (const claim of next.claims) {
    const previous = current.claims.find(({ id }) => id === claim.id);
    if (auditedAmendment && previous && previous.text === claim.text && previous.fulfillment !== claim.fulfillment)
      fail("invalid_transition", `Amendment cannot change fulfillment for unchanged claim ${claim.id}.`);
    if (auditedAmendment && previous && previous.text !== claim.text && claim.fulfillment !== null)
      fail("invalid_transition", `Amendment must clear fulfillment when rewriting claim ${claim.id}.`);
    if (auditedAmendment && !previous && claim.fulfillment !== null)
      fail("invalid_transition", `New claim ${claim.id} cannot carry a fulfillment.`);
  }
  if (stableStringify(next.claims) !== stableStringify(current.claims)) changed.add("claims");
  if (event.payload.body !== null) changed.add("body");
  // `reason` was added with audited replacement. Historical amendments predate the
  // replacement contract and were admitted under append-only rules, so replay must
  // preserve that envelope's original admission semantics.
  if (auditedAmendment) assertNoRemovedActiveRelationAnchors(state, event.decisionId, beforeAnchors, afterAnchors);
  if (
    [...fields].some((field) => !["title", "decisionClass", "chosen", "rejected", "claims", "body"].includes(field)) ||
    [...fields].sort().join("\0") !== [...changed].sort().join("\0")
  )
    fail(
      "invalid_transition",
      "Amendment fields must exactly name the changed machine and prose channels " +
        `(declared: ${[...fields].join(",")}; changed: ${[...changed].join(",")}).`,
    );
  if (JSON.stringify(event.payload.amendment.fields) !== JSON.stringify(event.payload.fields))
    fail("invalid_transition", "Amendment history does not match the declared field set.");
  if (event.payload.reason !== undefined) {
    const prior = event.payload.previous,
      expectedPrevious = {
        title: current.title,
        decisionClass: current.decisionClass,
        chosen: current.chosen,
        rejected: current.rejected,
        claims: current.claims,
      },
      before = current as unknown as Readonly<Record<string, unknown>>,
      after = next as unknown as Readonly<Record<string, unknown>>,
      changes = event.payload.amendment.changes;
    if (!prior || stableStringify(prior) !== stableStringify(expectedPrevious))
      fail("invalid_transition", "Amendment previous snapshot does not match the current Decision.");
    if (!changes || changes.length !== event.payload.fields.length)
      fail("invalid_transition", "Amendment history must summarize every changed field.");
    for (const change of changes) {
      const afterValue = change.field === "body" ? event.payload.body : after[change.field],
        beforeValue = before[change.field];
      if (`sha256:${sha256Text(stableStringify(afterValue))}` !== change.afterDigest)
        fail("invalid_transition", `Amendment after digest does not match the ${change.field} value.`);
      if (change.field !== "body" && `sha256:${sha256Text(stableStringify(beforeValue))}` !== change.beforeDigest)
        fail("invalid_transition", `Amendment before digest does not match the prior ${change.field} value.`);
    }
  }
  if (event.payload.reason !== undefined && event.payload.amendment.reason !== event.payload.reason)
    fail("invalid_transition", "Amendment history reason does not match the event reason.");
  if (current.state === "in_effect" && event.payload.reason !== undefined) {
    const consent = event.payload.amendment.ownerConsent;
    if (!consent) fail("invalid_transition", "Amending an in_effect Decision requires recorded owner consent.");
    if (
      consent.consentBy !== current.proposer.principal.personId ||
      consent.consentBy !== event.actor.principal.personId
    )
      fail(
        "invalid_transition",
        "Amending an in_effect Decision requires consent from its authenticated proposal owner.",
      );
  }
  if (
    event.payload.ownerConsent &&
    stableStringify(event.payload.ownerConsent) !== stableStringify(event.payload.amendment.ownerConsent)
  )
    fail("invalid_transition", "Amendment event and history owner consent do not match.");
}

function assertNoRemovedActiveRelationAnchors(
  state: DecisionAdmissionState,
  decisionId: string,
  before: readonly string[],
  after: ReadonlySet<string>,
): void {
  const removed = new Set(before.filter((id) => !after.has(id)));
  if (!removed.size) return;
  const references = state.relations,
    prefix = `decision/${decisionId}/`,
    blocking = references.filter(({ source_ref, target_ref }) =>
      [source_ref, target_ref].some((ref) => removed.has(ref.slice(prefix.length)) && ref.startsWith(prefix)),
    );
  if (blocking.length)
    fail(
      "invalid_transition",
      `Cannot remove Decision anchors referenced by active Relations: ${blocking.map(({ relation_id }) => relation_id).join(", ")}. Retire or replace those Relations first.`,
    );
}

function fail(code: FactProjectionError["code"], message: string): never {
  throw new FactProjectionError(code, message);
}

export const decisionAdmissionPolicy = {
  id: "decision-admission",
  ownerRef: "decision",
  unit: "Decision acceptance scope",
  bounds: "Standing policy acceptance requires a non-empty applies_to scope.",
  defaultValue: null,
  version: 1,
  scope: "Decision acceptance at the current canonical cut",
  reason: "Preserve standing-policy scope admission together with its canonical Decision judgment.",
  fixtures: ["packages/storage/test/postgres/pg-decision-management.integration.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/decision-admission.ts#assertDecisionAdmissionAtCut:8e977063238352e3d2ae4431900f862c",
  ].map((candidateId) => ({ candidateId, route: "decisionAdmissionPolicy" })),
} as const satisfies OntologyPolicyDeclaration;
// dec_7E44897ECDCAEF2B92EC66A260/CH1: standing-policy classification read by projections and coverage.
export const decisionStandingClassPolicy = {
  id: "decision-standing-class",
  ownerRef: "decision",
  unit: "decision class / claim fulfillment",
  bounds:
    "Only a decision_accepted event whose payload sets standingPolicy reclassifies the Decision as standing_policy; coverage reports a standing_policy claim fulfillment as standing-policy.",
  defaultValue: "standing_policy",
  version: 1,
  scope: "Decision document projection and claim coverage",
  reason: "The class literal has one producer and one coverage spelling; both stay unchanged.",
  fixtures: ["packages/kernel/test/domain/decision-review.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/decision-coverage.ts#coverageOf.fulfillment:65e5110f9bd7afa53cf70009d35c0122",
    "policy:packages/kernel:packages/kernel/src/domain/decision-event-document.ts#reduceDecisionDocument.decisionClass:5050d0d349d3d3b63ca9a4bdb497fddf",
  ].map((candidateId) => ({ candidateId, route: "reduceDecisionDocument" })),
} as const satisfies OntologyPolicyDeclaration;
export const decisionAdmissionJudgments = [
  {
    id: "assertDecisionAdmissionAtCut",
    symbol: "packages/kernel/src/domain/decision-admission.ts#assertDecisionAdmissionAtCut",
    inputs: ["DecisionAdmissionState", "DecisionEventV1"],
    output: "void or FactProjectionError",
    failureCodes: ["invalid_transition", "entity_not_found", "anchor_not_found"],
    explain: "Preserve Decision admission, amendment and active-relation-anchor constraints at one cut.",
    consumers: [
      "packages/storage/src/projection/decision-projection-admission.ts",
      "packages/storage/src/pg/pg-task-projection.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/decision-admission.ts#assertDecisionAdmissionAtCut:1bcb04ec58f7775b7d31e4f1abad54b0",
        route: "Decision admission",
      },
    ],
  },
  {
    id: "assertAmendment",
    symbol: "packages/kernel/src/domain/decision-admission.ts#assertAmendment",
    inputs: ["DecisionAdmissionState", "DecisionAmendedEvent"],
    output: "void or FactProjectionError",
    failureCodes: ["invalid_transition", "entity_not_found"],
    explain: "Preserve Decision admission, amendment and active-relation-anchor constraints at one cut.",
    consumers: ["packages/kernel/src/domain/decision-admission.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/decision-admission.ts#assertAmendment:ff2ea21702d746ef4197bebec0686377",
        route: "Decision admission",
      },
    ],
  },
  {
    id: "assertNoRemovedActiveRelationAnchors",
    symbol: "packages/kernel/src/domain/decision-admission.ts#assertNoRemovedActiveRelationAnchors",
    inputs: ["DecisionAdmissionState", "decisionId", "before anchors", "after anchors"],
    output: "void or FactProjectionError",
    failureCodes: ["invalid_transition"],
    explain: "Preserve Decision admission, amendment and active-relation-anchor constraints at one cut.",
    consumers: ["packages/kernel/src/domain/decision-admission.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/decision-admission.ts#assertNoRemovedActiveRelationAnchors:76d70b4050e8a33e156180194ec3d0e7",
        route: "Decision admission",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
// Source identities and values for daemon policy declarations registered by EntityKindContract.
export const daemonDecisionPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/decision-annotations.ts#decisionAnnotationRetention:fc63aaac2b0ab1e270e0db91b8080d8a",
    "packages/daemon/src/decision-annotations.ts#decisionAnnotationRetention",
    "export const decisionAnnotationRetention = 1_000;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-incident-action.ts#incidentContinuationBudget:d91f0cd851ece75c3b3a94f13c010d47",
    "packages/daemon/src/decision-incident-action.ts#incidentContinuationBudget",
    "export const incidentContinuationBudget = 3;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-incident-action.ts#incidentDecisionFields.continuationBudget:3b882d7120449a613e93685f2bc962e2",
    "packages/daemon/src/decision-incident-action.ts#incidentDecisionFields.continuationBudget",
    "continuationBudget: {",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-incident-receipt.ts#incidentContinuationUsed:1d6d403b35476b012a350ce0e8fa4b5d",
    "packages/daemon/src/decision-incident-receipt.ts#incidentContinuationUsed",
    'if (action?.status !== "applied" || action.budget === null) continue;',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-point-executor.ts#openDecisionPointExecutor.settle:b5196a9ee61052d30bb020764a496e15",
    "packages/daemon/src/decision-point-executor.ts#openDecisionPointExecutor.settle",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-point-executor.ts#openDecisionPointExecutor.settle.evidence.budget.limit:1a5ccdf3ce7f4804b072dbfe52eb5893",
    "packages/daemon/src/decision-point-executor.ts#openDecisionPointExecutor.settle.evidence.budget.limit",
    "budget: incident?.fields?.continuationBudget ?? { used: 0, limit: 0 },",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-point-settings-read.ts#readDecisionPointSettings.projected.event.payload.attempt:83f5f87ceea4347798158daedb9cfe74",
    "packages/daemon/src/decision-point-settings-read.ts#readDecisionPointSettings.projected.event.payload.attempt",
    'attempt: { reason: "Stopped after the environment rejected access", classification: "worker_stop" },',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#requestTimeoutMs:00e6a022524341218524d075cf39d3e8",
    "packages/daemon/src/decision-provider.ts#requestTimeoutMs",
    "const requestTimeoutMs = 30_000;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#decisionRetryMaxRetries:c9d26f9fda7dbdba2863e86b973b5fa6",
    "packages/daemon/src/decision-provider.ts#decisionRetryMaxRetries",
    "const decisionRetryMaxRetries = 3;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#decisionRetryBaseDelayMs:eb34f8c731de24524b05aee0c6b076c9",
    "packages/daemon/src/decision-provider.ts#decisionRetryBaseDelayMs",
    "const decisionRetryBaseDelayMs = 250;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#decisionRetryMaxDelayMs:4673561631fd8291f27f96ccec09b635",
    "packages/daemon/src/decision-provider.ts#decisionRetryMaxDelayMs",
    "const decisionRetryMaxDelayMs = 4_000;",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#invokeDecisionWithRetry:15b494ae6a0035b6d92d23efc09eb103",
    "packages/daemon/src/decision-provider.ts#invokeDecisionWithRetry",
    "if (retryable && retries > 0)",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#openRouterDecision.retries.strategy:2315e6fc43651a7c8ade74b00b45e2ae",
    "packages/daemon/src/decision-provider.ts#openRouterDecision.retries.strategy",
    'retries: { strategy: "none" },',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#openRouterClient.retryConfig.strategy:2315e6fc43651a7c8ade74b00b45e2ae",
    "packages/daemon/src/decision-provider.ts#openRouterClient.retryConfig.strategy",
    'return new OpenRouter({ apiKey, retryConfig: { strategy: "none" }, timeoutMs: requestTimeoutMs });',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-provider.ts#openRouterClient.retryConfig:4395eb8e944d6edf1beaf9808469e49e",
    "packages/daemon/src/decision-provider.ts#openRouterClient.retryConfig",
    'return new OpenRouter({ apiKey, retryConfig: { strategy: "none" }, timeoutMs: requestTimeoutMs });',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/decision-surface-actions.ts#prepareDecisionAmend:6dc792252bdb1c9f7bc757b66d2c747e",
    "packages/daemon/src/decision-surface-actions.ts#prepareDecisionAmend",
    'if (action.standingPolicy === true) decisionClass = "standing_policy";',
  ],
  [
    "policy:packages/daemon:packages/daemon/src/entity-action-catalog-receipts.ts#decisionFilters:99ea0340819d1cd08f6d45c54776a94e",
    "packages/daemon/src/entity-action-catalog-receipts.ts#decisionFilters",
    "if (",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/entity-action-catalog-receipts.ts#decisionFilters:78f06c4227ba785282a4e80f837cbc12",
    "packages/daemon/src/entity-action-catalog-receipts.ts#decisionFilters",
    '...(typeof action.limit === "number" ? { limit: action.limit } : {}),',
  ],
] as const;
