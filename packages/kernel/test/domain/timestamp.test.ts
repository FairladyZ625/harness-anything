// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePersistedCanonicalEvent,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  serializePersistedCanonicalEvent,
} from "../../src/domain/doc-sync.contract.ts";
import type { MigrationImportEventV1 } from "../../src/domain/migration-import-event.ts";
import { timestamp } from "../../src/domain/timestamp.ts";
import { parseEventJson } from "../../src/projection/rebuildable-task-projection-sql.ts";

test("timestamp accepts ISO-8601 UTC Z and rejects offset or local spellings", () => {
  assert.equal(timestamp("2026-08-26T02:44:00Z"), true);
  assert.equal(timestamp("2026-08-26T02:44:00.000Z"), true);
  assert.equal(timestamp("2026-08-26T10:44:00+08:00"), false);
  assert.equal(timestamp("2026-08-26T02:44:00"), false);
  assert.equal(timestamp("2026-08-26"), false);
  assert.equal(timestamp("2026-02-31T02:44:00Z"), false);
  assert.equal(timestamp("2026-08-26T24:00:00Z"), false);
  assert.equal(timestamp("not-a-timeZ"), false);
});

test("persisted event bytes stay immutable while projection reads normalize every timestamp field", () => {
  const legacy: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: "event-legacy-offset",
      workspaceRevision: 1,
      opId: "migration-legacy-offset",
      type: "entity_migrated",
      actor: { principal: { personId: "person-legacy" }, executor: null },
      source: "migration-import/v1",
      occurredAt: "2026-07-10T12:00:00+08:00",
      payload: {
        migratedFrom: "fact/task_legacy/F-ABCDEFGH",
        generation: "v0",
        entity: {
          kind: "fact",
          documentClaim: {
            path: "tasks/task_legacy-legacy/facts.md",
            sha256: "a".repeat(64),
            size: 1,
            mediaType: "text/markdown",
            policyId: "typed-migration-import/v1",
          },
          fact: {
            taskId: "task_legacy",
            factId: "F-ABCDEFGH",
            statement: "Legacy offset fact",
            evidenceSource: "legacy fixture",
            observedAt: "2026-07-10T12:00:00+08:00",
            confidence: "high",
            memoryClass: "episodic",
            memoryTags: [],
            provenance: [
              {
                runtime: "codex",
                sessionId: "session-legacy",
                boundAt: "2026-07-10T12:00:00+08:00",
              },
            ],
          },
        },
      },
    },
    bytes = serializePersistedCanonicalEvent(legacy),
    parsed = parseCanonicalEvent(bytes),
    normalized = normalizePersistedCanonicalEvent(parsed) as MigrationImportEventV1,
    projected = parseEventJson(bytes.trimEnd()) as MigrationImportEventV1;

  assert.equal(parsed.occurredAt, "2026-07-10T12:00:00+08:00");
  assert.equal(serializePersistedCanonicalEvent(parsed), bytes);
  assert.throws(() => serializeCanonicalEvent(parsed), /invalid/u);
  for (const event of [normalized, projected]) {
    assert.equal(event.occurredAt, "2026-07-10T04:00:00.000Z");
    if (event.payload.entity.kind !== "fact") assert.fail("expected fact migration");
    assert.equal(event.payload.entity.fact.observedAt, "2026-07-10T04:00:00.000Z");
    assert.equal(event.payload.entity.fact.provenance[0]?.boundAt, "2026-07-10T04:00:00.000Z");
  }
});
