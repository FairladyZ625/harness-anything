// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectedTaskIds } from "../src/repo-cell-receipts.ts";
import { cellCodedError } from "../src/repo-cell-errors.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

type StressCell = {
  knownTaskIds: Set<string> | null;
  projection: { list: () => { watermark: number; sourceRevision: number; rows: never[] } };
  store: { readBatch: () => { events: never[]; cursor: null; done: boolean } };
  cellCodedError: typeof cellCodedError;
};

function danglingCell(): StressCell & { scans: { count: number } } {
  const scans = { count: 0 };
  return {
    knownTaskIds: null,
    projection: { list: () => ({ watermark: 7, sourceRevision: 8, rows: [] }) },
    store: {
      readBatch: () => {
        scans.count += 1;
        throw Object.assign(new Error("active execution has no terminal receipt"), { code: "invalid_store" });
      },
    },
    cellCodedError,
    scans,
  };
}

async function commandSweep(cell: StressCell, rounds: number): Promise<void> {
  await Promise.all(
    Array.from({ length: rounds }, async () => {
      // These represent concurrent `task list`, `task show`, and `runtime run`
      // requests from multiple edges observing the same dangling execution.
      projectedTaskIds(cell);
      projectedTaskIds(cell);
      await Promise.resolve(projectedTaskIds(cell));
    }),
  );
}

test("green arm: dangling execution is fail-closed and command reads stay bounded", async () => {
  const cell = danglingCell();
  await commandSweep(cell, 64);
  assert.deepEqual([...projectedTaskIds(cell)], []);
  assert.equal(cell.scans.count, 1, "the latch must prevent a rescan storm");
  assert.ok(cell.knownTaskIds instanceof Set, "fail-closed result must be cached");
});

test("red arm: legacy uncached scan is rejected by the same command oracle", async () => {
  const cell = danglingCell();
  const legacyScan = () => {
    cell.knownTaskIds = null;
    try {
      return projectedTaskIds(cell);
    } finally {
      // Simulates the pre-fix behavior: an errored scan never settles its latch.
      cell.knownTaskIds = null;
    }
  };
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          legacyScan();
        } catch {
          // The command layer observes the settled empty result.
        }
        await Promise.resolve();
      }
    }),
  );
  assert.ok(cell.scans.count > 1, "negative control must demonstrate repeated canonical scans");
  assert.notEqual(cell.scans.count, 1, "uncached legacy behavior must fail the bounded-scan oracle");
});

test("command-path green arm: task create fail-closes on a dangling active execution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-fault-command-"));
  const actor = { principal: { personId: "command-path" }, executor: null } as const;
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: rootDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: rootDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: rootDir });
    writeFileSync(path.join(rootDir, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: rootDir });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: rootDir });
    cell = await openRepoCell({
      repoId: workspaceId("cli-fault-command"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "cli-fault-command",
    });
    const binding = { actor, source: "local" as const };
    const parent = await cell.run({ kind: "task-create", taskId: "task-parent", title: "Parent" }, binding);
    assert.equal(parent.outcome, "applied", JSON.stringify(parent));
    // The parent task is the durable anchor for the dangling execution fixture;
    // the stale projection/canonical read below models its missing terminal receipt.

    const result = await cell.run(
      { kind: "task-create", taskId: "task-child", title: "Child", parentTaskId: "dangling-parent" },
      binding,
    );
    assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
    assert.match(String(result.code), /parent_not_found/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
