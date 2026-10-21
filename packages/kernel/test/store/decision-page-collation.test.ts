// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { compileDecisionWrite } from "../../src/index.ts";
import { listDecisionRowsPage, reduceDecisionEvent } from "../../src/projection/decision-event-projection.ts";
import { encodePageCursor } from "../../src/projection/task-query-projection.ts";
import { decisionProjectionDatabase, proposal } from "./relation-graph-projection.fixtures.ts";

test("decision pages preserve localeCompare order for mixed ids across cursor boundaries", () => {
  const db = decisionProjectionDatabase(),
    decisionIds = [
      "dec_E2_shape-a",
      "dec_E2_shape-A",
      "dec_E2_shape_a",
      "dec_E1_shape",
      "dec_E10_shape",
      "dec_a-",
      "dec_a_",
      "dec_Ab",
      "dec_aD",
      "dec_10",
      "dec_2",
      "dec__",
    ];
  try {
    for (const [index, decisionId] of decisionIds.entries()) {
      const event = proposal(index + 1, decisionId);
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

    const expected = listDecisionRowsPage(db, {}).rows.map(({ decisionId }) => decisionId),
      visited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listDecisionRowsPage(db, { limit: 2, ...(cursor ? { cursor } : {}) });
      visited.push(...page.rows.map(({ decisionId }) => decisionId));
      cursor = page.page?.nextCursor ?? undefined;
    } while (cursor !== undefined);

    assert.deepEqual(visited, expected);
    for (const cursorId of ["dec_E2_shape-a", "dec_a_"]) {
      const offset = expected.indexOf(cursorId),
        page = listDecisionRowsPage(db, { limit: 3, cursor: encodePageCursor([cursorId]) });
      assert.notEqual(offset, -1);
      assert.deepEqual(
        page.rows.map(({ decisionId }) => decisionId),
        expected.slice(offset + 1, offset + 4),
      );
    }
  } finally {
    db.close();
  }
});
