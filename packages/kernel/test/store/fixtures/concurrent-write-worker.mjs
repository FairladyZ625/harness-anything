import { existsSync } from "node:fs";
import { Effect } from "effect";
import { decisionEntityId, taskEntityId } from "../../../src/domain/index.ts";
import { makeJournaledWriteCoordinator } from "../../../src/store/index.ts";

const [rootDir, barrierPath, writerId] = process.argv.slice(2);
while (!existsSync(barrierPath)) await new Promise((resolve) => setTimeout(resolve, 2));

const receipts = [];
for (let index = 0; index < 10; index += 1) {
  const coordinator = makeJournaledWriteCoordinator({
    rootDir,
    actor: { kind: "agent", id: `concurrent-${writerId}` },
    lockConflictRetry: { maxWaitMs: 5_000, initialDelayMs: 5, maxDelayMs: 50 }
  });
  const taskId = `task-concurrent-${index}`;
  const decisionId = `dec_CONCURRENT_${index}`;
  Effect.runSync(coordinator.enqueue({
    opId: `concurrent-create-${index}`,
    entityId: taskEntityId(taskId),
    kind: "package_create",
    payload: { writes: [{ taskId, path: "notes.md", body: `created ${index}\n`, packageSlug: `concurrent-${index}` }] }
  }));
  Effect.runSync(coordinator.enqueue({
    opId: `concurrent-propose-${index}`,
    entityId: decisionEntityId(decisionId),
    kind: "decision_propose",
    payload: {
      decision: {
        schema: "decision-package/v1",
        decision_id: decisionId,
        title: `Concurrent decision ${index}`,
        state: "proposed",
        riskTier: "medium",
        urgency: "medium",
        vertical: "software/coding",
        preset: "architecture-decision",
        applies_to: { modules: [], productLines: [] },
        proposedBy: { kind: "agent", id: "concurrent-fixture" },
        proposedAt: "2026-07-11T00:00:00.000Z",
        arbiter: { kind: "human", id: "fixture" },
        provenance: [],
        question: "Does concurrent replay converge?",
        chosen: [],
        rejected: [],
        claims: [],
        relations: []
      },
      writeMode: { kind: "snapshot", expectedWatermark: null }
    }
  }));
  receipts.push(await runEffect(coordinator.flush("explicit")));
}

process.stdout.write(`${JSON.stringify({ writerId, receipts })}\n`);

function runEffect(effect) {
  return new Promise((resolve, reject) => {
    Effect.runCallback(effect, {
      onExit: (exit) => exit._tag === "Success" ? resolve(exit.value) : reject(new Error(String(exit.cause)))
    });
  });
}
