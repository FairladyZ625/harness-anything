// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  REPLAY_TASK_GRAPH,
  checkTaskProjection,
  compileDecisionWrite,
  compileFactWrite,
  decisionWritePlan,
  deriveRelationId,
  formatRelationFlowRecord,
  makeTaskProjection,
  projectDecisionReadiness,
  readRelationGraphProjection,
  rebuildTaskProjection,
  renderDecisionDocument,
  serializeCanonicalEvent,
  sha256Text,
  taskLifecycleWritePlan,
  type DecisionEventDraftV1,
  type EntityRelationRecord,
  type FactEventDraftV1,
  type MigrationImportEventV1,
  type TaskEventV1,
} from "../../src/index.ts";
import {
  createDecisionProjectionTables,
  readDecisionDocumentState,
  reduceDecisionEvent,
} from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { withTempStore } from "./helpers.ts";

import {
  accepted,
  actor,
  applyDecision,
  applyFact,
  claim,
  compileCurrent,
  decisionProjectionDatabase,
  fact,
  git,
  migrationFactEvent,
  migrationRelationEvent,
  projectionFixture,
  proposal,
  related,
  relation,
  seedRelationProjection,
  taskCreated,
  testReadinessSource,
  writeColdHistory,
  writeFactEvent,
  writeMigrationEvent,
  writeTask,
} from "./relation-graph-projection.fixtures.ts";
test("post-merge continues to consume event-backed Decision/Fact truth", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir);
    applyDecision(fixture, proposal(1, "dec_GRAPH"));
    applyFact(fixture, fact(2));
    const edge = relation({
      source: "decision/dec_GRAPH/C1",
      target: "fact/task-evidence/F-DEADBEEF",
      type: "evidenced-by",
    });
    applyDecision(fixture, claim(3, "dec_GRAPH"));
    applyDecision(fixture, related(4, "dec_GRAPH", edge));
    assert.equal(
      checkTaskProjection({
        rootDir,
        postMerge: true,
        eventRelationTruth: fixture.projection.readRelationTruth(),
      }).ok,
      true,
    );
  });
});

test("post-merge fails closed without identity-bound event relation truth", () => {
  withTempStore((rootDir) => {
    const result = checkTaskProjection({ rootDir, postMerge: true });
    assert.equal(result.ok, false);
    assert.equal(
      result.warnings.some(
        ({ code, message }) =>
          code === "relation_truth_unavailable" &&
          message.includes("identity-bound"),
      ),
      true,
    );
  });
});

test("Decision readiness is commit-bound and ignores uncommitted worktree guesses", () => {
  withTempStore((rootDir) => {
    git(rootDir, "init");
    git(rootDir, "config", "user.name", "Fixture");
    git(rootDir, "config", "user.email", "fixture@example.test");
    mkdirSync(path.join(rootDir, "packages/kernel"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "packages/kernel/index.ts"),
      "export const ready = true;\n",
    );
    git(rootDir, "add", ".");
    git(rootDir, "commit", "-m", "base", {
      GIT_AUTHOR_DATE: "2026-08-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T00:00:00Z",
    });
    const base = git(rootDir, "rev-parse", "HEAD"),
      decision = {
        decisionId: "dec_READY",
        proposedAt: "2026-08-02T00:00:00.000Z",
        appliesTo: { modules: ["kernel"], productLines: [] },
      };
    const source = testReadinessSource();
    let readiness = projectDecisionReadiness(
      { rootDir, commitSha: base, decisions: [decision] },
      source,
    )[0]!;
    assert.equal(readiness.appliesToDrift.state, "clear");
    assert.equal(readiness.conflictMarker.state, "clear");
    writeFileSync(
      path.join(rootDir, "packages/kernel/index.ts"),
      "<<<<<<< local\n=======\n>>>>>>> remote\n",
    );
    readiness = projectDecisionReadiness(
      { rootDir, commitSha: base, decisions: [decision] },
      source,
    )[0]!;
    assert.equal(
      readiness.conflictMarker.state,
      "clear",
      "uncommitted worktree markers are not canonical truth",
    );
    git(rootDir, "add", ".");
    git(rootDir, "commit", "-m", "canonical conflict", {
      GIT_AUTHOR_DATE: "2026-08-03T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-03T00:00:00Z",
    });
    const head = git(rootDir, "rev-parse", "HEAD");
    readiness = projectDecisionReadiness(
      { rootDir, commitSha: head, decisions: [decision] },
      source,
    )[0]!;
    assert.equal(readiness.appliesToDrift.state, "drift");
    assert.deepEqual(readiness.appliesToDrift.paths, [
      "packages/kernel/index.ts",
    ]);
    assert.equal(readiness.conflictMarker.state, "conflict");
    assert.deepEqual(readiness.conflictMarker.paths, [
      "packages/kernel/index.ts",
    ]);
    const unknown = projectDecisionReadiness(
      {
        rootDir,
        commitSha: head,
        decisions: [
          {
            ...decision,
            appliesTo: { modules: ["missing-module"], productLines: [] },
          },
        ],
      },
      source,
    )[0]!;
    assert.equal(unknown.appliesToDrift.state, "unknown");
    assert.equal(unknown.conflictMarker.state, "unknown");
  });
});

test("Decision readiness batches canonical Git reads across the ledger", () => {
  const calls: string[][] = [];
  const source = {
      run: (_rootDir: string, args: readonly string[]) => {
        calls.push([...args]);
        return {
          ok: true,
          stdout: args[0] === "ls-tree" ? "packages/kernel/index.ts" : "",
        };
      },
    },
    count = 570;
  const decisions = Array.from({ length: count }, (_, index) => ({
    decisionId: `dec_SCALE_${index}`,
    proposedAt: new Date(Date.UTC(2026, 7, 1) + index * 1_000).toISOString(),
    appliesTo: { modules: ["kernel"], productLines: [] },
  }));
  const readiness = projectDecisionReadiness(
    { rootDir: "/fixture", commitSha: "a".repeat(40), decisions },
    source,
  );
  assert.equal(readiness.length, count);
  assert.equal(
    readiness.every(
      (row) =>
        row.appliesToDrift.state === "clear" &&
        row.conflictMarker.state === "clear",
    ),
    true,
  );
  assert.equal(
    calls.length,
    3,
    `readiness opened ${calls.length} Git processes for ${count} decisions sharing one canonical scope`,
  );
});

test("real post-merge cycle check includes canonical Decision edges and task-authored edges", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      projection = fixture.projection,
      created = taskCreated(1, "task-cycle");
    projection.apply(created, taskLifecycleWritePlan(created));
    applyDecision(fixture, proposal(2, "dec_CYCLE"));
    const derives = relation({
      source: "decision/dec_CYCLE",
      target: "task/task-cycle",
      type: "derives",
    });
    applyDecision(fixture, related(3, "dec_CYCLE", derives));
    writeTask(
      rootDir,
      "task-cycle",
      relation({
        source: "task/task-cycle",
        target: "decision/dec_CYCLE",
        type: "implements",
      }),
    );
    const result = checkTaskProjection({
      rootDir,
      postMerge: true,
      eventRelationTruth: projection.readRelationTruth(),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.warnings.some(({ code }) => code === "relation_cycle_detected"),
      true,
    );
  });
});

test("Replay accepts a document today's renderer no longer reproduces, as long as its content hash matches the signed claim", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      draft = proposal(1, "dec_LEGACY_RENDER"),
      compiled = compileDecisionWrite({
        event: draft,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      });
    // Stand in for a document written by an older renderer: strip a frontmatter line today's renderer always emits.
    const legacyBody = compiled.body.replace(/^provenance: .*\n/mu, "");
    assert.notEqual(
      legacyBody,
      compiled.body,
      "fixture must actually differ from what the current renderer produces",
    );
    const legacySha = sha256Text(legacyBody),
      legacySize = Buffer.byteLength(legacyBody, "utf8");
    const event = {
      ...compiled.event,
      payload: {
        ...compiled.event.payload,
        decisionDocumentClaim: {
          ...compiled.event.payload.decisionDocumentClaim,
          sha256: legacySha,
          size: legacySize,
        },
      },
    };
    fixture.blobs.set(legacySha, Buffer.from(legacyBody, "utf8"));
    fixture.projection.apply(event, decisionWritePlan(event));
    assert.equal(
      fixture.projection.readDecision("dec_LEGACY_RENDER").decision?.decisionId,
      "dec_LEGACY_RENDER",
      "a historical document must replay even though the renderer has since evolved",
    );
  });
});

test("Decision projection requires exact plan, content hash, consent pin, and document base", () => {
  withTempStore((rootDir) => {
    const fixture = projectionFixture(rootDir),
      draft = proposal(1, "dec_EXACT"),
      compiled = compileDecisionWrite({
        event: draft,
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      }),
      forgedSha = "0".repeat(64),
      forged = {
        ...compiled.event,
        payload: {
          ...compiled.event.payload,
          decisionDocumentClaim: {
            ...compiled.event.payload.decisionDocumentClaim,
            sha256: forgedSha,
          },
        },
      };
    fixture.blobs.set(forgedSha, Buffer.from(compiled.body));
    assert.throws(
      () => fixture.projection.apply(compiled.event),
      /write plan/u,
    );
    assert.throws(
      () => fixture.projection.apply(forged, decisionWritePlan(forged)),
      /projection mismatch/u,
    );
    assert.equal(fixture.projection.readDecision("dec_EXACT").decision, null);
    applyDecision(fixture, draft);
    const next = compileCurrent(fixture, accepted(2, "dec_EXACT")),
      tampered = {
        ...next.event,
        payload: {
          ...next.event.payload,
          judgmentConsent: {
            ...next.event.payload.judgmentConsent,
            machineDigest: `sha256:${"0".repeat(64)}` as const,
          },
        },
      },
      stale = {
        ...next.event,
        payload: { ...next.event.payload, baseDocumentSha256: "0".repeat(64) },
      };
    fixture.blobs.set(next.blobs[0].sha256, Buffer.from(next.body));
    assert.throws(
      () => fixture.projection.apply(tampered, decisionWritePlan(tampered)),
      /machine content cut/u,
    );
    assert.throws(
      () => fixture.projection.apply(stale, decisionWritePlan(stale)),
      /base.*mismatch/u,
    );
    assert.equal(
      fixture.projection.readDecision("dec_EXACT").decision?.state,
      "proposed",
    );
  });
});

test("Decision projection preserves authored option and claim order across two-digit ids", () => {
  const draft = proposal(1, "dec_ORDER"),
    numbered = (prefix: string) =>
      Array.from({ length: 10 }, (_, index) => `${prefix}${index + 1}`),
    event: typeof draft = {
      ...draft,
      payload: {
        ...draft.payload,
        chosen: numbered("CH").map((id) => ({ id, text: `Chosen ${id}` })),
        rejected: numbered("RJ").map((id) => ({
          id,
          text: `Rejected ${id}`,
          whyNot: `Why not ${id}`,
        })),
        claims: numbered("C").map((id) => ({
          id,
          text: `Claim ${id}`,
          loadBearing: true,
        })),
      },
    },
    compiled = compileDecisionWrite({
      event,
      currentDecision: null,
      currentRelations: [],
      currentDocument: null,
    }),
    db = decisionProjectionDatabase();
  try {
    reduceDecisionEvent(db, compiled.event);
    const state = readDecisionDocumentState(db, event.decisionId);
    assert.ok(state);
    assert.deepEqual(
      state.chosen.map(({ id }) => id),
      numbered("CH"),
    );
    assert.deepEqual(
      state.rejected.map(({ id }) => id),
      numbered("RJ"),
    );
    assert.deepEqual(
      state.claims.map(({ id }) => id),
      numbered("C"),
    );
    assert.equal(
      renderDecisionDocument(state, null, event.payload.body),
      compiled.body,
    );
  } finally {
    db.close();
  }
});
