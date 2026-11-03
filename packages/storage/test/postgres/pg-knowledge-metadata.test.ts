// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { pgKnowledgeQueries } from "../../src/pg/pg-knowledge-queries.ts";

test("PG decision document state requests metadata and preserves missing decisions", async () => {
  const queries = pgKnowledgeQueries(
    { scope: {}, repoId: "metadata" } as never,
    {
      readDecision: async (id: string, withBody?: boolean) => {
        assert.equal(withBody, false, "document state must not fetch a body that it discards");
        return { decision: id === "missing" ? null : { decisionId: id, title: "Policy", body: null } };
      },
    } as never,
  );
  assert.deepEqual(await queries.readDecisionDocumentState("dec_METADATA"), {
    decisionId: "dec_METADATA",
    title: "Policy",
  });
  assert.equal(await queries.readDecisionDocumentState("missing"), null);
});
