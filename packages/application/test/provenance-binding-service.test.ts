import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDecisionWriteService, makeFactWriteService, makeHumanFallbackSessionProbe, makeProvenanceSessionExporter, type DecisionCreateInput } from "../src/index.ts";
import type { DecisionPackage, WriteCoordinator, WriteOp } from "../../kernel/src/index.ts";

test("decision create service binds provenance and exports the session by id", () => {
  const rootDir = createHarnessRoot();
  try {
    const enqueued: WriteOp[] = [];
    const probe = makeHumanFallbackSessionProbe({
      now: () => "2026-07-03T00:00:00.000Z",
      user: () => "zeyu"
    });
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: probe,
      now: () => "2026-07-03T00:02:00.000Z"
    });
    const service = makeDecisionWriteService({
      coordinator: fakeCoordinator(enqueued),
      currentSessionProbe: probe,
      provenanceSessionExporter: exporter,
      now: () => "2026-07-03T00:01:00.000Z"
    });

    Effect.runSync(service.propose({ decision: decisionCreateInput() }));

    const decision = (enqueued[0]?.payload as { readonly decision?: DecisionPackage }).decision;
    assert.deepEqual(decision?.provenance, [{
      runtime: "human",
      sessionId: "human-cli-1783036800000",
      boundAt: "2026-07-03T00:01:00.000Z"
    }]);
    const session = Effect.runSync(exporter.readById("human-cli-1783036800000"));
    assert.equal(session.path, "sessions/human-cli-1783036800000.md");
    assert.equal(session.session.runtime, "human");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fact create service binds provenance into the single-line record and exports the session by id", () => {
  const rootDir = createHarnessRoot();
  try {
    const enqueued: WriteOp[] = [];
    const probe = makeHumanFallbackSessionProbe({
      now: () => "2026-07-03T00:00:00.000Z",
      user: () => "zeyu"
    });
    const exporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe: probe,
      now: () => "2026-07-03T00:02:00.000Z"
    });
    const service = makeFactWriteService({
      rootInput: rootDir,
      coordinator: fakeCoordinator(enqueued),
      currentSessionProbe: probe,
      provenanceSessionExporter: exporter,
      now: () => "2026-07-03T00:01:00.000Z"
    });

    Effect.runSync(service.record({
      ownerTaskId: "task_OWNER",
      factId: "F-DEADBEEF",
      statement: "Fact create binds provenance.",
      source: "service test",
      confidence: "high"
    }));

    const body = (enqueued[0]?.payload as { readonly body?: string }).body ?? "";
    assert.match(body, /provenance: \[\{runtime: "human", sessionId: "human-cli-1783036800000", boundAt: "2026-07-03T00:01:00\.000Z"\}\]/u);
    const session = Effect.runSync(exporter.readById("human-cli-1783036800000"));
    assert.equal(session.path, "sessions/human-cli-1783036800000.md");
    assert.equal(session.session.runtime, "human");
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

function decisionCreateInput(): DecisionCreateInput {
  return {
    schema: "decision-package/v1",
    decision_id: "dec_PROVENANCE",
    title: "Provenance binding",
    state: "proposed",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "architecture-decision",
    applies_to: {
      modules: ["kernel"],
      productLines: []
    },
    proposedBy: { kind: "agent", id: "writer" },
    proposedAt: "2026-07-03T00:00:00.000Z",
    arbiter: { kind: "human", id: "ZeyuLi" },
    question: "Should create bind provenance?",
    chosen: [{ id: "CH1", text: "Bind it in the service." }],
    rejected: [{ id: "RJ1", text: "Require callers to pass it.", why_not: "Create paths need a uniform provenance boundary." }],
    claims: [{ id: "C1", text: "The service sees the current session." }],
    relations: []
  };
}

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-provenance-binding-"));
  mkdirSync(path.join(rootDir, "harness", "tasks", "task_OWNER"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}
