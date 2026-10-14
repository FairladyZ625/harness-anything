// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseFleetFrame, serializeFleetFrame } from "../src/fleet/command-protocol.ts";

test("retired repository forward request and response schemas are rejected", () => {
  for (const schema of ["fleet.repository.read/v1", "fleet.repository.read.result/v1"])
    assert.throws(() => parseFleetFrame({ schema, messageId: "retired" }), /schema/);
});

test("task command authentication uses the UTF-8 byte bound", () => {
  const command = {
    schema: "fleet.task.command/v1",
    messageId: "command",
    writerEpoch: 1,
    opId: "command-op",
    repoId: "repo-a",
    taskId: null,
    action: { kind: "task-create", taskId: "task-a", title: "Created" },
    docChanges: null,
    mirrorBaseCut: null,
  };
  for (const accessToken of ["a".repeat(513), "a".repeat(2048), "a".repeat(16 * 1024), "é".repeat(8192)]) {
    for (const frame of [command]) {
      const authenticated = { ...frame, accessToken };
      assert.deepEqual(parseFleetFrame(authenticated), authenticated);
      assert.deepEqual(parseFleetFrame(JSON.parse(serializeFleetFrame(authenticated))), authenticated);
    }
  }
  for (const accessToken of ["", "a".repeat(16 * 1024 + 1), "é".repeat(8192) + "a", 513, {}]) {
    for (const frame of [command]) assert.throws(() => parseFleetFrame({ ...frame, accessToken }), /closed schema/);
  }
  assert.throws(() => parseFleetFrame({ ...command, repoId: "a".repeat(513) }), /closed schema/);
  assert.throws(
    () => parseFleetFrame({ ...command, accessToken: "a".repeat(2048), personId: "other" }),
    /closed schema/,
  );
  assert.throws(() => parseFleetFrame({ ...command, accessToken: "\u0001".repeat(16 * 1024) }), /exceeds 98304 bytes/);
});

// The old snapshot-chunk transport sharing case retired with the fleet.snapshot.* frame family;
// the equivalent chunk-bound proof for the replication stream lives in
// replication-protocol.contract.test.ts ("decoder accepts many frames per chunk ...").
