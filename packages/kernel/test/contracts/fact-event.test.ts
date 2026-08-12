// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { parseCanonicalEvent, serializeCanonicalEvent, type FactEventV1 } from "../../src/index.ts";
import { validateFactEvent } from "../../src/domain/fact-event.ts";

const event: FactEventV1 = { schema: "fact-event/v1", eventId: "event-fact-contract", workspaceRevision: 1, opId: "op-fact-contract",
  taskId: "task-contract", factId: "F-ABCDEFGH", type: "fact_recorded", actor: { principal: { personId: "person-contract" }, executor: null }, source: "local",
  occurredAt: "2026-08-13T00:00:00.000Z", payload: { statement: "Closed Fact payload", evidenceSource: "contract fixture", observedAt: "2026-08-13T00:00:00.000Z",
    confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"], provenance: [{ runtime: "human", sessionId: "session-contract", boundAt: "2026-08-13T00:00:00.000Z" }] } };

test("Fact event schema accepts canonical bytes and rejects invalid or unknown fields", () => {
  assert.deepEqual(validateFactEvent(event), []);
  assert.deepEqual(parseCanonicalEvent(serializeCanonicalEvent(event)), event);
  for (const invalid of [
    { ...event, unexpected: true },
    { ...event, factId: "F-bad" },
    { ...event, payload: { ...event.payload, unexpected: true } },
    { ...event, payload: { ...event.payload, memoryTags: ["pattern", "pattern"] } },
    { ...event, payload: { ...event.payload, provenance: [{ ...event.payload.provenance[0]!, token: "not allowed" }] } },
    { ...event, payload: { ...event.payload, supersedes: { factRef: "fact/task-contract/F-12345678", rationale: "x".repeat(200) } } }
  ]) assert.notDeepEqual(validateFactEvent(invalid), [], JSON.stringify(invalid));
  assert.throws(() => parseCanonicalEvent(`${JSON.stringify({ ...event, schema: "unknown-event/v1" })}\n`), /unknown/u);
});
