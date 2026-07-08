import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { makeFactWriteService, makeHumanFallbackSessionProbe } from "../src/index.ts";
import { formatFactFlowRecord, parseEntityRef, type FactRecord, type WriteCoordinator, type WriteOp } from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";

test("fact write service invalidates through a relation op without rewriting fact records", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-write-"));
  const enqueued: WriteOp[] = [];
  try {
    writeFacts(rootDir, "task_fact_owner", [
      fact("F-DEADBEEF", "Old observation."),
      fact("F-FEEDFACE", "New observation invalidates the old one.")
    ]);
    const service = makeFactWriteService({
      rootInput: rootDir,
      coordinator: fakeCoordinator(enqueued)
    });

    const result = await runEffect(service.invalidate({
      ownerTaskId: "task_fact_owner",
      factId: "F-DEADBEEF",
      invalidatedByFactId: "F-FEEDFACE",
      rationale: "The new observation disproves the old one.",
      opIdPrefix: "invalidate"
    }));

    assert.equal(result.ref, "fact/task_fact_owner/F-DEADBEEF");
    assert.equal(enqueued[0]?.kind, "fact_invalidate");
    assert.equal(enqueued[0]?.entityId, "task/task_fact_owner");
    const payload = enqueued[0]?.payload as {
      readonly path?: string;
      readonly appendRecord?: { readonly kind?: string; readonly relation?: { readonly target?: string; readonly type?: string } };
    };
    assert.equal(payload.path, "facts.md");
    assert.equal(payload.appendRecord?.kind, "fact-relation/v1");
    assert.equal(payload.appendRecord?.relation?.type, "supersedes-fact");
    assert.equal(payload.appendRecord?.relation?.target, "fact/task_fact_owner/F-DEADBEEF");
    assert.equal(parseEntityRef(`fact/task_fact_owner/${result.invalidatedByFactId}`)?.kind, "fact");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fact write service records facts as append deltas", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-write-"));
  const enqueued: WriteOp[] = [];
  try {
    const service = makeFactWriteService({
      rootInput: rootDir,
      coordinator: fakeCoordinator(enqueued),
      currentSessionProbe: makeHumanFallbackSessionProbe({
        now: () => "2026-07-04T00:00:00.000Z",
        user: () => "zeyu"
      }),
      now: () => "2026-07-04T00:00:00.000Z"
    });

    const result = await runEffect(service.record({
      ownerTaskId: "task_fact_owner",
      factId: "F-FEEDFACE",
      statement: "New observation.",
      source: "test",
      confidence: "high"
    }));

    assert.equal(result.factId, "F-FEEDFACE");
    assert.equal(enqueued[0]?.kind, "doc_write");
    const payload = enqueued[0]?.payload as {
      readonly path?: string;
      readonly appendRecord?: { readonly kind?: string; readonly record?: { readonly fact_id?: string } };
    };
    assert.equal(payload.path, "facts.md");
    assert.equal(payload.appendRecord?.kind, "fact-record/v1");
    assert.equal(payload.appendRecord?.record?.fact_id, "F-FEEDFACE");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function fakeCoordinator(enqueued: WriteOp[]): WriteCoordinator {
  return {
    enqueue: (op) => Effect.sync(() => {
      enqueued.push(op);
      return { opId: op.opId, entityId: op.entityId, accepted: true };
    }),
    flush: () => Effect.succeed({ reason: "explicit", opCount: enqueued.length, committed: true }),
    recover: Effect.succeed({ replayedOps: 0 })
  };
}

function writeFacts(rootDir: string, taskId: string, facts: ReadonlyArray<FactRecord>): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "facts.md"), [
    "# Facts",
    "",
    ...facts.map(formatFactFlowRecord),
    ""
  ].join("\n"));
}

function fact(factId: string, statement: string): FactRecord {
  return {
    fact_id: factId,
    statement,
    source: "test",
    observedAt: "2026-07-04T00:00:00.000Z",
    confidence: "high",
    memoryClass: "episodic",
    memoryTags: [],
    provenance: [{
      runtime: "human",
      sessionId: "session-1",
      boundAt: "2026-07-04T00:00:00.000Z"
    }]
  };
}
