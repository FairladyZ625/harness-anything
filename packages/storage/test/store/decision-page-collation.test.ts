// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { DecisionEventDraftV1 } from "../../src/domain/decision-event-types.ts";
import { readDecisionDocumentState } from "../../src/projection/decision-projection-documents.ts";
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

test("historical Decision amendments replay when a legacy appended claim carries fulfillment", () => {
  const db = decisionProjectionDatabase(),
    decisionId = "dec_LEGACY_AMENDMENT";
  try {
    const proposalDraft = {
        ...proposal(1, decisionId),
        payload: {
          ...proposal(1, decisionId).payload,
          claims: [{ id: "C1", text: "The original claim remains valid.", loadBearing: true }],
        },
      },
      compiledProposal = compileDecisionWrite({
        decisionReviewRequirement: "off",
        event: proposalDraft,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      }),
      proposalEvent = compiledProposal.event;
    reduceDecisionEvent(db, proposalEvent);
    const current = readDecisionDocumentState(db, decisionId);
    assert.ok(current);
    const legacyAmendment = {
      schema: "decision-event/v1" as const,
      eventId: "event-2",
      workspaceRevision: 2,
      opId: "op-2",
      decisionId,
      type: "decision_amended" as const,
      actor: proposalEvent.actor,
      source: "local" as const,
      occurredAt: "2026-08-13T00:00:02.000Z",
      payload: {
        next: {
          title: current.title,
          decisionClass: current.decisionClass,
          chosen: current.chosen,
          rejected: current.rejected,
          claims: [
            ...current.claims,
            {
              id: "C2",
              text: "The historical amendment carried fulfillment.",
              loadBearing: false,
              fulfillment: "standing_policy",
            },
          ],
        },
        fields: ["claims"],
        body: null,
      },
    } as unknown as DecisionEventDraftV1;
    const compiledAmendment = compileDecisionWrite({
      decisionReviewRequirement: "off",
      event: legacyAmendment,
      currentDecision: current,
      currentRelations: [],
      currentDocument: { blobSha256: proposalEvent.payload.decisionDocumentClaim.sha256, body: compiledProposal.body },
    });
    assert.doesNotThrow(() => reduceDecisionEvent(db, compiledAmendment.event));
    assert.deepEqual(readDecisionDocumentState(db, decisionId)?.claims.at(-1), {
      id: "C2",
      text: "The historical amendment carried fulfillment.",
      loadBearing: false,
      fulfillment: "standing_policy",
    });
  } finally {
    db.close();
  }
});
