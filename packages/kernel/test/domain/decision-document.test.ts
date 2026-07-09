import assert from "node:assert/strict";
import test from "node:test";
import { parseDecisionDocument } from "../../src/domain/decision-document.ts";

test("parses CRLF decision frontmatter blocks and strips the frontmatter body", () => {
  const body = [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_CRLF",
    "_coordinatorWatermark: op-1",
    "title: \"CRLF decision\"",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"standard-task\"",
    "applies_to:",
    "  modules: [\"kernel\"]",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"codex\" }",
    "proposedAt: \"2026-07-09T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"ZeyuLi\" }",
    "provenance:",
    "  - { runtime: \"human\", sessionId: \"human-cli-1\", boundAt: \"2026-07-09T00:00:00.000Z\" }",
    "question: \"Can CRLF decisions be parsed?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Normalize frontmatter.\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"Leave CRLF in parser input.\", why_not: \"Block parsers expect LF lines.\" }",
    "claims:",
    "  - { id: \"C1\", text: \"Decision lists survive CRLF frontmatter.\" }",
    "relations:",
    "  - { relation_id: \"rel_1\", from: \"decision/dec_CRLF/CH1\", to: \"task/task_01ABC\", type: \"supports\" }",
    "---",
    "",
    "# CRLF decision",
    ""
  ].join("\r\n");

  const parsed = parseDecisionDocument(body);

  assert.equal(parsed.decision.decision_id, "dec_CRLF");
  assert.equal(parsed.decision.applies_to.modules[0], "kernel");
  assert.equal(parsed.decision.provenance[0]?.runtime, "human");
  assert.equal(parsed.decision.chosen[0]?.id, "CH1");
  assert.equal(parsed.decision.rejected[0]?.why_not, "Block parsers expect LF lines.");
  assert.equal(parsed.decision.claims[0]?.id, "C1");
  assert.equal(parsed.decision.relations[0]?.relation_id, "rel_1");
  assert.equal(parsed.body, "\r\n# CRLF decision\r\n");
});
