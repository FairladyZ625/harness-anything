import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { withTempStoreAsync } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("two writer processes concurrently create and propose without duplicate entities or false receipts", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const barrierPath = path.join(rootDir, "start-writers");
    const workerPath = new URL("./fixtures/concurrent-write-worker.mjs", import.meta.url);
    const writers = ["a", "b"].map((writerId) => execFileAsync(
      process.execPath,
      [workerPath.pathname, rootDir, barrierPath, writerId],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }
    ));
    writeFileSync(barrierPath, "start\n", "utf8");

    const results = await Promise.all(writers);

    for (const result of results) {
      const receipt = JSON.parse(result.stdout) as { readonly receipts: ReadonlyArray<{ readonly committed: boolean }> };
      assert.equal(receipt.receipts.length, 10);
      assert.equal(receipt.receipts.every((entry) => entry.committed), true);
    }
    const taskPackages = readdirSync(path.join(rootDir, "harness/tasks")).filter((entry) => entry.startsWith("task-concurrent-"));
    const decisions = readdirSync(path.join(rootDir, "harness/decisions")).filter((entry) => entry.startsWith("decision-dec_CONCURRENT_"));
    assert.equal(taskPackages.length, 10);
    assert.equal(decisions.length, 10);
    for (let index = 0; index < 10; index += 1) {
      assert.equal(existsSync(path.join(rootDir, `harness/tasks/task-concurrent-${index}-concurrent-${index}/notes.md`)), true);
      assert.match(
        readFileSync(path.join(rootDir, `harness/decisions/decision-dec_CONCURRENT_${index}/decision.md`), "utf8"),
        new RegExp(`^_coordinatorWatermark: concurrent-propose-${index}$`, "mu")
      );
    }
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8")) as {
      readonly lastCommittedOpIds: ReadonlyArray<string>;
    };
    assert.equal(new Set(watermark.lastCommittedOpIds).size, watermark.lastCommittedOpIds.length);
  });
});
