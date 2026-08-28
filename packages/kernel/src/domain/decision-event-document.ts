import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import {
  DECISION_DOCUMENT_POLICY_ID,
  type CompiledDecisionWrite,
  type DecisionAmendmentV1,
  type DecisionContentPinV1,
  type DecisionDocumentClaim,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
  type DecisionEventV1,
  type DecisionJudgmentAction,
  type DecisionJudgmentConsentV1,
  type DecisionOutcomeType,
  type DecisionTransitionType,
} from "./decision-event-types.ts";
import { type EntityRelationRecord } from "./entity-relation.ts";
import { assertTransitionDocumentReady, requireTransitionDocumentKind } from "./transition-document-readiness.ts";
import {
  freezeDeclaredWritePlan,
  isFrozenWritePlan,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";

export function compileDecisionWrite(input: {
  readonly event: DecisionEventDraftV1;
  readonly currentDecision: Omit<DecisionDocumentState, "relations"> | null;
  readonly currentRelations: readonly EntityRelationRecord[];
  readonly currentDocument: {
    readonly blobSha256: string;
    readonly body: string;
  } | null;
}): CompiledDecisionWrite {
  const proposal = input.event.type === "decision_proposed";
  if (
    proposal
      ? input.currentDecision !== null || input.currentDocument !== null
      : input.currentDecision === null || input.currentDocument === null
  )
    throw new Error("decision projection and authored document base must agree");
  if (input.event.type === "decision_accepted")
    assertTransitionDocumentReady(requireTransitionDocumentKind("decision.accept"), input.currentDocument!.body);
  const base = input.currentDecision === null ? null : { ...input.currentDecision, relations: input.currentRelations };
  assertDecisionEvidenceFloor(base, input.event);
  const reduced = reduceDecisionDocument(base, input.event),
    consent = base && decisionOutcome(input.event) ? decisionConsent(base, input.event) : null,
    amendment = base && input.event.type === "decision_amended" ? decisionAmendment(input.event) : null,
    pin =
      base &&
      (decisionTransition(input.event) ||
        input.event.type === "decision_amended" ||
        input.event.type === "decision_repinned")
        ? decisionContentPin(reduced, input.event)
        : null,
    next = {
      ...reduced,
      judgmentConsents: consent ? [...reduced.judgmentConsents, consent] : reduced.judgmentConsents,
      amendments: amendment ? [...(reduced.amendments ?? []), amendment] : reduced.amendments,
      contentPins: pin ? [...(reduced.contentPins ?? []), pin] : reduced.contentPins,
    },
    path = `decisions/decision-${input.event.decisionId}/decision.md`;
  try {
    if (normalizeRelativeDocumentPath(path) !== path) throw new Error();
  } catch {
    throw new Error("decision package path is invalid");
  }
  const replacementBody = proposal
      ? input.event.payload.body
      : input.event.type === "decision_amended" || input.event.type === "decision_relation_replaced"
        ? (input.event.payload.body ?? undefined)
        : undefined,
    judgment = input.event.type === "decision_accepted" ? input.event.payload.judgmentOnlyRationale : null,
    body = renderDecisionDocument(next, input.currentDocument?.body ?? null, replacementBody, judgment),
    claim: DecisionDocumentClaim = {
      path,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: "text/markdown",
      policyId: DECISION_DOCUMENT_POLICY_ID,
    },
    event = {
      ...input.event,
      payload: {
        ...input.event.payload,
        ...(consent ? { judgmentConsent: consent } : {}),
        ...(amendment ? { amendment } : {}),
        ...(pin ? { contentPin: pin } : {}),
        baseDocumentSha256: input.currentDocument?.blobSha256 ?? null,
        decisionDocumentClaim: claim,
      },
    } as DecisionEventV1;
  return {
    event,
    plan: decisionWritePlan(event),
    blobs: [
      {
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
        body,
      },
    ],
    path,
    body,
  };
}
export function decisionWritePlan(event: DecisionEventV1): FrozenWritePlan<"DecisionWrite"> {
  const claim = event.payload.decisionDocumentClaim,
    targets: WriteTarget[] = [
      {
        kind: "event_file",
        path: eventObjectTarget(event.opId),
        operation: "create",
      },
      {
        kind: "event_head",
        path: "harness/events/head.json",
        operation: "replace",
      },
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      {
        kind: "content_blob",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      {
        kind: "projection_invalidation",
        projection: "decision/v1",
        key: event.decisionId,
      },
      {
        kind: "projection_invalidation",
        projection: "document/v1",
        key: claim.path,
      },
    ];
  if (!["decision_rejected", "decision_deferred", "decision_repinned"].includes(event.type))
    targets.push({
      kind: "projection_invalidation",
      projection: "relation-graph/v1",
      key: `decision/${event.decisionId}`,
    });
  return freezeDeclaredWritePlan({ commandType: "DecisionWrite", targets }, ["DecisionWrite"]);
}
export function assertDecisionWritePlan(event: DecisionEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({
      commandType: value.commandType,
      targets: value.targets.map(stableStringify).sort(),
    });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(decisionWritePlan(event)))
    throw new Error("decision write plan must exactly declare event, document, blob, and projections");
}
export function renderDecisionDocument(
  value: DecisionDocumentState,
  current: string | null,
  replacementBody?: string,
  judgmentOnlyRationale: string | null = null,
): string {
  const baseProse = replacementBody ?? (current === null ? `\n# ${value.title}\n` : decisionDocumentProse(current)),
    prose = judgmentOnlyRationale
      ? `${baseProse.replace(/\s*$/u, "")}\n\n## Judgment-only acceptance\n\n${judgmentOnlyRationale}\n`
      : baseProse,
    history = [
      ...(value.amendments === undefined ? [] : [`amendments: ${stableStringify(value.amendments)}`]),
      ...(value.contentPins === undefined ? [] : [`contentPins: ${stableStringify(value.contentPins)}`]),
    ],
    frontmatter = [
      "---",
      "schema: decision-package/v1",
      `decision_id: ${value.decisionId}`,
      `workspaceRevision: ${value.workspaceRevision}`,
      `title: ${stableStringify(value.title)}`,
      `state: ${value.state}`,
      `riskTier: ${value.riskTier}`,
      `urgency: ${value.urgency}`,
      `vertical: ${stableStringify(value.vertical)}`,
      `preset: ${stableStringify(value.preset)}`,
      `decisionClass: ${value.decisionClass}`,
      `applies_to: ${stableStringify(value.appliesTo)}`,
      `proposer: ${stableStringify(value.proposer)}`,
      `arbiter: ${stableStringify(value.arbiter)}`,
      `proposedAt: ${stableStringify(value.proposedAt)}`,
      `decidedAt: ${stableStringify(value.decidedAt)}`,
      `provenance: ${stableStringify(value.provenance)}`,
      `question: ${stableStringify(value.question)}`,
      `chosen: ${stableStringify(value.chosen)}`,
      `rejected: ${stableStringify(value.rejected)}`,
      `claims: ${stableStringify(value.claims)}`,
      `relations: ${stableStringify(value.relations)}`,
      `judgmentConsents: ${stableStringify(value.judgmentConsents)}`,
      ...history,
      "---",
    ].join("\n");
  return `${frontmatter}\n${prose}`;
}
export function decisionDocumentProse(body: string): string {
  const match = /^---\n[\s\S]*?\n---\n/u.exec(body);
  if (!match) throw new Error("decision document frontmatter is invalid");
  return body.slice(match[0].length);
}
export function reduceDecisionDocument(
  current: DecisionDocumentState | null,
  event: DecisionEventDraftV1,
): DecisionDocumentState {
  if (event.type === "decision_proposed") {
    const p = event.payload;
    return {
      decisionId: event.decisionId,
      state: "proposed",
      title: p.title,
      question: p.question,
      riskTier: p.riskTier,
      urgency: p.urgency,
      vertical: p.vertical,
      preset: p.preset,
      decisionClass: p.decisionClass,
      appliesTo: p.appliesTo,
      proposer: event.actor,
      arbiter: null,
      proposedAt: event.occurredAt,
      decidedAt: null,
      workspaceRevision: event.workspaceRevision,
      chosen: p.chosen,
      rejected: p.rejected,
      claims: p.claims.map((claim) => ({
        ...claim,
        fulfillment: p.fulfillments.find((entry) => entry.claimId === claim.id)?.mode ?? null,
      })),
      relations: [...p.relations].sort((a, b) => a.relation_id.localeCompare(b.relation_id)),
      provenance: p.provenance ?? [],
      judgmentConsents: [],
    };
  }
  if (!current) throw new Error(`Decision ${event.decisionId} does not exist.`);
  const revision = { ...current, workspaceRevision: event.workspaceRevision };
  if (decisionOutcome(event)) {
    const fulfillments = event.type === "decision_accepted" ? (event.payload.fulfillments ?? []) : [],
      claims =
        event.type === "decision_accepted"
          ? current.claims.map((claim) => ({
              ...claim,
              fulfillment: fulfillments.find((entry) => entry.claimId === claim.id)?.mode ?? claim.fulfillment,
            }))
          : current.claims;
    return {
      ...revision,
      state: outcomeState(event.type),
      decisionClass:
        event.type === "decision_accepted" && event.payload.standingPolicy ? "standing_policy" : current.decisionClass,
      claims,
      arbiter: event.actor,
      decidedAt: event.occurredAt,
    };
  }
  if (event.type === "decision_superseded" || event.type === "decision_retired")
    return {
      ...revision,
      state: event.type === "decision_superseded" ? "superseded" : "outcome_retired",
      decidedAt: event.occurredAt,
    };
  if (event.type === "decision_amended") return { ...revision, ...event.payload.next };
  if (event.type === "decision_repinned") return revision;
  if (event.type === "decision_claim_declared")
    return {
      ...revision,
      claims: [
        ...current.claims,
        {
          id: event.payload.claimId,
          text: event.payload.text,
          loadBearing: event.payload.loadBearing,
          fulfillment: null,
        },
      ],
    };
  if (event.type === "decision_claim_fulfillment_declared")
    return {
      ...revision,
      claims: current.claims.map((claim) =>
        claim.id === event.payload.claimId ? { ...claim, fulfillment: event.payload.mode } : claim,
      ),
    };
  if (event.type === "decision_related")
    return {
      ...revision,
      relations: [...current.relations, event.payload.relation].sort((a, b) =>
        a.relation_id.localeCompare(b.relation_id),
      ),
    };
  if (event.type === "decision_relation_replaced")
    return {
      ...revision,
      relations: [
        ...current.relations.map((relation) =>
          relation.relation_id === event.payload.relationId
            ? { ...relation, state: "edge_retired" as const }
            : relation,
        ),
        event.payload.replacement,
      ].sort((a, b) => a.relation_id.localeCompare(b.relation_id)),
    };
  return {
    ...revision,
    relations: current.relations.map((relation) =>
      relation.relation_id === event.payload.relationId ? { ...relation, state: "edge_retired" } : relation,
    ),
  };
}
export function decisionMachineDigest(value: DecisionDocumentState): `sha256:${string}` {
  const semantic = {
    schema: "decision-machine-content/v1",
    decisionId: value.decisionId,
    title: value.title,
    question: value.question,
    riskTier: value.riskTier,
    urgency: value.urgency,
    vertical: value.vertical,
    preset: value.preset,
    decisionClass: value.decisionClass,
    appliesTo: value.appliesTo,
    chosen: value.chosen,
    rejected: value.rejected,
    claims: value.claims,
    relations: value.relations,
  };
  return `sha256:${sha256Text(stableStringify(semantic))}`;
}
export function assertDecisionJudgmentConsent(current: DecisionDocumentState, event: DecisionEventV1): void {
  if (!decisionOutcome(event)) return;
  const expected = decisionConsent(current, event);
  if (stableStringify(event.payload.judgmentConsent) !== stableStringify(expected))
    invalidDecision("Decision judgment consent does not match the machine content cut or event authority.");
  assertDecisionEvidenceFloor(current, event);
}
export function assertDecisionContentPin(current: DecisionDocumentState, event: DecisionEventV1): void {
  if (
    (!decisionTransition(event) && event.type !== "decision_amended" && event.type !== "decision_repinned") ||
    event.payload.contentPin === undefined
  )
    return;
  const reduced = reduceDecisionDocument(current, event),
    expected = decisionContentPin(reduced, event);
  if (stableStringify(event.payload.contentPin) !== stableStringify(expected))
    invalidDecision("Decision content pin does not match the projected machine content cut.");
}
function decisionConsent(
  current: DecisionDocumentState,
  event: Extract<DecisionEventDraftV1 | DecisionEventV1, { readonly type: DecisionOutcomeType }>,
): DecisionJudgmentConsentV1 {
  const action = event.type.slice("decision_".length, -2) as DecisionJudgmentAction;
  return {
    schema: "decision-judgment-consent/v1",
    consentId: `djc_${sha256Text(event.opId).slice(0, 26)}`,
    decisionId: event.decisionId,
    action,
    targetState: outcomeState(event.type),
    machineDigest: decisionMachineDigest(current),
    actor: event.actor,
    source: event.source,
    consentedAt: event.occurredAt,
  };
}
function decisionAmendment(
  event: Extract<DecisionEventDraftV1 | DecisionEventV1, { readonly type: "decision_amended" }>,
): DecisionAmendmentV1 {
  return {
    schema: "decision-amendment/v1",
    amendmentId: `dam_${sha256Text(event.opId).slice(0, 26)}`,
    fields: event.payload.fields,
    actor: event.actor,
    amendedAt: event.occurredAt,
  };
}
function decisionContentPin(
  current: DecisionDocumentState,
  event: Extract<
    DecisionEventDraftV1 | DecisionEventV1,
    {
      readonly type: DecisionTransitionType | "decision_amended" | "decision_repinned";
    }
  >,
): DecisionContentPinV1 {
  const action =
      event.type === "decision_repinned"
        ? "repin"
        : event.type === "decision_amended"
          ? "amend"
          : (
              {
                decision_accepted: "accept",
                decision_rejected: "reject",
                decision_deferred: "defer",
                decision_superseded: "supersede",
                decision_retired: "retire",
              } as const
            )[event.type],
    evidence =
      event.type === "decision_repinned"
        ? event.payload.migrationEvidence
        : event.type === "decision_amended"
          ? `fields:${event.payload.fields.join(",")}`
          : event.type === "decision_accepted"
            ? event.payload.rationale
            : event.type === "decision_rejected" ||
                event.type === "decision_deferred" ||
                event.type === "decision_superseded" ||
                event.type === "decision_retired"
              ? event.payload.reason
              : "transition";
  return {
    schema: "decision-content-pin/v1",
    pinId: `dcp_${sha256Text(event.opId).slice(0, 26)}`,
    action,
    state: current.state,
    pinnedAt: event.occurredAt,
    evidence,
    actor: event.actor,
    digest: decisionMachineDigest(current),
  };
}
function decisionOutcome(
  event: DecisionEventDraftV1 | DecisionEventV1,
): event is Extract<DecisionEventDraftV1 | DecisionEventV1, { readonly type: DecisionOutcomeType }> {
  return event.type === "decision_accepted" || event.type === "decision_rejected" || event.type === "decision_deferred";
}
function decisionTransition(
  event: DecisionEventDraftV1 | DecisionEventV1,
): event is Extract<DecisionEventDraftV1 | DecisionEventV1, { readonly type: DecisionTransitionType }> {
  return decisionOutcome(event) || event.type === "decision_superseded" || event.type === "decision_retired";
}
export function outcomeState(type: DecisionOutcomeType): "in_effect" | "rejected" | "deferred" {
  return type === "decision_accepted" ? "in_effect" : (type.slice("decision_".length) as "rejected" | "deferred");
}
function assertDecisionEvidenceFloor(
  current: DecisionDocumentState | null,
  event: DecisionEventDraftV1 | DecisionEventV1,
): void {
  if (event.type !== "decision_accepted" || event.payload.judgmentOnlyRationale?.trim()) return;
  const claims = new Set((current?.claims ?? []).map((claim) => `decision/${event.decisionId}/${claim.id}`)),
    evidence = current?.relations.some(
      (edge) => edge.state === "active" && claims.has(edge.source) && isDecisionEvidenceTarget(edge.target),
    );
  if (!evidence)
    invalidDecision("decision accept requires a claim-to-evidence relation or --judgment-only <rationale>.");
}
function isDecisionEvidenceTarget(value: string): boolean {
  return (
    /^(?:fact\/F-[0-9A-HJKMNP-TV-Z]{8}|task\/[^/]+)$/u.test(value) ||
    /^decision\/dec_[A-Za-z0-9_-]+(?:\/[A-Za-z][A-Za-z0-9_-]*)?$/u.test(value)
  );
}
function invalidDecision(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "invalid_transition";
  throw error;
}
