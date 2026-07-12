// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDecisionDocument, serializeDecisionDocument } from "../../src/domain/decision-document.ts";
import type { DecisionPackage } from "../../src/schemas/decision-package.ts";

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

test("decision documents round-trip self-contained content pins", () => {
  const decision: DecisionPackage = {
    schema: "decision-package/v1",
    decision_id: "dec_PIN",
    title: "Pinned decision",
    state: "active",
    riskTier: "high",
    urgency: "high",
    vertical: "software/coding",
    preset: "architecture-decision",
    decisionClass: "standing-policy",
    applies_to: { modules: ["kernel"], productLines: [] },
    proposedBy: { kind: "agent", id: "codex" },
    proposedAt: "2026-07-11T00:00:00.000Z",
    arbiter: { kind: "human", id: "zeyuli" },
    decidedAt: "2026-07-11T00:01:00.000Z",
    contentPins: [{
      action: "accept",
      state: "active",
      decidedAt: "2026-07-11T00:01:00.000Z",
      arbiter: { kind: "human", id: "zeyuli" },
      canonicalization: "decision-content/v1",
      digest: "sha256:e216d18ccaa40138e579485bafaa107c8a3cc1a47b995b7c6bb8c9507ef5c4a2"
    }],
    provenance: [{ runtime: "codex", sessionId: "session-1", boundAt: "2026-07-11T00:00:00.000Z" }],
    question: "Should this content be pinned?",
    chosen: [{ id: "CH1", text: "Pin it." }],
    rejected: [{ id: "RJ1", text: "Do not pin it.", why_not: "The signature would drift." }],
    claims: [{ id: "C1", text: "Pins preserve signed meaning.", fulfillment: "standing-policy" }],
    relations: []
  };

  const document = serializeDecisionDocument({ decision }, "wm-pin");
  const parsed = parseDecisionDocument(document);

  assert.deepEqual(parsed.decision.contentPins, decision.contentPins);
  assert.equal(parsed.decision.decisionClass, "standing-policy");
  assert.equal(parsed.decision.claims[0]?.fulfillment, "standing-policy");
  assert.match(document, /^decisionClass: standing-policy$/mu);
  assert.match(document, /fulfillment: "standing-policy"/u);
  assert.match(document, /^contentPins:$/mu);
});
