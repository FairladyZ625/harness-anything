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
    { ...frame, method: "repo.projection.read", payload: { name: "runtime-session-groups" } },
    { ...frame, payload: { personId: "person-other" } },
    { ...frame, payload: { repoId: "repo-b" } },
    { ...frame, method: "repo.task.read", payload: { kind: "task-create", title: "no" } },
    { ...frame, method: "repo.task.read", payload: { kind: "task-show", taskId: "task_1", actor: {} } },
  ])
    assert.throws(() => parseFleetFrame(invalid), /closed schema/);
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
