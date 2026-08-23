import type { DatabaseSync } from "node:sqlite";
import { type DecisionEventV1 } from "../domain/decision-event.ts";
import type { DocumentState } from "../domain/doc-sync.contract.ts";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import { assertDecisionAdmission, decisionState, fail } from "./decision-projection-admission.ts";
import { readDecisionBody } from "./decision-projection-documents.ts";
import type { DecisionRelationEdgeRow } from "./decision-projection-model.ts";

export function reduceDecisionEvent(db: DatabaseSync, event: DecisionEventV1): void {
  assertDecisionAdmission(db, event);
  const revision = event.workspaceRevision;
  if (event.type === "decision_proposed") {
    const p = event.payload;
    db.prepare("INSERT INTO decision VALUES (?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)").run(
      event.decisionId,
      p.title,
      p.question,
      p.riskTier,
      p.urgency,
      p.vertical,
      p.preset,
      p.decisionClass,
      JSON.stringify(p.appliesTo),
      JSON.stringify(event.actor),
      event.occurredAt,
      JSON.stringify(p.provenance ?? []),
      revision,
    );
    const insert = db.prepare("INSERT INTO decision_option VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [position, option] of p.chosen.entries())
      insert.run(event.decisionId, "chosen", option.id, position, option.text, option.rationale ?? null, revision);
    for (const [position, option] of p.rejected.entries())
      insert.run(event.decisionId, "rejected", option.id, position, option.text, option.whyNot, revision);
    const claim = db.prepare("INSERT INTO decision_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [position, entry] of p.claims.entries()) {
      const fulfillment = p.fulfillments.find((candidate) => candidate.claimId === entry.id)?.mode ?? null;
      claim.run(
        event.decisionId,
        entry.id,
        position,
        entry.text,
        entry.loadBearing ? 1 : 0,
        fulfillment,
        revision,
        fulfillment ? revision : null,
      );
    }
    for (const [index, relation] of p.relations.entries()) insertDecisionRelation(db, event, relation, index);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  db.prepare("UPDATE decision SET workspace_revision=? WHERE decision_id=?").run(revision, event.decisionId);
  if (event.type === "decision_accepted" || event.type === "decision_rejected" || event.type === "decision_deferred") {
    const state = event.type === "decision_accepted" ? "in_effect" : event.type.slice("decision_".length);
    db.prepare(
      "UPDATE decision SET state=?, arbiter_json=?, decided_at=?, workspace_revision=? WHERE decision_id=?",
    ).run(state, JSON.stringify(event.actor), event.occurredAt, revision, event.decisionId);
    db.prepare("INSERT INTO decision_judgment_consent VALUES (?, ?, ?, ?)").run(
      event.payload.judgmentConsent.consentId,
      event.decisionId,
      revision,
      JSON.stringify(event.payload.judgmentConsent),
    );
    if (event.type === "decision_accepted") {
      if (event.payload.standingPolicy)
        db.prepare("UPDATE decision SET decision_class='standing_policy' WHERE decision_id=?").run(event.decisionId);
      for (const fulfillment of event.payload.fulfillments ?? [])
        db.prepare(
          "UPDATE decision_claim SET fulfillment=?, fulfilled_revision=? WHERE decision_id=? AND claim_id=?",
        ).run(fulfillment.mode, revision, event.decisionId, fulfillment.claimId);
    }
    insertDecisionPin(db, event);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  if (event.type === "decision_superseded" || event.type === "decision_retired") {
    const state = event.type === "decision_superseded" ? "superseded" : "outcome_retired";
    db.prepare("UPDATE decision SET state=?, decided_at=?, workspace_revision=? WHERE decision_id=?").run(
      state,
      event.occurredAt,
      revision,
      event.decisionId,
    );
    insertDecisionPin(db, event);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  if (event.type === "decision_amended") {
    const next = event.payload.next;
    db.prepare("UPDATE decision SET title=?, decision_class=? WHERE decision_id=?").run(
      next.title,
      next.decisionClass,
      event.decisionId,
    );
    db.prepare("DELETE FROM decision_option WHERE decision_id=?").run(event.decisionId);
    const option = db.prepare("INSERT INTO decision_option VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [position, value] of next.chosen.entries())
      option.run(event.decisionId, "chosen", value.id, position, value.text, value.rationale ?? null, revision);
    for (const [position, value] of next.rejected.entries())
      option.run(event.decisionId, "rejected", value.id, position, value.text, value.whyNot, revision);
    db.prepare("DELETE FROM decision_claim WHERE decision_id=?").run(event.decisionId);
    const claim = db.prepare("INSERT INTO decision_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [position, value] of next.claims.entries())
      claim.run(
        event.decisionId,
        value.id,
        position,
        value.text,
        value.loadBearing ? 1 : 0,
        value.fulfillment,
        revision,
        value.fulfillment ? revision : null,
      );
    db.prepare("INSERT INTO decision_amendment VALUES (?, ?, ?, ?)").run(
      event.payload.amendment.amendmentId,
      event.decisionId,
      revision,
      JSON.stringify(event.payload.amendment),
    );
    insertDecisionPin(db, event);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  if (event.type === "decision_repinned") {
    insertDecisionPin(db, event);
    return;
  }
  if (event.type === "decision_claim_declared") {
    db.prepare(
      [
        "INSERT INTO decision_claim VALUES (?, ?,",
        "(SELECT COALESCE(MAX(position), -1) + 1 FROM decision_claim WHERE decision_id=?),",
        "?, ?, NULL, ?, NULL)",
      ].join(" "),
    ).run(
      event.decisionId,
      event.payload.claimId,
      event.decisionId,
      event.payload.text,
      event.payload.loadBearing ? 1 : 0,
      revision,
    );
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  if (event.type === "decision_claim_fulfillment_declared") {
    db.prepare("UPDATE decision_claim SET fulfillment=?, fulfilled_revision=? WHERE decision_id=? AND claim_id=?").run(
      event.payload.mode,
      revision,
      event.decisionId,
      event.payload.claimId,
    );
    return;
  }
  if (event.type === "decision_related") {
    insertDecisionRelation(db, event, event.payload.relation, 0);
    return;
  }
  if (event.type !== "decision_relation_retired" && event.type !== "decision_relation_replaced")
    fail("invalid_transition", "Unsupported Decision event.");
  retireDecisionRelation(db, event, event.payload.relationId, event.payload.reason);
  if (event.type === "decision_relation_replaced") insertDecisionRelation(db, event, event.payload.replacement, 0);
}

function insertDecisionRelation(
  db: DatabaseSync,
  event: DecisionEventV1,
  relation: EntityRelationRecord,
  recordIndex: number,
): void {
  const edge: DecisionRelationEdgeRow = {
    relationId: relation.relation_id,
    sourceRef: relation.source,
    targetRef: relation.target,
    relationType: relation.type,
    direction: relation.direction,
    strength: relation.strength,
    origin: relation.origin,
    state: "active",
    rationale: relation.rationale,
    ownerRef: `decision/${event.decisionId}`,
    sourcePath: `event:${event.opId}`,
    recordIndex,
  };
  db.prepare("INSERT INTO relation_edge VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    edge.relationId,
    edge.sourceRef,
    edge.targetRef,
    edge.relationType,
    edge.state,
    edge.ownerRef,
    event.workspaceRevision,
    JSON.stringify(edge),
  );
}

function retireDecisionRelation(db: DatabaseSync, event: DecisionEventV1, relationId: string, reason: string): void {
  const current = JSON.parse(
      String(
        (
          db.prepare("SELECT row_json FROM relation_edge WHERE relation_id=?").get(relationId) as {
            readonly row_json: string;
          }
        ).row_json,
      ),
    ) as DecisionRelationEdgeRow,
    retired = {
      ...current,
      state: "edge_retired" as const,
      retiredRevision: event.workspaceRevision,
      retiredAt: event.occurredAt,
      retirementReason: reason,
    };
  db.prepare("UPDATE relation_edge SET state='edge_retired', workspace_revision=?, row_json=? WHERE relation_id=?").run(
    event.workspaceRevision,
    JSON.stringify(retired),
    relationId,
  );
}

function insertDecisionPin(db: DatabaseSync, event: DecisionEventV1): void {
  if (!("contentPin" in event.payload) || event.payload.contentPin === undefined) return;
  const pin = event.payload.contentPin;
  db.prepare("INSERT INTO decision_content_pin VALUES (?, ?, ?, ?)").run(
    pin.pinId,
    event.decisionId,
    event.workspaceRevision,
    JSON.stringify(pin),
  );
}

export function refreshDecisionDocumentSearch(db: DatabaseSync, document: DocumentState): void {
  const id = /^decisions\/decision-(dec_[A-Za-z0-9_-]+)\/decision\.md$/u.exec(document.path)?.[1];
  if (id && decisionState(db, id)) refreshDecisionFts(db, id);
}

function refreshDecisionFts(db: DatabaseSync, decisionId: string): void {
  const row = db.prepare("SELECT title,question FROM decision WHERE decision_id=?").get(decisionId) as
    | { readonly title: string; readonly question: string }
    | undefined;
  if (!row) return;
  const options = (
      db.prepare("SELECT text FROM decision_option WHERE decision_id=?").all(decisionId) as unknown as readonly {
        readonly text: string;
      }[]
    )
      .map((o) => o.text)
      .join(" "),
    claims = (
      db.prepare("SELECT text FROM decision_claim WHERE decision_id=?").all(decisionId) as unknown as readonly {
        readonly text: string;
      }[]
    )
      .map((c) => c.text)
      .join(" "),
    body = readDecisionBody(db, decisionId)?.body ?? "";
  db.prepare("DELETE FROM decision_fts WHERE decision_id=?").run(decisionId);
  db.prepare("INSERT INTO decision_fts VALUES (?, ?, ?, ?, ?, ?)").run(
    decisionId,
    row.title,
    row.question,
    options,
    claims,
    body,
  );
}
