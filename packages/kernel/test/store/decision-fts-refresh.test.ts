// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderDecisionDocument, type DecisionDocumentState } from "../../src/domain/decision-event.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  type MigrationImportEventV1,
} from "../../src/domain/migration-import-event.ts";
import type { DocumentState } from "../../src/domain/doc-sync-types.ts";
import { compileDecisionWrite } from "../../src/index.ts";
import { decisionIdSortKey, reduceDecisionEvent } from "../../src/projection/decision-event-projection.ts";
import { refreshDecisionDocumentSearch } from "../../src/projection/decision-projection-reducer.ts";
import { projectMigration } from "../../src/projection/rebuildable-task-projection-write-model.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { decisionProjectionDatabase, proposal } from "./relation-graph-projection.fixtures.ts";

test("decision search rows are keyed by the decision rowid and refresh in place", () => {
  const db = decisionProjectionDatabase();
  try {
    for (const [revision, decisionId] of [
      [1, "dec_FIRST"],
      [2, "dec_SECOND"],
    ] as const) {
      const event = proposal(revision, decisionId);
      reduceDecisionEvent(
        db,
        compileDecisionWrite({
          decisionReviewRequirement: "off",
          event,
          currentDecision: null,
          currentRelations: [],
          currentDocument: null,
        }).event,
      );
    }
    const document: DocumentState = {
      path: "decisions/decision-dec_SECOND/decision.md" as DocumentState["path"],
      blobSha256: "0".repeat(64),
      body: "",
      size: 0 as DocumentState["size"],
      mediaType: "text/markdown",
      policyId: "decision",
      workspaceRevision: 3,
    };
    for (let round = 0; round < 3; round += 1) refreshDecisionDocumentSearch(db, document);
    // Each refresh deletes by rowid and re-inserts under the decision's own rowid, so the search
    // row never moves to a fresh fts rowid and is addressed without scanning decision_id.
    const searchRows = (
      db.prepare("SELECT rowid, decision_id AS decisionId FROM decision_fts ORDER BY rowid").all() as readonly {
        readonly rowid: number;
        readonly decisionId: string;
      }[]
    ).map(({ rowid, decisionId }) => ({ rowid, decisionId }));
    assert.deepEqual(searchRows, [
      { rowid: 1, decisionId: "dec_FIRST" },
      { rowid: 2, decisionId: "dec_SECOND" },
    ]);
  } finally {
    db.close();
  }
});

test("decision reducer materializes legacy numbers for indexed list reads", () => {
  const db = decisionProjectionDatabase();
  try {
    const event = proposal(1, "dec_E42_LEGACY");
    reduceDecisionEvent(
      db,
      compileDecisionWrite({
        decisionReviewRequirement: "off",
        event,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      }).event,
    );
    const row = db
      .prepare("SELECT legacy_number, decision_sort_key FROM decision WHERE decision_id = ?")
      .get("dec_E42_LEGACY") as { readonly legacy_number: number; readonly decision_sort_key: string };
    assert.equal(row.legacy_number, 42);
    assert.equal(row.decision_sort_key, decisionIdSortKey("dec_E42_LEGACY"));
  } finally {
    db.close();
  }
});

test("decision migration imports materialize legacy numbers for indexed list reads", () => {
  const db = decisionProjectionDatabase(),
    decisionId = "dec_E43_MIGRATED",
    decision: DecisionDocumentState = {
      decisionId,
      state: "in_effect",
      title: "Migrated decision",
      question: "Does replay retain its list key?",
      riskTier: "medium",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["kernel"], productLines: [] },
      proposer: { principal: { personId: "fixture" }, executor: null },
      arbiter: null,
      proposedAt: "2026-08-14T00:00:00.000Z",
      decidedAt: "2026-08-14T01:00:00.000Z",
      workspaceRevision: 1,
      chosen: [],
      rejected: [],
      claims: [],
      relations: [],
      provenance: [],
      judgmentConsents: [],
      reviews: [],
      reviewResponses: [],
      reviewOverrides: [],
    },
    body = renderDecisionDocument(decision, null),
    bytes = Buffer.from(body),
    sha256 = sha256Text(body),
    event: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-migrated-decision",
      workspaceRevision: 1,
      opId: "op-migrated-decision",
      type: "entity_migrated",
      actor: { principal: { personId: "fixture" }, executor: null },
      source: MIGRATION_IMPORT_SOURCE,
      occurredAt: "2026-08-14T01:00:00.000Z",
      payload: {
        migratedFrom: decisionId,
        generation: "v0",
        entity: {
          kind: "decision",
          decision,
          documentClaim: {
            path: `decisions/decision-${decisionId}/decision.md`,
            sha256,
            size: bytes.byteLength,
            mediaType: "text/markdown",
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
        },
      },
    };
  try {
    db.exec(
      "CREATE TABLE event_index (op_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, task_id TEXT, event_json TEXT NOT NULL)",
    );
    projectMigration(db, event, JSON.stringify(event), (blobSha256) => (blobSha256 === sha256 ? bytes : null));
    const row = db
      .prepare("SELECT legacy_number, decision_sort_key FROM decision WHERE decision_id = ?")
      .get(decisionId) as { readonly legacy_number: number; readonly decision_sort_key: string };
    assert.equal(row.legacy_number, 43);
    assert.equal(row.decision_sort_key, decisionIdSortKey(decisionId));
  } finally {
    db.close();
  }
});
