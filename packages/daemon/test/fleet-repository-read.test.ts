// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFleetFrame,
  FleetUtf8LineDecoder,
  serializeFleetFrame,
  FLEET_CHUNK_BYTES,
} from "../src/fleet/contract.ts";

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

test("several full snapshot frames may share a transport chunk without exceeding the pending remainder bound", () => {
  const frame = {
    schema: "fleet.snapshot.chunk/v1",
    messageId: "part",
    transferId: "transfer",
    blobSha256: "a".repeat(64),
    offset: 0,
    dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES, 97).toString("base64"),
  };
  const first = serializeFleetFrame(frame),
    last = serializeFleetFrame({ ...frame, messageId: "last", offset: FLEET_CHUNK_BYTES }),
    reader = new FleetUtf8LineDecoder();
  assert.equal(reader.push(Buffer.from(first + last)).length, 2);
  reader.finish();
  assert.throws(
    () => parseFleetFrame({ ...frame, dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES + 1).toString("base64") }),
    /closed schema/,
  );
});
