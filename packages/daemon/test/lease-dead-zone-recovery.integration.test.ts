// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding, WriteReceipt } from "../src/repo-cell-types.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

const holderBinding: RepoCellBinding = withPolicyGroup(
  {
    actor: { principal: { personId: "person-holder" }, executor: null },
    source: "local",
  },
  "admin",
);
const peerBinding: RepoCellBinding = withPolicyGroup(
  {
    actor: { principal: { personId: "person-peer" }, executor: null },
    source: "local",
  },
  "admin",
);

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

test("the task owner can force-release an abandoned lease, rejoin its execution, and submit the closeout", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-force-takeover-"));
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("lease-force-takeover"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "lease-force-takeover",
    });
    const taskId = "task_force_takeover",
      executionId = "exe_force_takeover",
      packagePath = await createReadyTask(cell, rootDir, taskId, "Force takeover after dispatch death");
    const workerBinding = withPolicyGroup(
      {
        actor: {
          principal: holderBinding.actor.principal,
          executor: { kind: "agent" as const, id: "runtime-session:worker-429" },
        },
        source: "local" as const,
      },
      "admin",
    );
    const started = (await cell.run(
      { kind: "task-start", taskId, executionId, ttlMs: 3_600_000 },
      workerBinding,
    )) as WriteReceipt;
    assert.equal(started.outcome, "applied", JSON.stringify(started));

    // The agent session ended after a provider 429; no heartbeat or release reached the ledger.
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      "## Summary\nThe delivery was ready before the worker session ended.\n" +
        "## Verification\nThe task owner recovered the existing execution.\n" +
        "## Residual Risk\nNo provider retry was attempted.\n" +
        "## Same Mechanism Elsewhere\nRuntime-session leases use the same task-start fencing sequence.\n",
    );
    const foreignTakeover = (await cell.run(
      {
        kind: "task-release",
        taskId,
        forceTakeover: true,
        reason: "Attempt a takeover from a different principal.",
      },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(foreignTakeover.outcome, "op_rejected", JSON.stringify(foreignTakeover));
    assert.equal(foreignTakeover.code, "lease_conflict");

    const ownerWithoutReason = (await cell.run(
      { kind: "task-release", taskId, forceTakeover: true },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(ownerWithoutReason.outcome, "op_rejected", JSON.stringify(ownerWithoutReason));
    assert.equal(ownerWithoutReason.code, "invalid_command");

    const released = (await cell.run(
      {
        kind: "task-release",
        taskId,
        forceTakeover: true,
        reason: "Worker session ended after provider HTTP 429; preserve and submit the existing closeout.",
      },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    const releaseEvent = makeTaskEventReader({
      repoId: workspaceId("lease-force-takeover"),
      rootDir: canonicalRoot(rootDir),
    }).readEvent(released.opId);
    assert.equal(releaseEvent?.type, "lease_released");
    if (releaseEvent?.type === "lease_released")
      assert.equal(
        releaseEvent.payload.mutation.reason,
        "Owner forced takeover: Worker session ended after provider HTTP 429; preserve and submit the existing closeout.",
      );

    const rejoined = (await cell.run({ kind: "task-start", taskId, executionId }, holderBinding)) as WriteReceipt;
    assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
    assert.equal(rejoined.executionId, executionId, "takeover must preserve the unsubmitted execution");
    const staleWrite = (await cell.run(
      { kind: "task-progress-append", taskId, text: "stale worker write" },
      workerBinding,
    )) as WriteReceipt;
    assert.equal(staleWrite.outcome, "op_rejected", JSON.stringify(staleWrite));

    const synced = (await cell.run({ kind: "doc-submit", taskId }, holderBinding)) as WriteReceipt;
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    const submitted = (await cell.run({ kind: "task-submit", taskId, executionId }, holderBinding)) as WriteReceipt;
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

test("an archived dead-zone task reopens and rejoins its execution through ha task start --execution-id", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-dead-zone-archive-"));
  let clock = new Date("2026-09-12T00:00:00.000Z");
  let cell: Cell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("lease-dead-zone-archive"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "lease-dead-zone-archive",
      now: () => clock.toISOString(),
    });
    await createReadyTask(cell, rootDir, "task_archive_dz", "Archived dead-zone recovery");
    const started = (await cell.run(
      { kind: "task-start", taskId: "task_archive_dz", executionId: "exe_archive_dz", ttlMs: 60_000 },
      holderBinding,
    )) as WriteReceipt;
    assert.equal(started.outcome, "applied", JSON.stringify(started));

    // The holder is gone and past TTL the stored lease reads orphaned. Before the fix the
    // active_lease guard rejected task-archive itself, so the T1-random-baseline recovery
    // chain (archive, then reopen, then start --execution-id) died at step one for any
    // actor who could not release the orphaned lease.
    clock = new Date("2026-09-12T02:00:00.000Z");
    const archived = (await cell.run(
      { kind: "task-archive", taskId: "task_archive_dz", reason: "Holder gone; parking the dead round" },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(archived.outcome, "applied", JSON.stringify(archived));
    const reopened = (await cell.run(
      { kind: "task-reopen", taskId: "task_archive_dz", reason: "Recovering the parked execution" },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(reopened.outcome, "applied", JSON.stringify(reopened));
    const rejoined = (await cell.run(
      { kind: "task-start", taskId: "task_archive_dz", executionId: "exe_archive_dz" },
      peerBinding,
    )) as WriteReceipt;
    assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
    assert.equal(rejoined.executionId, "exe_archive_dz", "reopen leaves the round recoverable");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function createReadyTask(cell: Cell, rootDir: string, taskId: string, title: string): Promise<string> {
  const created = await createRealizedTaskPlanFixture(
    rootDir,
    async () => {
      const created = await cell.run({ kind: "task-create", taskId, title }, holderBinding);
      await waitForFixturePublication(cell, created.opId, holderBinding);
      return created;
    },
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, holderBinding),
    title,
  );
  return String(created.packagePath);
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
