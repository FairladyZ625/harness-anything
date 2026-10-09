// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runDocAction } from "../src/doc-sync-actions.ts";
import {
  isFleetTaskAction,
  FLEET_CHUNK_BYTES,
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
} from "../src/fleet/contract.ts";

test("several bounded evidence frames share a transport chunk while an oversized evidence frame is rejected", () => {
  const frame = {
    schema: "fleet.task.evidence/v1" as const,
    messageId: "part-one",
    inReplyTo: "read-one",
    dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES, 97).toString("base64"),
  };
  const decoder = new FleetUtf8LineDecoder();
  const lines = decoder.push(
    Buffer.from(serializeFleetFrame(frame) + serializeFleetFrame({ ...frame, messageId: "part-two" })),
  );
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => parseFleetFrame(line).schema),
    ["fleet.task.evidence/v1", "fleet.task.evidence/v1"],
  );
  decoder.finish();
  assert.throws(
    () => parseFleetFrame({ ...frame, dataBase64: Buffer.alloc(FLEET_CHUNK_BYTES + 1).toString("base64") }),
    /closed schema/,
  );
});

test("Fleet accepts the declared doc-show fields for center-owned frozen reads", () => {
  assert.equal(isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md", raw: true }), true);
  assert.equal(isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md" }), true);
  assert.equal(
    isFleetTaskAction({ kind: "doc-show", path: "tasks/task-one/artifacts/report.md", revision: 99 }),
    false,
  );
  assert.equal(isFleetTaskAction({ kind: "doc-show" }), false);
  assert.equal(isFleetTaskAction({ kind: "doc-show", path: "report.md", raw: "true" }), false);
});

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("reviewer doc-show returns complete frozen text and binary bytes without reading workspace or live documents", () => {
  const packagePath = "tasks/task-one",
    text = Buffer.from(`HEAD\n${"evidence\n".repeat(40000)}TAIL\n`),
    binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]),
    bodies = new Map([
      [`${packagePath}/artifacts/report.md`, text],
      [`${packagePath}/artifacts/image.png`, binary],
      [`${packagePath}/artifacts/empty.md`, Buffer.alloc(0)],
    ]),
    artifacts = [...bodies].map(([path, bytes]) => ({ path, revision: 7, blobSha256: digest(bytes) })),
    input = {
      workspaceId: "repo-one",
      rootDir: "/unavailable-reviewer-workspace",
      now: () => new Date().toISOString(),
      binding: {
        actor: { principal: { personId: "reviewer" }, executor: null },
        source: "local" as const,
        executionPrincipal: {
          personId: "reviewer",
          repoId: "repo-one",
          runtimeSessionId: "runtime-one",
          dispatchId: "dispatch-one",
          taskId: "task-one",
          executionId: "execution-one",
          role: "reviewer" as const,
          source: "local" as const,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
      projection: {
        read: (taskId: string) => {
          assert.equal(taskId, "task-one");
          return {
            packagePath,
            snapshot: { executions: [{ executionId: "execution-one", submission: { artifacts } }] },
          };
        },
        readDocument: () => {
          throw new Error("live projection must not replace frozen content");
        },
      } as never,
      store: {
        readEventAtRevision: (revision: number) => {
          assert.equal(revision, 7);
          return {
            schema: "doc-event/v1",
            workspaceRevision: 7,
            opId: "accepted-seven",
            payload: {
              changes: artifacts.map((anchor) => ({ path: anchor.path, candidate: { sha256: anchor.blobSha256 } })),
            },
          };
        },
        readContentBlob: (blob: string) => [...bodies.values()].find((bytes) => digest(bytes) === blob),
      } as never,
    };
  for (const source of ["local", { kind: "node", nodeId: "edge-one" }] as const) {
    for (const [path, bytes] of bodies) {
      const receipt = runDocAction({
        ...input,
        binding: { ...input.binding, source },
        action: { kind: "doc-show", path, raw: true },
      });
      assert.ok(!(receipt instanceof Promise));
      assert.equal(receipt.outcome, "applied");
      assert.equal(receipt.revision, 7);
      assert.equal(receipt.evidence, bytes.toString(path.endsWith(".png") ? "base64" : "utf8"));
    }
  }
  for (const path of [
    "tasks/task-other/artifacts/report.md",
    `${packagePath}/artifacts/unregistered.md`,
    `${packagePath}/task_plan.md`,
    "context/readme.md",
  ])
    assert.throws(() => runDocAction({ ...input, action: { kind: "doc-show", path } }), {
      code: "execution_credential_rejected",
    });
  assert.throws(() => runDocAction({ ...input, action: { kind: "doc-show", path: "../report.md" } }), {
    code: "invalid_command",
  });
});
