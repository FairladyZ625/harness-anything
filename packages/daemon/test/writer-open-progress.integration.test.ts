// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ciRunObservationWritePlan, type CiRunObservationEventV4 } from "@harness-anything/kernel";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
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
    const template = JSON.parse(
      readFileSync(
        new URL("../../kernel/fixtures/canonical-events/ci-run-observation-v4/workflow.json", import.meta.url),
        "utf8",
      ),
    ) as CiRunObservationEventV4;
    for (let revision = 2; revision <= 513; revision++) {
      const event = { ...template, workspaceRevision: revision, opId: `open-${revision}`, eventId: `open-${revision}` };
      store.append({ event, plan: ciRunObservationWritePlan(event), blobs: [] });
    }
    await store.drain();
    rmSync(path.join(rootDir, ".harness/cache"), { recursive: true, force: true });
    for (const cold of [true, false]) {
      const cuts: number[] = [];
      const cell = await openRepoWriterCell(
        {
          repoId: workspaceId(repoId),
          rootDir: canonicalRoot(rootDir),
          ownerId: "writer-open-test",
          onOpenProgress(progress) {
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
