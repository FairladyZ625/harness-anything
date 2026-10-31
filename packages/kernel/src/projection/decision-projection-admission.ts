import type { DatabaseSync } from "node:sqlite";
import type { DecisionState } from "../domain/decision-event.ts";
import {
  assertDecisionContentPin,
  assertDecisionJudgmentConsent,
  decisionTransitionDefinitions,
  type DecisionEventV1,
} from "../domain/decision-event.ts";
import { decisionClaimsOpen } from "../domain/decision-board-projection.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { readDecisionDocumentState } from "./decision-projection-documents.ts";
import { FactProjectionError } from "./fact-event-projection.ts";
import { prepareQuery } from "./rebuildable-task-projection-sql.ts";

export function assertDecisionAdmission(db: DatabaseSync, event: DecisionEventV1): void {
  const row = decisionState(db, event.decisionId);
  if (event.type === "decision_proposed") {
    if (row) fail("invalid_transition", `Decision ${event.decisionId} already exists.`);
    return;
  }
  if (!row) fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
  const transition = decisionTransitionDefinitions.find(({ eventType }) => eventType === event.type);
  const supersedingProposedDecision = event.type === "decision_superseded" && row.state === "proposed";
  if (transition && row.state !== transition.sourceState && !supersedingProposedDecision)
    fail("invalid_transition", `${event.type} requires ${transition.sourceState} state.`);
  if (supersedingProposedDecision && !hasActiveSupersedesRelation(db, event.decisionId))
    fail(
      "invalid_transition",
      `Decision ${event.decisionId} can leave proposed for superseded only with an active supersedes Relation from another Decision.`,
    );
  if (["decision_accepted", "decision_rejected", "decision_deferred"].includes(event.type)) {
    const current = readDecisionDocumentState(db, event.decisionId);
    if (!current) fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
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
      consumeKnownError(error);
      fail("invalid_transition", error instanceof Error ? error.message : String(error));
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
  if (event.type === "decision_superseded" || event.type === "decision_retired") {
    const current = readDecisionDocumentState(db, event.decisionId)!;
    try {
      assertDecisionContentPin(current, event);
    } catch (error) {
      consumeKnownError(error);
      fail("invalid_transition", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (event.type === "decision_amended") {
    assertAmendment(db, event);
    const current = readDecisionDocumentState(db, event.decisionId)!;
    try {
      assertDecisionContentPin(current, event);
    } catch (error) {
      consumeKnownError(error);
      fail("invalid_transition", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (event.type === "decision_repinned") {
    const current = readDecisionDocumentState(db, event.decisionId)!;
    try {
      assertDecisionContentPin(current, event);
    } catch (error) {
      consumeKnownError(error);
      fail("invalid_transition", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (event.type === "decision_claim_declared") {
    if (!decisionClaimsOpen(row.state)) fail("invalid_transition", "Claims require proposed or in_effect state.");
    if (
      prepareQuery(db, "SELECT 1 FROM decision_claim WHERE decision_id=? AND claim_id=?").get(
        event.decisionId,
        event.payload.claimId,
      )
    )
      fail("invalid_transition", `Claim ${event.payload.claimId} already exists.`);
    return;
  }
  if (event.type === "decision_claim_fulfillment_declared") {
    const claim = prepareQuery(db, "SELECT fulfillment FROM decision_claim WHERE decision_id=? AND claim_id=?").get(
      event.decisionId,
      event.payload.claimId,
    ) as { readonly fulfillment: string | null } | undefined;
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
  db: DatabaseSync,
  event: Extract<DecisionEventV1, { readonly type: "decision_amended" }>,
): void {
  const current = readDecisionDocumentState(db, event.decisionId);
  if (!current) fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
  const next = event.payload.next,
    fields = new Set(event.payload.fields),
    changed = new Set<string>(),
    beforeAnchors = [...current.chosen, ...current.rejected, ...current.claims].map(({ id }) => id),
    afterAnchors = new Set([...next.chosen, ...next.rejected, ...next.claims].map(({ id }) => id));
  if (next.title !== current.title) changed.add("title");
  if (next.decisionClass !== current.decisionClass) changed.add("decisionClass");
  if (stableStringify(next.chosen) !== stableStringify(current.chosen)) changed.add("chosen");
  if (stableStringify(next.rejected) !== stableStringify(current.rejected)) changed.add("rejected");
  for (const claim of next.claims) {
    const previous = current.claims.find(({ id }) => id === claim.id);
    if (previous && previous.text === claim.text && previous.fulfillment !== claim.fulfillment)
      fail("invalid_transition", `Amendment cannot change fulfillment for unchanged claim ${claim.id}.`);
    if (previous && previous.text !== claim.text && claim.fulfillment !== null)
      fail("invalid_transition", `Amendment must clear fulfillment when rewriting claim ${claim.id}.`);
    if (!previous && claim.fulfillment !== null)
      fail("invalid_transition", `New claim ${claim.id} cannot carry a fulfillment.`);
  }
  if (stableStringify(next.claims) !== stableStringify(current.claims)) changed.add("claims");
  if (event.payload.body !== null) changed.add("body");
  assertNoRemovedActiveRelationAnchors(db, event.decisionId, beforeAnchors, afterAnchors);
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
  db: DatabaseSync,
  decisionId: string,
  before: readonly string[],
  after: ReadonlySet<string>,
): void {
  const removed = new Set(before.filter((id) => !after.has(id)));
  if (!removed.size) return;
  const references = prepareQuery(
      db,
      "SELECT relation_id, source_ref, target_ref FROM relation_edge WHERE state='active' AND (source_ref GLOB ? OR target_ref GLOB ?) ORDER BY relation_id",
    ).all(`decision/${decisionId}/*`, `decision/${decisionId}/*`) as unknown as readonly {
      readonly relation_id: string;
      readonly source_ref: string;
      readonly target_ref: string;
    }[],
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

function hasActiveSupersedesRelation(db: DatabaseSync, decisionId: string): boolean {
  return Boolean(
    prepareQuery(
      db,
      "SELECT 1 FROM relation_edge WHERE target_ref=? AND relation_type='supersedes' AND state='active' " +
        "AND source_ref GLOB 'decision/*' AND source_ref<>? AND source_ref NOT GLOB ? LIMIT 1",
    ).get(`decision/${decisionId}`, `decision/${decisionId}`, `decision/${decisionId}/*`),
  );
}

export function decisionState(
  db: DatabaseSync,
  id: string,
): { readonly state: DecisionState; readonly proposer_json: string } | undefined {
  return prepareQuery(db, "SELECT state,proposer_json FROM decision WHERE decision_id=?").get(id) as
    | { readonly state: DecisionState; readonly proposer_json: string }
    | undefined;
}

export function fail(code: FactProjectionError["code"], message: string): never {
  throw new FactProjectionError(code, message);
}
