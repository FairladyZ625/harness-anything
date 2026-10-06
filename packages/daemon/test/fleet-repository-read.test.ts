// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFleetFrame,
  FleetUtf8LineDecoder,
  serializeFleetFrame,
  FLEET_CHUNK_BYTES,
} from "../src/fleet/contract.ts";

test("repository reads accept declared queries and reject writes, unmarked methods, and authority fields", () => {
  const frame = {
    schema: "fleet.repository.read/v1",
    messageId: "read",
    repoId: "repo-a",
    accessToken: null,
    method: "repo.tasks.list",
    payload: { limit: 500, cursor: "task_50" },
  };
  assert.deepEqual(parseFleetFrame(frame), frame);
  for (const invalid of [
    { ...frame, method: "repo.task.run" },
    { ...frame, method: "repo.terminal.sessions.list" },
    { ...frame, method: "repo.projection.read", payload: { name: "schedule-plane" } },
    { ...frame, method: "repo.projection.read", payload: { name: "runtime-session-groups", repoId: "repo-b" } },
    { ...frame, method: "repo.projection.read", payload: { name: "runtime-session-groups", sessionIds: "bad" } },
    { ...frame, payload: { personId: "person-other" } },
    { ...frame, payload: { repoId: "repo-b" } },
    { ...frame, method: "repo.task.read", payload: { kind: "task-create", title: "no" } },
    { ...frame, method: "repo.task.read", payload: { kind: "task-show", taskId: "task_1", actor: {} } },
  ])
    assert.throws(() => parseFleetFrame(invalid), /closed schema/);
  assert.deepEqual(
    parseFleetFrame({
      ...frame,
      method: "repo.projection.read",
      payload: {
        name: "runtime-session-groups",
        groupBy: "agent",
        limit: 1,
        sessionIds: ["runtime-one", "runtime-two"],
      },
    }).payload,
    { name: "runtime-session-groups", groupBy: "agent", limit: 1, sessionIds: ["runtime-one", "runtime-two"] },
  );
});

test("repository read authentication uses the command token UTF-8 byte bound", () => {
  const read = {
    schema: "fleet.repository.read/v1",
    messageId: "read",
    repoId: "repo-a",
    accessToken: null,
    method: "repo.tasks.list",
    payload: {},
  };
  const command = {
    schema: "fleet.task.command/v1",
    messageId: "command",
    writerEpoch: 1,
    opId: "command-op",
    repoId: "repo-a",
    taskId: null,
    action: { kind: "work-list" },
    docChanges: null,
    mirrorBaseCut: null,
  };
  for (const accessToken of ["a".repeat(513), "a".repeat(2048), "a".repeat(16 * 1024), "é".repeat(8192)]) {
    for (const frame of [read, command]) {
      const authenticated = { ...frame, accessToken };
      assert.deepEqual(parseFleetFrame(authenticated), authenticated);
      assert.deepEqual(parseFleetFrame(JSON.parse(serializeFleetFrame(authenticated))), authenticated);
    }
  }
  for (const accessToken of ["", "a".repeat(16 * 1024 + 1), "é".repeat(8192) + "a", 513, {}]) {
    for (const frame of [read, command])
      assert.throws(() => parseFleetFrame({ ...frame, accessToken }), /closed schema/);
  }
  assert.deepEqual(parseFleetFrame(read), read);
  const { accessToken: _token, ...missing } = read;
  assert.throws(() => parseFleetFrame(missing), /closed schema/);
  assert.throws(() => parseFleetFrame({ ...read, repoId: "a".repeat(513) }), /closed schema/);
  assert.throws(() => parseFleetFrame({ ...read, accessToken: "a".repeat(2048), personId: "other" }), /closed schema/);
  assert.throws(() => parseFleetFrame({ ...read, accessToken: "\u0001".repeat(16 * 1024) }), /exceeds 98304 bytes/);
});

test("several full read-result frames may share a transport chunk without exceeding the pending remainder bound", () => {
  const frame = {
    schema: "fleet.repository.read.result/v1",
    messageId: "part",
    inReplyTo: "read",
    offset: 0,
    dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES, 97).toString("base64"),
    done: false,
  };
  const first = serializeFleetFrame(frame),
    last = serializeFleetFrame({ ...frame, messageId: "last", offset: FLEET_CHUNK_BYTES, done: true }),
    reader = new FleetUtf8LineDecoder();
  assert.equal(reader.push(Buffer.from(first + last)).length, 2);
  reader.finish();
  assert.throws(
    () => parseFleetFrame({ ...frame, dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES + 1).toString("base64") }),
    /closed schema/,
  );
});
