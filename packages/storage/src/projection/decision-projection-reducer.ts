import type { DatabaseSync } from "node:sqlite";
import type { DecisionEventV1 } from "@harness-anything/kernel/internal/domain/decision-event.ts";
import type {
  DocumentState,
  PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { assertDecisionAdmission, decisionState, fail } from "./decision-projection-admission.ts";
import {
  changedDecisionDocuments,
  changedDecisionEvidenceRelations,
  decisionDocumentPattern,
  projectDecisionListReview,
  readDecisionBody,
} from "./decision-projection-documents.ts";
import { decisionIdSortKey, decisionLegacyNumber, readDecisionDocumentState } from "./decision-projection-reads.ts";
import { applyEmbeddedRelationProjectionEvents } from "./relation-entity-projection.ts";
import { prepareQuery, queryRows, runSql } from "./rebuildable-task-projection-sql.ts";

export function reduceDecisionEvent(db: DatabaseSync, event: DecisionEventV1): void {
  assertDecisionAdmission(db, event);
  const revision = event.workspaceRevision;
  if (event.type === "decision_proposed") {
    const p = event.payload;
    prepareQuery(
      db,
      "INSERT INTO decision(decision_id, legacy_number, decision_sort_key, state, title, question, risk_tier, urgency, vertical, preset, decision_class, applies_json, proposer_json, arbiter_json, proposed_at, decided_at, provenance_json, workspace_revision) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)",
    ).run(
      event.decisionId,
      decisionLegacyNumber(event.decisionId),
      decisionIdSortKey(event.decisionId),
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
    const insert = prepareQuery(db, "INSERT INTO decision_option VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [position, option] of p.chosen.entries())
      insert.run(event.decisionId, "chosen", option.id, position, option.text, option.rationale ?? null, revision);
    for (const [position, option] of p.rejected.entries())
      insert.run(event.decisionId, "rejected", option.id, position, option.text, option.whyNot, revision);
    const claim = prepareQuery(db, "INSERT INTO decision_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
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
    applyEmbeddedRelationProjectionEvents(db, event);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  prepareQuery(db, "UPDATE decision SET workspace_revision=? WHERE decision_id=?").run(revision, event.decisionId);
  if (event.type === "decision_accepted" || event.type === "decision_rejected" || event.type === "decision_deferred") {
    const state = event.type === "decision_accepted" ? "in_effect" : event.type.slice("decision_".length);
    prepareQuery(
      db,
      "UPDATE decision SET state=?, arbiter_json=?, decided_at=?, workspace_revision=? WHERE decision_id=?",
    ).run(state, JSON.stringify(event.actor), event.occurredAt, revision, event.decisionId);
    prepareQuery(db, "INSERT INTO decision_judgment_consent VALUES (?, ?, ?, ?)").run(
      event.payload.judgmentConsent.consentId,
      event.decisionId,
      revision,
      JSON.stringify(event.payload.judgmentConsent),
    );
    if (event.type === "decision_accepted") {
      if (event.payload.standingPolicy)
        prepareQuery(db, "UPDATE decision SET decision_class='standing_policy' WHERE decision_id=?").run(
          event.decisionId,
        );
      for (const fulfillment of event.payload.fulfillments ?? [])
        prepareQuery(
          db,
          "UPDATE decision_claim SET fulfillment=?, fulfilled_revision=? WHERE decision_id=? AND claim_id=?",
        ).run(fulfillment.mode, revision, event.decisionId, fulfillment.claimId);
    }
    insertDecisionPin(db, event);
    if (["decision_accepted", "decision_rejected"].includes(event.type))
      prepareQuery(db, "DELETE FROM pinned_entities WHERE entity_ref=?").run(`decision/${event.decisionId}`);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  if (event.type === "decision_superseded" || event.type === "decision_retired") {
    const state = event.type === "decision_superseded" ? "superseded" : "outcome_retired";
    prepareQuery(db, "UPDATE decision SET state=?, decided_at=?, workspace_revision=? WHERE decision_id=?").run(
      state,
      event.occurredAt,
      revision,
      event.decisionId,
    );
    insertDecisionPin(db, event);
    prepareQuery(db, "DELETE FROM pinned_entities WHERE entity_ref=?").run(`decision/${event.decisionId}`);
    refreshDecisionFts(db, event.decisionId);
    return;
  }
  if (event.type === "decision_amended") {
    const next = event.payload.next;
    prepareQuery(db, "UPDATE decision SET title=?, decision_class=? WHERE decision_id=?").run(
      next.title,
      next.decisionClass,
      event.decisionId,
    );
    if (next.appliesTo !== undefined)
      prepareQuery(db, "UPDATE decision SET applies_json=? WHERE decision_id=?").run(
        JSON.stringify(next.appliesTo),
        event.decisionId,
      );
    prepareQuery(db, "DELETE FROM decision_option WHERE decision_id=?").run(event.decisionId);
    const option = prepareQuery(db, "INSERT INTO decision_option VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [position, value] of next.chosen.entries())
      option.run(event.decisionId, "chosen", value.id, position, value.text, value.rationale ?? null, revision);
    for (const [position, value] of next.rejected.entries())
      option.run(event.decisionId, "rejected", value.id, position, value.text, value.whyNot, revision);
    prepareQuery(db, "DELETE FROM decision_claim WHERE decision_id=?").run(event.decisionId);
    const claim = prepareQuery(db, "INSERT INTO decision_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
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
    prepareQuery(db, "INSERT INTO decision_amendment VALUES (?, ?, ?, ?)").run(
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
  if (event.type === "decision_review_recorded") {
    prepareQuery(db, "INSERT INTO decision_review_event VALUES (?, ?, 'review', ?, ?)").run(
      event.eventId,
      event.decisionId,
      revision,
      JSON.stringify({ ...event.payload, actor: event.actor, reviewedAt: event.occurredAt }),
    );
    return;
  }
  if (event.type === "decision_review_responded") {
    prepareQuery(db, "INSERT INTO decision_review_event VALUES (?, ?, 'response', ?, ?)").run(
      event.eventId,
      event.decisionId,
      revision,
      JSON.stringify(
        event.payload.responses.map((response) => ({
          ...response,
          actor: event.actor,
          respondedAt: event.occurredAt,
        })),
      ),
    );
    return;
  }
  if (event.type === "decision_review_overridden") {
    prepareQuery(db, "INSERT INTO decision_review_event VALUES (?, ?, 'override', ?, ?)").run(
      event.eventId,
      event.decisionId,
      revision,
      JSON.stringify({
        reviewContentDigest: event.payload.reviewContentDigest,
        reviewIds: event.payload.reviewIds,
        reason: event.payload.reason,
        actor: event.actor,
        overriddenAt: event.occurredAt,
      }),
    );
    return;
  }
  if (event.type === "decision_claim_declared") {
    prepareQuery(
      db,
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
    prepareQuery(
      db,
      "UPDATE decision_claim SET fulfillment=?, fulfilled_revision=? WHERE decision_id=? AND claim_id=?",
    ).run(event.payload.mode, revision, event.decisionId, event.payload.claimId);
    return;
  }
  if (
    event.type === "decision_related" ||
    event.type === "decision_relation_retired" ||
    event.type === "decision_relation_replaced"
  ) {
    applyEmbeddedRelationProjectionEvents(db, event);
    return;
  }
  fail("invalid_transition", "Unsupported Decision event.");
}

function insertDecisionPin(db: DatabaseSync, event: DecisionEventV1): void {
  if (!("contentPin" in event.payload) || event.payload.contentPin === undefined) return;
  const pin = event.payload.contentPin;
  prepareQuery(db, "INSERT INTO decision_content_pin VALUES (?, ?, ?, ?)").run(
    pin.pinId,
    event.decisionId,
    event.workspaceRevision,
    JSON.stringify(pin),
  );
}

export function refreshDecisionDocumentSearch(db: DatabaseSync, document: DocumentState): void {
  const id =
    /* @gate-identity state-store/task.source.storage.src.projection.decision-projection-reducer.sqlite-database */ decisionDocumentPattern.exec(
      document.path,
    )?.[1];
  if (id && decisionState(db, id)) refreshDecisionFts(db, id);
}

export function refreshDecisionListReview(db: DatabaseSync, id: string): void {
  const decision = readDecisionDocumentState(db, id);
  if (decision === null) return;
  const body = readDecisionBody(db, id);
  runSql(
    db,
    "UPDATE decision SET list_options_json=?,review_summary_json=? WHERE decision_id=?",
    JSON.stringify({ chosen: decision.chosen, rejected: decision.rejected }),
    body === null ? null : JSON.stringify(projectDecisionListReview(decision, body.body)),
    id,
  );
}

export function refreshDecisionListReviews(db: DatabaseSync, event: PersistedCanonicalEventV1): void {
  const owners = changedDecisionDocuments(event),
    relationIds = changedDecisionEvidenceRelations(event);
  if (relationIds.length > 0)
    for (const { owner_ref } of queryRows<{ readonly owner_ref: string }>(
      db,
      "SELECT owner_ref FROM relation_edge WHERE relation_id IN (SELECT value FROM json_each(?)) " +
        "AND relation_type IN ('evidenced-by','refuted-by') AND owner_ref GLOB 'decision/*'",
      JSON.stringify(relationIds),
    ))
      owners.add(owner_ref.slice("decision/".length));
  for (const id of owners) refreshDecisionListReview(db, id);
}

function refreshDecisionFts(db: DatabaseSync, decisionId: string): void {
  // decision_id is UNINDEXED in the fts5 table, so the search row is keyed by the decision rowid
  // (stable: decision rows are inserted once and only updated) instead of deleted by a column scan.
  const row = prepareQuery(db, "SELECT rowid, title, question FROM decision WHERE decision_id=?").get(decisionId) as
    | { readonly rowid: number; readonly title: string; readonly question: string }
    | undefined;
  if (!row) return;
  const options = queryRows<{ readonly text: string }>(
      db,
      "SELECT text FROM decision_option WHERE decision_id=?",
      decisionId,
    )
      .map((o) => o.text)
      .join(" "),
    claims = queryRows<{ readonly text: string }>(db, "SELECT text FROM decision_claim WHERE decision_id=?", decisionId)
      .map((c) => c.text)
      .join(" "),
    body = readDecisionBody(db, decisionId)?.body ?? "";
  prepareQuery(db, "DELETE FROM decision_fts WHERE rowid=?").run(row.rowid);
  prepareQuery(
    db,
    "INSERT INTO decision_fts(rowid, decision_id, title, question, option_text, claim_text, body) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(row.rowid, decisionId, row.title, row.question, options, claims, body);
}
