// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonOperationTable, readDaemonOperationTable } from "../src/daemon-operation-table.ts";

test("shared in-flight table publishes begins, updates and ends without messages", () => {
  const table = createDaemonOperationTable(2),
    reader = readDaemonOperationTable(table.buffer),
    first = table.begin({ method: "fixture.request", repoId: "repo-a", actor: "node-a", phase: "authentication" }),
    second = table.begin({ method: "fixture.backup" });
  try {
    assert.equal(table.activeCount, 2);
    const initial = reader.snapshot();
    assert.equal(initial.length, 2);
    assert.deepEqual(
      initial.map(({ method, repoId, actor, phase }) => ({ method, repoId, actor, phase })),
      [
        { method: "fixture.request", repoId: "repo-a", actor: "node-a", phase: "authentication" },
        { method: "fixture.backup", repoId: null, actor: null, phase: "started" },
      ],
    );
    for (const operation of initial) {
      assert.match(operation.id, /^\d+$/u);
      assert.equal(typeof operation.startedAt, "string");
    }
    first.update({ phase: "projection-read", actor: "node-b" });
    assert.deepEqual(
      reader.snapshot().map(({ method, actor, phase }) => ({ method, actor, phase })),
      [
        { method: "fixture.request", actor: "node-b", phase: "projection-read" },
        { method: "fixture.backup", actor: null, phase: "started" },
      ],
    );
    first.end();
    assert.equal(table.activeCount, 1);
    assert.deepEqual(
      reader.snapshot().map((operation) => operation.method),
      ["fixture.backup"],
    );
  } finally {
    first.end();
    second.end();
  }
  assert.equal(table.activeCount, 0);
  assert.deepEqual(reader.snapshot(), []);
});

test("a reused slot never exposes the previous operation", () => {
  const table = createDaemonOperationTable(1),
    reader = readDaemonOperationTable(table.buffer),
    first = table.begin({ method: "first", phase: "one" });
  first.end();
  const second = table.begin({ method: "second", phase: "two" });
  try {
    assert.deepEqual(
      reader.snapshot().map(({ method, phase }) => ({ method, phase })),
      [{ method: "second", phase: "two" }],
    );
  } finally {
    second.end();
  }
});

test("table capacity is a bounded, counted limit instead of silent corruption", () => {
  const table = createDaemonOperationTable(1),
    reader = readDaemonOperationTable(table.buffer),
    only = table.begin({ method: "only" }),
    overflow = table.begin({ method: "overflow" });
  try {
    assert.equal(table.activeCount, 1);
    assert.equal(table.overflowCount, 1);
    assert.equal(reader.overflowCount, 1);
    assert.deepEqual(
      reader.snapshot().map((operation) => operation.method),
      ["only"],
    );
  } finally {
    overflow.end();
    only.end();
  }
  assert.equal(table.activeCount, 0);
});
