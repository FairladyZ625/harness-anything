// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createTaskEvent, type TaskEventV1 } from "../../src/domain/task-lifecycle-event.ts";
import { relationCreatedEventForReplay, type RelationEventV1 } from "../../src/domain/relation-event.ts";
import { serializeCanonicalEventUnchecked } from "../../src/domain/doc-sync-canonical-events.ts";
import { createAgentRuntimeEvent } from "../../src/domain/agent-runtime-event.ts";
import type { AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";

function accepted<T>(family: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/canonical-events/${family}/accepted.json`, import.meta.url), "utf8"),
  ) as T;
}

test("task construction keeps the accepted payload and identity while initializing publication claims", () => {
  const fixture = accepted<TaskEventV1>("task-event-v1"),
    { documentClaims: _claims, ...payload } = fixture.payload,
    event = createTaskEvent(fixture, fixture.type, payload),
    expected = { ...fixture, payload: { ...payload, documentClaims: [] } };
  assert.equal(serializeCanonicalEventUnchecked(event), serializeCanonicalEventUnchecked(expected));
});

test("runtime construction preserves the archived accepted event bytes", () => {
  const fixture = accepted<AgentRuntimeEventV1>("agent-runtime-event-v1"),
    { schema: _schema, ...input } = fixture;
  assert.equal(
    serializeCanonicalEventUnchecked(createAgentRuntimeEvent(input)),
    serializeCanonicalEventUnchecked(fixture),
  );
});

test("derived relation replay preserves a historical event id independent of the op id", () => {
  const fixture = accepted<Extract<RelationEventV1, { readonly type: "relation_created" }>>("relation-event-v1"),
    historical = { ...fixture, eventId: "historical-import-event-id" },
    event = relationCreatedEventForReplay(historical, historical.payload.relation);
  assert.equal(serializeCanonicalEventUnchecked(event), serializeCanonicalEventUnchecked(historical));
  assert.notEqual(event.eventId, `event-${event.opId}`);
});

// Frozen accepted samples cover every historical payload facet, including document
// claims that the writer attaches after the action compiler builds the draft.
import { createDecisionEvent, type DecisionEventDraftV1 } from "../../src/domain/decision-event.ts";
import { createFactEvent, type FactEventV1 } from "../../src/domain/fact-event.ts";
for (const family of ["decision-event-v1", "fact-event-v1"]) {
  test(`${family} aggregate construction preserves all frozen accepted event bytes`, () => {
    const directory = new URL(`../../fixtures/canonical-events/${family}/`, import.meta.url);
    const files = readdirSync(directory).filter((name) => /^accepted.*\.json$/u.test(name));
    assert.ok(files.length > 0);
    for (const file of files) {
      const fixture = JSON.parse(readFileSync(new URL(file, directory), "utf8")) as DecisionEventDraftV1 | FactEventV1;
      const { schema: _schema, type, payload, ...identity } = fixture;
      const event =
        family === "decision-event-v1"
          ? createDecisionEvent(
              identity as Omit<DecisionEventDraftV1, "schema" | "type" | "payload">,
              type as DecisionEventDraftV1["type"],
              payload as never,
            )
          : createFactEvent(
              { ...identity, payload } as Omit<FactEventV1, "schema" | "type">,
              type as FactEventV1["type"],
            );
      assert.equal(serializeCanonicalEventUnchecked(event), serializeCanonicalEventUnchecked(fixture), file);
    }
  });
}
