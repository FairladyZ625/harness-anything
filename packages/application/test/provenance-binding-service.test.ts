// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { bindCreateProvenance, makeDecisionWriteService, makeFactWriteService, makeHumanFallbackSessionProbe, makeProvenanceSessionExporter, type DecisionCreateInput, type ProvenanceSessionExporter, type ProvenanceSessionExporterRejected } from "../src/index.ts";
import { makeJournaledWriteCoordinator, makeMarkdownArtifactStore, type DecisionPackage, type WriteAttribution, type WriteCoordinator, type WriteError, type WriteOp } from "../../kernel/src/index.ts";
import { runEffect } from "./effect-test-helpers.ts";

const testAttribution = {
  actor: { principal: { kind: "person", personId: "person_test" }, executor: { kind: "agent", id: "test" } },
  principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" },
  executorSource: "client-asserted"
} as const satisfies WriteAttribution;

test("decision create service binds provenance and exports the session by id", async () => {
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
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution }),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      now: () => "2026-07-03T00:02:00.000Z"
    });
    const syncedPaths: string[] = [];
    const service = makeDecisionWriteService({
      coordinator: fakeCoordinator(enqueued),
      currentSessionProbe: probe,
      provenanceSessionExporter: exporter,
      syncExportedSession: (result) => Effect.sync(() => {
        syncedPaths.push(result.path);
      }),
      now: () => "2026-07-03T00:01:00.000Z"
    });

    await runEffect(service.propose({ decision: decisionCreateInput() }));

    const decision = (enqueued[0]?.payload as { readonly decision?: DecisionPackage }).decision;
    assert.deepEqual(decision?.provenance, [{
      runtime: "human",
      sessionId: "human-cli-1783036800000",
      boundAt: "2026-07-03T00:01:00.000Z"
    }]);
    const session = await runEffect(exporter.readById("human-cli-1783036800000"));
    assert.equal(session.path, "sessions/human-cli-1783036800000.md");
    assert.equal(session.session.runtime, "human");
    assert.deepEqual(syncedPaths, ["sessions/human-cli-1783036800000.md"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fact create service binds provenance into the single-line record and exports the session by id", async () => {
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
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution }),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      now: () => "2026-07-03T00:02:00.000Z"
    });
    const syncedPaths: string[] = [];
    const service = makeFactWriteService({
      rootInput: rootDir,
      coordinator: fakeCoordinator(enqueued),
      currentSessionProbe: probe,
      provenanceSessionExporter: exporter,
      syncExportedSession: (result) => Effect.sync(() => {
        syncedPaths.push(result.path);
      }),
      now: () => "2026-07-03T00:01:00.000Z"
    });

    await runEffect(service.record({
      ownerTaskId: "task_OWNER",
      factId: "F-DEADBEEF",
      statement: "Fact create binds provenance.",
      source: "service test",
      confidence: "high"
    }));

    const record = (enqueued[0]?.payload as {
      readonly appendRecord?: { readonly record?: { readonly memoryClass?: string; readonly memoryTags?: ReadonlyArray<string>; readonly provenance?: unknown } };
    }).appendRecord?.record;
    assert.equal(record?.memoryClass, "episodic");
    assert.deepEqual(record?.memoryTags, []);
    assert.deepEqual(record?.provenance, [{
      runtime: "human",
      sessionId: "human-cli-1783036800000",
      boundAt: "2026-07-03T00:01:00.000Z"
    }]);
    const session = await runEffect(exporter.readById("human-cli-1783036800000"));
    assert.equal(session.path, "sessions/human-cli-1783036800000.md");
    assert.equal(session.session.runtime, "human");
    assert.deepEqual(syncedPaths, ["sessions/human-cli-1783036800000.md"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("decision and fact provenance binding preserve the underlying structured write rejection", async () => {
  const rootDir = createHarnessRoot();
  const writeError = {
    _tag: "WriteRejected",
    code: "authored_root_not_isolated",
    reason: "authored root is not isolated",
    retryable: false
  } as const satisfies WriteError;
  const exporterError = {
    _tag: "ProvenanceSessionExporterRejected",
    sessionId: "human-test",
    code: "write_failed",
    reason: writeError.reason,
    writeError
  } as const;
  const exporter = failingExporter(exporterError);
  const currentSessionProbe = makeHumanFallbackSessionProbe();
  try {
    const decision = makeDecisionWriteService({
      coordinator: fakeCoordinator([]),
      currentSessionProbe,
      provenanceSessionExporter: exporter
    });
    const fact = makeFactWriteService({
      rootInput: rootDir,
      coordinator: fakeCoordinator([]),
      currentSessionProbe,
      provenanceSessionExporter: exporter
    });

    const decisionResult = await runEffect(Effect.either(decision.propose({ decision: decisionCreateInput() })));
    const factResult = await runEffect(Effect.either(fact.record({
      ownerTaskId: "task_OWNER",
      factId: "F-DEADBEEF",
      statement: "Structured write failures survive provenance binding.",
      source: "service test",
      confidence: "high"
    })));

    assert.equal(decisionResult._tag, "Left");
    assert.equal(factResult._tag, "Left");
    if (decisionResult._tag === "Left") assert.equal(decisionResult.left, writeError);
    if (factResult._tag === "Left") assert.equal(factResult.left, writeError);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("provenance binding keeps the session pointer when the transcript exceeds the admission limit", async () => {
  const currentSessionProbe = makeHumanFallbackSessionProbe({
    now: () => "2026-07-03T00:00:00.000Z"
  });
  const oversized = {
    _tag: "ProvenanceSessionExporterRejected",
    sessionId: "human-cli-1783036800000",
    code: "write_failed",
    reason: "Shared daemon admission payload exceeds the per-request limit",
    writeError: {
      _tag: "WriteRejected",
      code: "admission_payload_exceeds_limit",
      reason: "Shared daemon admission payload exceeds the per-request limit",
      retryable: false
    }
  } as const satisfies ProvenanceSessionExporterRejected;

  const provenance = await runEffect(bindCreateProvenance({
    currentSessionProbe,
    provenanceSessionExporter: failingExporter(oversized)
  }, "2026-07-03T00:01:00.000Z"));

  // An optional capture too large for this daemon must not fail the write it rode along with.
  assert.deepEqual(provenance, {
    runtime: "human",
    sessionId: "human-cli-1783036800000",
    boundAt: "2026-07-03T00:01:00.000Z"
  });
});

test("automatic provenance binding keeps the session pointer when transcript availability is indeterminate", async () => {
  const rootDir = createHarnessRoot();
  try {
    const session = {
      runtime: "codex",
      sessionId: "unconfigured-runtime-root-session",
      source: "runtime",
      detectedAt: "2026-07-03T00:00:00.000Z"
    } as const;
    const currentSessionProbe = { currentSession: Effect.succeed(session) };
    const provenanceSessionExporter = makeProvenanceSessionExporter({
      rootInput: rootDir,
      currentSessionProbe,
      coordinator: makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution }),
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      runtimeLogRoots: { codex: [path.join(rootDir, "nonexistent-runtime-root")] }
    });

    const provenance = await runEffect(bindCreateProvenance({
      currentSessionProbe,
      provenanceSessionExporter
    }, "2026-07-03T00:01:00.000Z"));

    assert.deepEqual(provenance, {
      runtime: "codex",
      sessionId: session.sessionId,
      boundAt: "2026-07-03T00:01:00.000Z"
    });
    assert.equal(existsSync(path.join(rootDir, "harness", "sessions", `${session.sessionId}.md`)), false);
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

function failingExporter(error: ProvenanceSessionExporterRejected): ProvenanceSessionExporter {
  const fail = () => Effect.fail(error);
  return {
    exportSession: fail,
    exportCurrentSession: fail,
    backfillRuntimeSessions: fail,
    readById: fail
  } as ProvenanceSessionExporter;
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
