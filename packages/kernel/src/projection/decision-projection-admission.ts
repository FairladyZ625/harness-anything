import type { DatabaseSync } from "node:sqlite";
import { isSameExecution } from "../domain/actor-domain-services.ts";
import type { DecisionState } from "../domain/decision-event.ts";
import {
  assertDecisionContentPin,
  assertDecisionJudgmentConsent,
  type DecisionEventV1,
} from "../domain/decision-event.ts";
import { validateRelationRecordsForHost } from "../domain/entity-relation.ts";
import type { ActorIdentity } from "../domain/write-chain.contract.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { readDecisionDocumentState } from "./decision-projection-documents.ts";
import { FactProjectionError } from "./fact-event-projection.ts";

export function assertDecisionAdmission(
  db: DatabaseSync,
  event: DecisionEventV1,
): void {
  const row = decisionState(db, event.decisionId);
  if (event.type === "decision_proposed") {
    if (row)
      fail(
        "invalid_transition",
        `Decision ${event.decisionId} already exists.`,
      );
    const host = `decision/${event.decisionId}`,
      anchors = new Set(
        [
          ...event.payload.chosen,
          ...event.payload.rejected,
          ...event.payload.claims,
        ].map((entry) => `${host}/${entry.id}`),
      );
    if (validateRelationRecordsForHost(host, event.payload.relations).length)
      fail(
        "relation_invalid",
        "Initial relation owner, kind triple, rationale, or deterministic id is invalid.",
      );
    for (const relation of event.payload.relations) {
      if (!anchors.has(relation.source))
        fail(
          "anchor_not_found",
          `Relation source ${relation.source} is not owned by this Decision.`,
        );
      if (
        relation.target !== host &&
        !anchors.has(relation.target) &&
        !knownEndpoint(db, relation.target)
      )
        fail(
          "entity_not_found",
          `Relation target ${relation.target} does not exist.`,
        );
      if (
        db
          .prepare("SELECT 1 FROM relation_edge WHERE relation_id=?")
          .get(relation.relation_id)
      )
        fail(
          "relation_invalid",
          `Relation ${relation.relation_id} already exists.`,
        );
    }
    return;
  }
  if (!row)
    fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
  if (
    ["decision_accepted", "decision_rejected", "decision_deferred"].includes(
      event.type,
    )
  ) {
    if (row.state !== "proposed")
      fail("invalid_transition", `${event.type} requires proposed state.`);
    if (
      event.actor.executor !== null &&
      isSameExecution(
        JSON.parse(row.proposer_json) as ActorIdentity,
        event.actor,
      )
    )
      fail(
        "invalid_transition",
        "An agent cannot judge its own Decision proposal.",
      );
    const current = readDecisionDocumentState(db, event.decisionId);
    if (!current)
      fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
    try {
      assertDecisionJudgmentConsent(
        current,
        event as Extract<
          DecisionEventV1,
          {
            readonly type:
              "decision_accepted" | "decision_rejected" | "decision_deferred";
          }
        >,
      );
      assertDecisionContentPin(current, event);
    } catch (error) {
      consumeKnownError(error);
      fail(
        "invalid_transition",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (event.type === "decision_accepted") {
      for (const fulfillment of event.payload.fulfillments ?? []) {
        const claim = current.claims.find(
          (entry) => entry.id === fulfillment.claimId,
        );
        if (!claim)
          fail(
            "anchor_not_found",
            `Claim ${fulfillment.claimId} does not exist.`,
          );
        if (claim.fulfillment)
          fail(
            "invalid_transition",
            `Claim ${fulfillment.claimId} already has a fulfillment.`,
          );
      }
      if (
        event.payload.standingPolicy &&
        current.appliesTo.modules.length +
          current.appliesTo.productLines.length ===
          0
      )
        fail(
          "invalid_transition",
          "Standing policy acceptance requires a non-empty applies_to scope.",
        );
    }
    return;
  }
  if (
    event.type === "decision_superseded" ||
    event.type === "decision_retired"
  ) {
    if (row.state !== "in_effect")
      fail("invalid_transition", `${event.type} requires in_effect state.`);
    const current = readDecisionDocumentState(db, event.decisionId)!;
    try {
      assertDecisionContentPin(current, event);
    } catch (error) {
      consumeKnownError(error);
      fail(
        "invalid_transition",
        error instanceof Error ? error.message : String(error),
      );
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
      fail(
        "invalid_transition",
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (event.type === "decision_repinned") {
    const current = readDecisionDocumentState(db, event.decisionId)!;
    try {
      assertDecisionContentPin(current, event);
    } catch (error) {
      consumeKnownError(error);
      fail(
        "invalid_transition",
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (event.type === "decision_claim_declared") {
    if (!(["proposed", "in_effect"] as const).includes(row.state as never))
      fail("invalid_transition", "Claims require proposed or in_effect state.");
    if (
      db
        .prepare(
          "SELECT 1 FROM decision_claim WHERE decision_id=? AND claim_id=?",
        )
        .get(event.decisionId, event.payload.claimId)
    )
      fail(
        "invalid_transition",
        `Claim ${event.payload.claimId} already exists.`,
      );
    return;
  }
  if (event.type === "decision_claim_fulfillment_declared") {
    const claim = db
      .prepare(
        "SELECT fulfillment FROM decision_claim WHERE decision_id=? AND claim_id=?",
      )
      .get(event.decisionId, event.payload.claimId) as
      { readonly fulfillment: string | null } | undefined;
    if (!claim)
      fail(
        "anchor_not_found",
        `Claim ${event.payload.claimId} does not exist.`,
      );
    if (claim.fulfillment)
      fail(
        "invalid_transition",
        `Claim ${event.payload.claimId} already has a fulfillment.`,
      );
    return;
  }
  if (event.type === "decision_related") {
    const relation = event.payload.relation,
      host = `decision/${event.decisionId}`;
    if (validateRelationRecordsForHost(host, [relation]).length)
      fail(
        "relation_invalid",
        "Relation owner, kind triple, rationale, or deterministic id is invalid.",
      );
    if (!knownDecisionSource(db, event.decisionId, relation.source))
      fail(
        "anchor_not_found",
        `Relation source ${relation.source} is not owned by this Decision.`,
      );
    if (!knownEndpoint(db, relation.target))
      fail(
        "entity_not_found",
        `Relation target ${relation.target} does not exist.`,
      );
    if (
      db
        .prepare("SELECT 1 FROM relation_edge WHERE relation_id=?")
        .get(relation.relation_id)
    )
      fail(
        "relation_invalid",
        `Relation ${relation.relation_id} already exists.`,
      );
    return;
  }
  if (
    event.type !== "decision_relation_retired" &&
    event.type !== "decision_relation_replaced"
  )
    fail("invalid_transition", "Unsupported Decision event.");
  const edge = db
    .prepare("SELECT state, owner_ref FROM relation_edge WHERE relation_id=?")
    .get(event.payload.relationId) as
    { readonly state: string; readonly owner_ref: string } | undefined;
  if (!edge)
    fail(
      "entity_not_found",
      `Relation ${event.payload.relationId} does not exist.`,
    );
  if (
    edge.owner_ref !== `decision/${event.decisionId}` ||
    edge.state !== "active"
  )
    fail(
      "relation_invalid",
      `Relation ${event.payload.relationId} is not an active edge owned by this Decision.`,
    );
  if (event.type === "decision_relation_replaced") {
    const relation = event.payload.replacement,
      host = `decision/${event.decisionId}`;
    if (validateRelationRecordsForHost(host, [relation]).length)
      fail(
        "relation_invalid",
        "Replacement relation owner, kind triple, rationale, or deterministic id is invalid.",
      );
    if (!knownDecisionSource(db, event.decisionId, relation.source))
      fail(
        "anchor_not_found",
        `Relation source ${relation.source} is not owned by this Decision.`,
      );
    if (!knownEndpoint(db, relation.target))
      fail(
        "entity_not_found",
        `Relation target ${relation.target} does not exist.`,
      );
    if (
      db
        .prepare("SELECT 1 FROM relation_edge WHERE relation_id=?")
        .get(relation.relation_id)
    )
      fail(
        "relation_invalid",
        `Replacement relation ${relation.relation_id} already exists.`,
      );
  }
}

function assertAmendment(
  db: DatabaseSync,
  event: Extract<DecisionEventV1, { readonly type: "decision_amended" }>,
): void {
  const current = readDecisionDocumentState(db, event.decisionId);
  if (!current)
    fail("entity_not_found", `Decision ${event.decisionId} does not exist.`);
  const next = event.payload.next,
    fields = new Set(event.payload.fields),
    changed = new Set<string>(),
    prefix = <T>(before: readonly T[], after: readonly T[]) =>
      after.length >= before.length &&
      before.every(
        (value, index) =>
          stableStringify(value) === stableStringify(after[index]),
      );
  if (next.title !== current.title) changed.add("title");
  if (next.decisionClass !== current.decisionClass)
    changed.add("decisionClass");
  if (!prefix(current.chosen, next.chosen))
    fail(
      "invalid_transition",
      "Amendment may append chosen options but cannot rewrite or remove them.",
    );
  if (next.chosen.length !== current.chosen.length) changed.add("chosen");
  if (!prefix(current.rejected, next.rejected))
    fail(
      "invalid_transition",
      "Amendment may append rejected options but cannot rewrite or remove them.",
    );
  if (next.rejected.length !== current.rejected.length) changed.add("rejected");
  if (next.claims.length < current.claims.length)
    fail("invalid_transition", "Amendment cannot remove claims.");
  for (const [index, claim] of current.claims.entries()) {
    const replacement = next.claims[index];
    if (
      !replacement ||
      replacement.id !== claim.id ||
      replacement.text !== claim.text
    )
      fail(
        "invalid_transition",
        "Amendment may append claims but cannot rewrite their identities or text.",
      );
    if (
      claim.fulfillment !== null &&
      replacement.fulfillment !== claim.fulfillment
    )
      fail(
        "invalid_transition",
        "Amendment cannot change an existing claim fulfillment.",
      );
  }
  if (stableStringify(next.claims) !== stableStringify(current.claims))
    changed.add("claims");
  if (event.payload.body !== null) changed.add("body");
  if (
    [...fields].some(
      (field) =>
        ![
          "title",
          "decisionClass",
          "chosen",
          "rejected",
          "claims",
          "body",
        ].includes(field),
    ) ||
    [...fields].sort().join("\0") !== [...changed].sort().join("\0")
  )
    fail(
      "invalid_transition",
      `Amendment fields must exactly name the changed machine and prose channels (declared: ${[...fields].join(",")}; changed: ${[...changed].join(",")}).`,
    );
  if (
    JSON.stringify(event.payload.amendment.fields) !==
    JSON.stringify(event.payload.fields)
  )
    fail(
      "invalid_transition",
      "Amendment history does not match the declared field set.",
    );
}

export function decisionState(
  db: DatabaseSync,
  id: string,
):
  | { readonly state: DecisionState; readonly proposer_json: string }
  | undefined {
  return db
    .prepare("SELECT state,proposer_json FROM decision WHERE decision_id=?")
    .get(id) as
    | { readonly state: DecisionState; readonly proposer_json: string }
    | undefined;
}

function decisionAnchorRefs(db: DatabaseSync, id: string): string[] {
  const root = `decision/${id}`,
    option = db
      .prepare("SELECT option_id FROM decision_option WHERE decision_id=?")
      .all(id) as unknown as readonly { readonly option_id: string }[],
    claims = db
      .prepare("SELECT claim_id FROM decision_claim WHERE decision_id=?")
      .all(id) as unknown as readonly { readonly claim_id: string }[];
  return [
    root,
    ...option.map((o) => `${root}/${o.option_id}`),
    ...claims.map((c) => `${root}/${c.claim_id}`),
  ].sort();
}

function knownDecisionSource(
  db: DatabaseSync,
  id: string,
  ref: string,
): boolean {
  return decisionAnchorRefs(db, id).includes(ref);
}

function knownEndpoint(db: DatabaseSync, ref: string): boolean {
  const decision = /^decision\/([^/]+)(?:\/([^/]+))?$/u.exec(ref);
  if (decision)
    return decision[2]
      ? decisionAnchorRefs(db, decision[1]!).includes(ref)
      : Boolean(decisionState(db, decision[1]!));
  const fact = /^fact\/([^/]+)\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(ref);
  if (fact)
    return Boolean(
      db
        .prepare("SELECT 1 FROM fact WHERE task_id=? AND fact_id=?")
        .get(fact[1], fact[2]),
    );
  const task = /^task\/([^/]+)$/u.exec(ref);
  return Boolean(
    task &&
    db.prepare("SELECT 1 FROM task_snapshot WHERE task_id=?").get(task[1]),
  );
}

export function fail(
  code: FactProjectionError["code"],
  message: string,
): never {
  throw new FactProjectionError(code, message);
}
