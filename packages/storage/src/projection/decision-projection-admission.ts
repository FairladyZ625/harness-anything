import type { DatabaseSync } from "node:sqlite";
import type { DecisionState } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import {
  assertDecisionContentPin,
  assertDecisionJudgmentConsent,
  decisionTransitionDefinitions,
  type DecisionEventV1,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { decisionClaimsOpen } from "@harness-anything/kernel/internal/domain/decision-board-projection.ts";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { readDecisionDocumentState } from "./decision-projection-reads.ts";
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
    prefix = <T>(before: readonly T[], after: readonly T[]) =>
      after.length >= before.length &&
      before.every((value, index) => stableStringify(value) === stableStringify(after[index]));
  if (next.title !== current.title) changed.add("title");
  if (next.decisionClass !== current.decisionClass) changed.add("decisionClass");
  if (!prefix(current.chosen, next.chosen))
    fail("invalid_transition", "Amendment may append chosen options but cannot rewrite or remove them.");
  if (next.chosen.length !== current.chosen.length) changed.add("chosen");
  if (!prefix(current.rejected, next.rejected))
    fail("invalid_transition", "Amendment may append rejected options but cannot rewrite or remove them.");
  if (next.rejected.length !== current.rejected.length) changed.add("rejected");
  if (next.claims.length < current.claims.length) fail("invalid_transition", "Amendment cannot remove claims.");
  for (const [index, claim] of current.claims.entries()) {
    const replacement = next.claims[index];
    if (!replacement || replacement.id !== claim.id || replacement.text !== claim.text)
      fail("invalid_transition", "Amendment may append claims but cannot rewrite their identities or text.");
    if (claim.fulfillment !== null && replacement.fulfillment !== claim.fulfillment)
      fail("invalid_transition", "Amendment cannot change an existing claim fulfillment.");
  }
  if (stableStringify(next.claims) !== stableStringify(current.claims)) changed.add("claims");
  if (event.payload.body !== null) changed.add("body");
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
