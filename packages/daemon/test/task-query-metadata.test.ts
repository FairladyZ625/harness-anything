// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRoot } from "../src/protocol/daemon-protocol.contract.ts";
import { makeTaskQueryReadModel } from "../src/task-query-read.ts";
import { eventEdge, projectionStub, protocolTaskRow } from "./task-query-read.fixtures.ts";

test("task cards request decision metadata without the source document body", (t) => {
  const projection = projectionStub({ taskRows: [protocolTaskRow("task_event")], edges: [eventEdge] });
  const readDecisions = projection.readDecisions;
  let requests = 0;
  t.mock.method(projection, "readDecisions", (ids, withBody) => {
    assert.equal(withBody, false, "task listing must not request decision bodies");
    requests++;
    return readDecisions(ids, withBody);
  });
  const model = makeTaskQueryReadModel({
    rootDir: canonicalRoot(process.cwd()),
    projection,
    readPinnedEntities: () => [],
    judgments: {
      closeout: (() => ({ readiness: "missing", blocker: "execution", gates: [] })) as never,
      blocking: (() => []) as never,
    },
  });
  assert.equal(model.guiTasks({ limit: 1 }).rows.length, 1);
  assert.equal(requests, 1);
});
