// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { taskEntityId } from "../../src/domain/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator accepts duplicate op ids idempotently", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const op = docWrite("op-1", "task-1", "progress.md", "first");

    assert.equal(Effect.runSync(coordinator.enqueue(op)).accepted, true);
    assert.equal(Effect.runSync(coordinator.enqueue(op)).accepted, true);

    const report = Effect.runSync(coordinator.flush("explicit"));
    assert.equal(report.opCount, 1);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/progress.md"), "utf8"), "first");
  });
});

test("WriteCoordinator rejects an op id reused with different attribution", () => {
  withTempStore((rootDir) => {
    const alice = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution({ kind: "human", id: "person_alice" }),
      rootDir
    });
    const bob = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution({ kind: "human", id: "person_bob" }),
      rootDir
    });
    const op = docWrite("op-attribution-collision", "task-1", "progress.md", "same payload");

    Effect.runSync(alice.enqueue(op));
    const result = Effect.runSync(Effect.either(bob.enqueue(op)));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "WriteRejected");
      assert.match(result.left.reason, /op id collision has divergent journal records/u);
    }
  });
});

test("WriteCoordinator attribution collision includes principal source evidence", () => {
  withTempStore((rootDir) => {
    const attribution = testWriteAttribution();
    const original = makeJournaledWriteCoordinator({ attribution, rootDir });
    const differentSource = makeJournaledWriteCoordinator({
      rootDir,
      attribution: {
        ...attribution,
        principalSource: {
          kind: "local-configured",
          authority: "harness.yaml",
          authoritySha256: "sha256:different-source"
        }
      }
    });
    const op = docWrite("op-source-collision", "task-1", "progress.md", "same payload");

    Effect.runSync(original.enqueue(op));
    const result = Effect.runSync(Effect.either(differentSource.enqueue(op)));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") assert.match(result.left.reason, /op id collision has divergent journal records/u);
  });
});

test("WriteCoordinator fails closed when request principal attribution is missing", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: undefined as never });
    const result = Effect.runSync(Effect.either(coordinator.enqueue(docWrite("op-no-attribution", "task-1", "progress.md", "blocked"))));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "WriteRejected");
      assert.equal(result.left.reason, "write coordinator requires valid principal attribution");
    }
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
  });
});

test("WriteCoordinator reports duplicate batch write conflicts on the conflicting write task", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(coordinator.enqueue({
      opId: "op-batch-duplicate",
      entityId: taskEntityId("task-batch"),
      kind: "package_supersede",
      payload: {
        writes: [
          { taskId: "task-conflict", path: "INDEX.md", body: "first" },
          { taskId: "task-conflict", path: "INDEX.md", body: "second" }
        ]
      }
    }));

    const result = Effect.runSync(Effect.either(coordinator.flush("explicit")));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.deepEqual(result.left, {
        _tag: "WriteRejected",
        taskId: "task-conflict",
        entityId: "task/task-conflict",
        reason: "duplicate batch write target: INDEX.md"
      });
    }
  });
});

test("WriteCoordinator retains the underlying journal read failure", () => {
  withTempStore((rootDir) => {
    const journalDir = path.join(rootDir, ".harness/write-journal");
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, "writes.jsonl"), "{\"schema\":\"write-journal/v1\"}\n", "utf8");

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const result = Effect.runSync(Effect.either(coordinator.enqueue(docWrite("op-malformed-journal", "task-cause", "progress.md", "entry"))));

    assert.equal(result._tag, "Left");
    if (result._tag === "Left") {
      assert.equal(result.left._tag, "JournalUnavailable");
      const cause = result.left.cause as { readonly name: string; readonly message: string };
      assert.equal(typeof cause.message, "string");
      assert.match(cause.message, /malformed journal record: schema decode failed/);
    }
  });
});
