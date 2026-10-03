// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { compileFactWrite, type FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

// A full rebuild used to run silent: the writer supervisor's 30s stall watchdog could not tell a
// working-but-slow rebuild apart from a wedged worker, so large projections (ai-mbse, 37s) were
// killed mid-rebuild. Rebuild must report per-round progress exactly like incremental catch-up.
test("explicit rebuild reports per-round progress like catch-up", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore } = threeFactLedger(rootDir, "rebuild-progress");
    const progress: Array<{ readonly applied: number; readonly total: number; readonly watermark: number }> = [],
      projection = makeTaskProjection({
        rootDir,
        eventStore,
        catchUpLimit: 1,
        onProgress: (round) => progress.push({ ...round, total: round.total ?? -1 }),
      });
    const receipt = projection.rebuild();
    assert.equal(receipt.watermark, 3);
    assert.deepEqual(progress, [
      { applied: 1, total: 3, watermark: 1 },
      { applied: 2, total: 3, watermark: 2 },
      { applied: 3, total: 3, watermark: 3 },
    ]);
    projection.close();
  });
});

test("explicit rebuild without a progress callback still completes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { eventStore } = threeFactLedger(rootDir, "rebuild-quiet");
    const projection = makeTaskProjection({ rootDir, eventStore, catchUpLimit: 1 });
    assert.equal(projection.rebuild().watermark, 3);
    projection.close();
  });
});

function threeFactLedger(rootDir: string, repoId: string) {
  initRepo(rootDir);
  const eventStore = makeTaskEventStore({ repoId, rootDir });
  (["F-A1B2C3D4", "F-11223344", "F-DEADBEEF"] as const).forEach((factId, index) => {
    const event: FactEventDraftV1 = {
      schema: "fact-event/v1",
      eventId: `event-${factId}`,
      workspaceRevision: index + 1,
      opId: `op-${factId}`,
      factId,
      type: "fact_recorded",
      actor: { principal: { personId: "projection-rebuild-test" }, executor: null },
      source: "local",
      occurredAt: "2026-08-28T00:00:00.000Z",
      payload: {
        statement: `Rebuild progress fixture fact ${index + 1}.`,
        evidenceSource: "projection rebuild progress fixture",
        observedAt: "2026-08-28T00:00:00.000Z",
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "projection-rebuild-progress",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      },
    };
    eventStore.append(compileFactWrite({ event }));
  });
  return {
    projectionPath: path.join(rootDir, ".harness/cache/task.sqlite"),
    eventStore,
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Projection Rebuild Test");
  git(rootDir, "config", "user.email", "projection-rebuild@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
