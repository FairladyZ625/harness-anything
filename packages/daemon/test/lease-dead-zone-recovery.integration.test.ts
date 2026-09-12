// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding, WriteReceipt } from "../src/repo-cell-types.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

const holderBinding: RepoCellBinding = {
  actor: { principal: { personId: "person-holder" }, executor: null },
  source: "local",
};
const peerBinding: RepoCellBinding = {
  actor: { principal: { personId: "person-peer" }, executor: null },
  source: "local",
};

test("an expired current-round lease is recoverable by any repo-write actor through ha task start", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-dead-zone-"));
  let clock = new Date("2026-09-12T00:00:00.000Z");
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("lease-dead-zone"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "lease-dead-zone",
      now: () => clock.toISOString(),
    });
    const created = await createRealizedTaskPlanFixture(
      rootDir,
      () =>
        cell!.run(
          { kind: "task-create", taskId: "task_dead_zone", title: "Lease dead zone recovery", presetId: "docs-task" },
          holderBinding,
        ),
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, holderBinding),
      "Lease dead zone recovery",
    );
    const packagePath = String(created.packagePath);
    const started = (await cell.run(
      { kind: "task-start", taskId: "task_dead_zone", executionId: "exe_dead_zone", ttlMs: 60_000 },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(started.outcome, "applied", JSON.stringify(started));

    // The holder is gone and no settlement released the lease: past TTL the stored lease reads
    // orphaned, and before the fix both `ha task start` forms rejected with invalid_transition
    // while the round's execution stayed active (T1-random-baseline).
    clock = new Date("2026-09-12T02:00:00.000Z");
    const rejoined = (await cell.run({ kind: "task-start", taskId: "task_dead_zone" }, peerBinding)) as WriteReceipt;
    assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
    assert.equal(rejoined.executionId, "exe_dead_zone", "the plain form rejoins the round's active execution");

    // The recovery must leave the write chain usable: the new holder can submit.
    const artifacts = path.join(rootDir, "harness", packagePath, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, "report.md"), "# Evidence\n\nTakeover receipt under test.\n");
    const artifactReceipt = (await cell.run(
      { kind: "doc-submit", taskId: "task_dead_zone" },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(artifactReceipt.outcome, "applied", JSON.stringify(artifactReceipt));
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      "## Summary\nRecovered after lease expiry. " +
        `artifact:${packagePath}/artifacts/report.md@${String(artifactReceipt.revision)}\n` +
        "## Verification\n- Targeted test passed.\n" +
        "## Residual Risk\n- None.\n" +
        "## Same Mechanism Elsewhere\n- None.\n",
    );
    const submitted = (await cell.run(
      { kind: "task-submit", taskId: "task_dead_zone", executionId: "exe_dead_zone" },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("naming a foreign execution id explains the round's active execution to rejoin", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-dead-zone-foreign-"));
  let clock = new Date("2026-09-12T00:00:00.000Z");
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("lease-dead-zone-foreign"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "lease-dead-zone-foreign",
      now: () => clock.toISOString(),
    });
    await createReadyTask(cell, rootDir, "task_foreign_id", "Foreign execution id guidance");
    const started = (await cell.run(
      { kind: "task-start", taskId: "task_foreign_id", executionId: "exe_foreign", ttlMs: 60_000 },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    clock = new Date("2026-09-12T02:00:00.000Z");

    const rejected = (await cell.run(
      { kind: "task-start", taskId: "task_foreign_id", executionId: "exe_not_in_round" },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "invalid_transition");
    assert.equal(
      rejected.diagnostic?.expectation,
      `Current round already has active execution exe_foreign; run ha task start task_foreign_id ` +
        `without --execution-id, or with --execution-id exe_foreign, to rejoin it`,
      JSON.stringify(rejected.diagnostic),
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ReturnToPlanned frees the round so ha task start allocates a fresh execution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-dead-zone-return-"));
  const clock = new Date("2026-09-12T00:00:00.000Z");
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("lease-dead-zone-return"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "lease-dead-zone-return",
      now: () => clock.toISOString(),
    });
    await createReadyTask(cell, rootDir, "task_return_round", "ReturnToPlanned round release");
    const started = (await cell.run(
      { kind: "task-start", taskId: "task_return_round", executionId: "exe_return_round" },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const released = (await cell.run(
      { kind: "task-release", taskId: "task_return_round", reason: "Resetting the round" },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const returned = (await cell.run(
      { kind: "task-transition", taskId: "task_return_round", status: "planned", reason: "Resetting the round" },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));

    // Before the fix the released-but-active execution kept claiming the round: the plain form
    // silently rejoined it and a fresh id was the only thing `ha task start` could not do.
    const fresh = (await cell.run({ kind: "task-start", taskId: "task_return_round" }, peerBinding)) as WriteReceipt;
    assert.equal(fresh.outcome, "applied", JSON.stringify(fresh));
    assert.notEqual(fresh.executionId, "exe_return_round", "a fresh execution is allocated for the new round");
    assert.equal(String(fresh.executionId).startsWith("exe_"), true);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function createReadyTask(cell: Cell, rootDir: string, taskId: string, title: string): Promise<void> {
  await createRealizedTaskPlanFixture(
    rootDir,
    async () => {
      const created = await cell.run({ kind: "task-create", taskId, title }, holderBinding);
      await waitForFixturePublication(cell, created.opId, holderBinding);
      return created;
    },
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, holderBinding),
    title,
  );
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Lease Dead Zone Test");
  git(rootDir, "config", "user.email", "lease-dead-zone@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
