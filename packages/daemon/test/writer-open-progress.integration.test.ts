// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
import { event as taskCreatedTemplate } from "../../kernel/test/store/task-event-store.fixtures.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { openRepoWriterCell } from "../src/repo-cell-open.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { seedSettingsEvent } from "./repo-settings.fixture.ts";

test("cold writer open publishes committed cuts before a large projection batch and hot open stays current", async () => {
  await withTempStoreAsync(async (rootDir) => {
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Writer Open Fixture"],
      ["config", "user.email", "writer-open@example.invalid"],
      ["commit", "--allow-empty", "-qm", "fixture"],
    ])
      execFileSync("git", args, { cwd: rootDir, stdio: "pipe" });
    const repoId = "writer-open-progress";
    const store = seedSettingsEvent({ repoId, rootDir, keepOpen: true })!;
    for (let revision = 2; revision <= 513; revision++) {
      const task = {
          ...taskCreatedTemplate.payload.task,
          taskId: `task-${revision}`,
          title: `Writer open ${revision}`,
        },
        event = {
          ...taskCreatedTemplate,
          workspaceRevision: revision,
          opId: `open-${revision}`,
          eventId: `open-${revision}`,
          taskId: task.taskId,
          payload: { ...taskCreatedTemplate.payload, task },
        };
      store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    }
    await store.drain();
    rmSync(path.join(rootDir, ".harness/cache"), { recursive: true, force: true });
    for (const cold of [true, false]) {
      const cuts: number[] = [],
        recoveryProgress: number[] = [];
      const cell = await openRepoWriterCell(
        {
          repoId: workspaceId(repoId),
          rootDir: canonicalRoot(rootDir),
          ownerId: "writer-open-test",
          onOpenProgress(progress) {
            if (progress.phase === "recovering" && progress.applied !== null) recoveryProgress.push(progress.applied);
            if (progress.phase === "catching-up") {
              assert.equal(progress.total, 513);
              assert.equal(progress.applied, progress.watermark);
              cuts.push(progress.watermark!);
            }
          },
        },
        { close: async () => undefined } as never,
      );
      try {
        assert.equal(cell.status().state, "attached");
        if (cold) {
          assert.ok(recoveryProgress.length >= 3);
          assert.ok(recoveryProgress.every((applied, index) => index === 0 || applied > recoveryProgress[index - 1]!));
          assert.equal(cuts.at(-1), 513);
          assert.ok(cuts.length > 3);
          assert.ok(cuts.every((watermark, index) => index === 0 || watermark > cuts[index - 1]!));
        } else assert.deepEqual(cuts, []);
      } finally {
        await cell.close();
      }
    }
  });
});
