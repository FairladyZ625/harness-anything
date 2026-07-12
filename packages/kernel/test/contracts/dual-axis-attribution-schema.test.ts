// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Schema } from "effect";
import { writeOpKinds } from "../../src/domain/write-op-kind.ts";
import {
  ActorAxesSchema,
  WriteAttributionSchema
} from "../../src/schemas/actor-attribution.ts";
import { RuntimeEventRecordV2Schema } from "../../src/schemas/runtime-event.ts";
import { AttributionEventSchema } from "../../src/schemas/attribution-event.ts";
import { JournalRecordV2Schema } from "../../src/schemas/write-journal.ts";

const fixtureRoot = "packages/kernel/fixtures/schemas/write-journal-op";

test("actor axes admit only a person principal and an agent-or-null executor", () => {
  const decode = Schema.decodeUnknownSync(ActorAxesSchema);
  assert.deepEqual(decode({
    principal: { kind: "person", personId: "person_zeyu" },
    executor: { kind: "agent", id: "codex" }
  }), {
    principal: { kind: "person", personId: "person_zeyu" },
    executor: { kind: "agent", id: "codex" }
  });
  assert.throws(() => decode({
    principal: { kind: "agent", personId: "person_zeyu" },
    executor: null
  }));
  assert.throws(() => decode({
    principal: { kind: "person", personId: "person_zeyu" },
    executor: { kind: "system", id: "cron" }
  }));
  assert.throws(() => decode({
    principal: { kind: "person", personId: "person_zeyu" },
    executor: { kind: "human", id: "zeyu" }
  }));
});

test("write attribution enforces executor/source correspondence", () => {
  const decode = Schema.decodeUnknownSync(WriteAttributionSchema);
  const source = {
    kind: "local-configured",
    authority: "harness.yaml",
    authoritySha256: "sha256:fixture"
  } as const;
  assert.doesNotThrow(() => decode({
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: null
    },
    principalSource: source,
    executorSource: "none"
  }));
  assert.throws(() => decode({
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: null
    },
    principalSource: source,
    executorSource: "client-asserted"
  }));
});

test("immutable attribution event reuses actor axes and enforces source correspondence", () => {
  const decode = Schema.decodeUnknownSync(AttributionEventSchema);
  const event = {
    schema: "attribution-event/v1",
    eventId: "attribution:op-schema",
    opId: "op-schema",
    journalRecordSchema: "write-journal/v2",
    entityId: "task/task-schema",
    kind: "doc_write",
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: { kind: "agent", id: "codex" }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: "sha256:fixture"
    },
    executorSource: "client-asserted",
    at: "2026-07-13T00:00:00.000Z",
    recordedAt: "2026-07-13T00:00:01.000Z",
    payloadHash: "payload-schema",
    payloadRef: { path: ".harness/write-journal/payloads/op-schema.json", sha256: "sha256:payload" }
  } as const;

  assert.deepEqual(decode(event).actor, Schema.decodeUnknownSync(ActorAxesSchema)(event.actor));
  assert.throws(() => decode({ ...event, executorSource: "none" }));
});

test("governed invalid fixtures fail closed", () => {
  const decode = Schema.decodeUnknownSync(JournalRecordV2Schema);
  for (const name of [
    "invalid-principal.json",
    "invalid-executor-system.json",
    "invalid-executor-human.json",
    "invalid-null-executor-source.json"
  ]) {
    const fixture = JSON.parse(readFileSync(`${fixtureRoot}/${name}`, "utf8")) as unknown;
    assert.throws(() => decode(fixture), name);
  }
});

test("runtime-event/v2 has one actor field using the shared ActorAxes schema", () => {
  const event = Schema.decodeUnknownSync(RuntimeEventRecordV2Schema)({
    schema: "runtime-event/v2",
    eventId: "evt_20260712_000001",
    recordedAt: "2026-07-12T00:00:00.000Z",
    kind: "session",
    actor: {
      principal: { kind: "person", personId: "person_zeyu" },
      executor: { kind: "agent", id: "codex" }
    },
    session: {
      sessionId: "codex-session-1",
      runtime: "codex",
      executionId: null,
      reviewId: null
    },
    turn: null,
    step: null,
    tool: null,
    approval: null,
    interrupt: null,
    result: null,
    cost: null
  });
  assert.deepEqual(event.actor, Schema.decodeUnknownSync(ActorAxesSchema)(event.actor));
  assert.equal("actorAxes" in event, false);
});

test("write kind generated JSON and fixture artifacts remain sourced from writeOpKinds", () => {
  execFileSync(process.execPath, ["tools/generate-write-journal-contract.mjs", "--check"], {
    cwd: process.cwd(),
    stdio: "pipe"
  });
  const vocabulary = JSON.parse(readFileSync(`${fixtureRoot}/write-op-kinds.json`, "utf8")) as unknown;
  assert.deepEqual(vocabulary, writeOpKinds);
});
