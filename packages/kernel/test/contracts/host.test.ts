// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateEntityJsonSchema } from "../../src/domain/entity-json-schema.ts";
import {
  HOST_DIAGNOSTIC_LINE_SCHEMA,
  HOST_PROCESS_LOCK_SCHEMA,
  appendHostDiagnostic,
  hostAggregateSchema,
  hostDiagnosticLineSchema,
  hostProcessLockSchema,
  reduceHostProcessLock,
  validateHostDiagnosticLine,
  validateHostProcessLock,
  withHostProcessLock,
} from "../../src/domain/host.ts";

test("host aggregate and operational records use their fixed schemas", () => {
  assert.equal(hostAggregateSchema.$id, "host/v1");
  assert.equal(hostProcessLockSchema.$id, HOST_PROCESS_LOCK_SCHEMA);
  assert.equal(hostDiagnosticLineSchema.$id, HOST_DIAGNOSTIC_LINE_SCHEMA);
  assert.deepEqual(validateEntityJsonSchema(hostAggregateSchema, { hostId: "singleton", process: "running" }), []);
  assert.ok(validateEntityJsonSchema(hostAggregateSchema, { hostId: "other", process: "running" }).length > 0);

  const lock = { pid: 42, token: "lock-token", acquiredAt: "2026-11-08T00:00:00.000Z" },
    line = { at: "2026-11-08T00:00:00.000Z", level: "info" as const, source: "worker", message: "started" };
  assert.deepEqual(validateEntityJsonSchema(hostProcessLockSchema, lock), []);
  assert.deepEqual(validateEntityJsonSchema(hostDiagnosticLineSchema, line), []);
  assert.ok(validateHostProcessLock({ ...lock, pid: 0 }).length > 0);
  assert.ok(validateHostDiagnosticLine({ ...line, level: "trace" }).length > 0);
});

test("host process lock reducer enforces acquire and matching release", () => {
  const lock = { pid: 42, token: "lock-token", acquiredAt: "2026-11-08T00:00:00.000Z" },
    released = { status: "released" } as const,
    held = reduceHostProcessLock(released, { type: "acquired", lock });
  assert.deepEqual(held, { status: "held", lock });
  assert.throws(() => reduceHostProcessLock(held, { type: "acquired", lock }), /already held/u);
  assert.throws(() => reduceHostProcessLock(held, { type: "released", token: "other" }), /does not match/u);
  assert.deepEqual(reduceHostProcessLock(held, { type: "released", token: lock.token }), released);
});

test("host process lock helper acquires before work and releases after success or failure", () => {
  const lock = { pid: 42, token: "lock-token", acquiredAt: "2026-11-08T00:00:00.000Z" },
    calls: string[] = [],
    port = {
      acquire: () => void calls.push("acquire"),
      release: () => void calls.push("release"),
    };
  assert.equal(
    withHostProcessLock(lock, port, () => (calls.push("work"), "done")),
    "done",
  );
  assert.deepEqual(calls, ["acquire", "work", "release"]);

  calls.length = 0;
  assert.throws(
    () =>
      withHostProcessLock(lock, port, () => {
        calls.push("work");
        throw new Error("operation failed");
      }),
    /operation failed/u,
  );
  assert.deepEqual(calls, ["acquire", "work", "release"]);
});

test("host diagnostic append helper keeps prior lines and does not mutate its input", () => {
  const previous = Object.freeze([
      { at: "2026-11-08T00:00:00.000Z", level: "info" as const, source: "worker", message: "started" },
    ]),
    next = { at: "2026-11-08T00:00:01.000Z", level: "warn" as const, source: "worker", message: "slow" },
    appended = appendHostDiagnostic(previous, next);
  assert.deepEqual(appended, [...previous, next]);
  assert.equal(previous.length, 1);
  assert.equal(Object.isFrozen(appended), true);
});
