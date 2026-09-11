// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentState } from "../../src/domain/doc-sync-types.ts";
import { compileDecisionWrite } from "../../src/index.ts";
import { reduceDecisionEvent } from "../../src/projection/decision-event-projection.ts";
import { refreshDecisionDocumentSearch } from "../../src/projection/decision-projection-reducer.ts";
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
        compileDecisionWrite({ event, currentDecision: null, currentRelations: [], currentDocument: null }).event,
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
