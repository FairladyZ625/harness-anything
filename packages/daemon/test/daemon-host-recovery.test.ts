// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  readDaemonRegistry,
  registerDaemonRepo as registerProductDaemonRepo,
  taskLifecycleWritePlan,
} from "../../kernel/src/index.ts";
import { WRITE_RECEIPT_SCHEMA } from "../../kernel/src/index.ts";
import { validateWriteReceipt } from "../../kernel/test/contracts/receipt-acceptance.fixtures.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { localSystemBinding } from "../src/daemon-host-binding.ts";
import { rejectHostAction, rejectPresetRun } from "../src/daemon-host-errors.ts";
import type { DaemonHostOpenInput } from "../src/daemon-host-open.ts";
import { canonicalRoot, workspaceId, type DaemonStatusResult } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellStatus, RepoTaskAction } from "../src/repo-cell-types.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
} from "./repo-settings.fixture.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";

function assertValidWriteReceipt(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]),
    receipt = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  assert.deepEqual(validateWriteReceipt(receipt), []);
}

test("a startup-failed repo self-heals on the next command and reports honest status", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-heal-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-heal");
  const root = canonicalRoot(rootDir),
    lockPath = `${root}.harness-anything-writer.lock`;
  registerDaemonRepo({ canonicalRoot: root, repoId: "host-heal", userRoot, createConvenienceLinks: false });
  let clock = "2026-08-18T00:00:00.000Z";
  writeFileSync(lockPath, `${process.pid}\n`); // a live lock holder: the startup open must fail
  const host = await openDaemonHost({ daemonId: "host-heal", userRoot, now: () => clock });
  await host.attachmentsSettled();
  try {
    const latched = host.status().repos.find((repo) => repo.repoId === "host-heal");
    assert.ok(latched, "startup failure must park the repo in the status list");
    assert.equal(latched.state, "unavailable");
    assert.equal(latched.causeClass, "infrastructure");
    assert.match(String(latched.lastError), /writer lock/u);
    assert.equal(latched.generation, null);
    assert.equal(latched.queueDepth, null);
    assert.equal(latched.recoveryMs, null);
    const systemLatched = systemRow(host, "host-heal");
    assert.equal(systemLatched.cellState, "unavailable");
    assert.equal(systemLatched.generation, null);
    assert.equal(systemLatched.queueDepth, null);
    assert.match(String(systemLatched.unavailableReason), /writer lock/u);
    // Repair the workspace underneath the live daemon; the next command re-attaches it.
    rmSync(lockPath);
    clock = "2026-08-18T00:00:01.000Z"; // fresh latch earned one immediate probe
    const healed = await host.run(
      "host-heal",
      { kind: "task-create", taskId: "task_host_heal", title: "Host heal" },
      auth,
    );
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    const attached = host.status().repos.find((repo) => repo.repoId === "host-heal")!;
    assert.equal(attached.state, "attached");
    assert.equal(attached.lastError, null);
    assert.equal(typeof attached.generation, "number");
    assert.ok(attached.generation! > 0);
    assert.equal(typeof attached.queueDepth, "number");
    const systemAttached = systemRow(host, "host-heal");
    assert.equal(systemAttached.cellState, "attached");
    assert.equal(typeof systemAttached.generation, "number");
    assert.equal(systemAttached.unavailableReason, null);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("startup retires a registered root that no longer exists and records the attach outcomes that remain", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-lifecycle-")),
    userRoot = path.join(parent, "user"),
    live = path.join(parent, "live"),
    dead = path.join(parent, "dead"),
    records: Record<string, unknown>[] = [];
  rosterRepo(live, "lifecycle-live");
  rosterRepo(dead, "lifecycle-dead");
  registerDaemonRepo({ canonicalRoot: live, repoId: "lifecycle-live", userRoot, createConvenienceLinks: false });
  const deadRow = registerDaemonRepo({
    canonicalRoot: dead,
    repoId: "lifecycle-dead",
    userRoot,
    createConvenienceLinks: false,
  }).repo;
  rmSync(dead, { recursive: true, force: true });
  const host = await openDaemonHost({
    daemonId: "host-lifecycle",
    userRoot,
    recordLifecycle: (record) => records.push(record),
  });
  await host.attachmentsSettled();
  try {
    const pruned = records.filter((record) => record.event === "repo_registry_pruned");
    assert.equal(pruned.length, 1);
    assert.equal(pruned[0]?.repoId, "lifecycle-dead");
    assert.equal(pruned[0]?.rootDir, deadRow.canonicalRoot);
    assert.equal(typeof pruned[0]?.registeredAt, "string");
    assert.deepEqual(
      records.filter((record) => record.event === "repo_attach_started").map((record) => record.repoId),
      ["lifecycle-live"],
    );
    const settled = records.filter((record) => record.event === "repo_attach_completed");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.repoId, "lifecycle-live");
    assert.equal(settled[0]?.attachTotal, 2);
    assert.equal(settled[0]?.attachIndex, 2);
    assert.equal(typeof settled[0]?.durationMs, "number");
    const summary = records.find((record) => record.event === "attachments_settled");
    assert.equal(summary?.attachTotal, 2);
    assert.equal(summary?.attached, 1);
    assert.equal(summary?.unavailable, 0);
    assert.equal(summary?.pruned, 1);
    const registry = readDaemonRegistry({ userRoot }),
      row = registry.repos.find((repo) => repo.repoId === "lifecycle-dead");
    assert.equal(row?.state, "disabled");
    const disabled = host.status().repos.find((repo) => repo.repoId === "lifecycle-dead");
    assert.equal(disabled?.registrationState, "disabled");
    assert.equal(disabled?.state, "closed");
    assert.equal(disabled?.nextAction, "ha repo unbind lifecycle-dead");
    assert.match(String(disabled?.lastError), /canonical root does not exist/u);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a request arriving while a registered repo warms parks until background attachment settles", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-warming-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-warming");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId: "host-warming", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "host-warming", userRoot });
  try {
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-warming")?.state, "warming");
    const receipt = await host.run("host-warming", { kind: "task-list" }, auth);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-warming")?.state, "attached");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon status exposes the writer phase and progress while a repository attaches", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-attach-progress-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-attach-progress");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "host-attach-progress",
    userRoot,
    createConvenienceLinks: false,
  });
  let publishProgress!: () => void, releaseOpen!: () => void;
  const workerStatuses: RepoCellStatus[] = [],
    progressPublished = new Promise<void>((resolve) => {
      publishProgress = resolve;
    }),
    openReleased = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    }),
    openCell: NonNullable<DaemonHostOpenInput["openCell"]> = async (cellInput) => {
      cellInput.onStatus?.({
        repoId: cellInput.repoId,
        rootDir: cellInput.rootDir,
        mode: cellInput.mode ?? "local",
        state: "warming",
        generation: null,
        queueDepth: 0,
        lastError: null,
        causeClass: null,
        recoveryMs: null,
        materialization: null,
        attach: {
          phase: "catching-up",
          applied: 4_096,
          total: 8_192,
          watermark: 4_096,
        },
      });
      publishProgress();
      await openReleased;
      return openRepoCell({
        ...cellInput,
        onStatus: (status) => {
          workerStatuses.push(status);
          cellInput.onStatus?.(status);
        },
      });
    },
    host = await openDaemonHost({ daemonId: "host-attach-progress", userRoot, openCell }),
    attachments = host.attachmentsSettled();
  await progressPublished;
  try {
    const response = { ok: true as const, ...host.status() } satisfies DaemonStatusResult,
      row = response.repos.find((repo) => repo.repoId === "host-attach-progress");
    context.diagnostic(`ha daemon status repo row: ${JSON.stringify(row)}`);
    assert.equal(row?.state, "warming");
    assert.match(response.summary, /attaching 0\/1/u);
    assert.deepEqual(row?.attach, {
      phase: "catching-up",
      applied: 4_096,
      total: 8_192,
      watermark: 4_096,
    });
    releaseOpen();
    await attachments;
    assert.ok(
      workerStatuses.some((status) => status.attach?.phase === "catching-up"),
      "the real writer must relay its catch-up boundary through the existing status message",
    );
    const attachedRows = host.status().repos.filter((repo) => repo.repoId === "host-attach-progress");
    assert.equal(attachedRows.length, 1);
    assert.equal(attachedRows[0]?.state, "attached");
    assert.equal(attachedRows[0]?.attach, undefined);
  } finally {
    releaseOpen();
    await attachments;
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a failed Git follower stays observable without rejecting later SQLite writes", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-git-follower-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = workspaceId("host-git-follower");
  rosterRepo(rootDir, repoId);
  const prepared = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "prepare-git-follower" });
  await prepared.close();
  const bootstrapEvents = makeTaskEventReader({ repoId, rootDir }).read().events;
  assert.equal(bootstrapEvents.length, 2);
  assert.equal(bootstrapEvents[1]?.schema, "vertical-declaration-event/v1");
  assert.equal(bootstrapEvents[1]?.type, "vertical_declared");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  let failGit = true;
  const host = await openDaemonHost({
    daemonId: "host-git-follower",
    userRoot,
    openCell: (cellInput) =>
      openRepoCell({
        ...cellInput,
        killpoint: (point) => {
          if (failGit && point === "after_git_commit") throw new Error("simulated Git follower failure");
        },
      }),
  });
  await host.attachmentsSettled();
  try {
    const accepted = await host.run(
      repoId,
      { kind: "task-create", taskId: "task_git_follower_1", title: "Accepted before Git" },
      auth,
    );
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(accepted.status, "accepted_durable");
    assertValidWriteReceipt(accepted);
    await host.settleMaterialization(repoId, "observe injected Git follower failure");
    const failed = await waitForRepoMaterialization(host, repoId, "failed");
    context.diagnostic(`failed daemon status row: ${JSON.stringify(failed)}`);
    assert.equal(failed.materialization?.state, "failed");
    assert.equal(failed.materialization?.reason, "deterministic_failure");
    assert.match(String(failed.materialization?.lastError), /simulated Git follower failure/u);

    const acceptedWhilePending = await host.run(
      repoId,
      { kind: "task-create", taskId: "task_git_follower_2", title: "Accepted while Git is pending" },
      auth,
    );
    assert.equal(acceptedWhilePending.status, "accepted_durable", JSON.stringify(acceptedWhilePending));
    assert.notEqual(acceptedWhilePending.outcome, "op_rejected");
    assertValidWriteReceipt(acceptedWhilePending);
    const pending = await host.run(
      repoId,
      { kind: "receipt-show", opId: accepted.opId, waitFor: ["git_verified"], timeoutMs: 0 },
      auth,
    );
    assert.equal(pending.status, "accepted_durable");
    assert.equal(pending.git.state, "pending");
    assert.deepEqual(pending.wait, { state: "timed_out", unsatisfied: ["git_verified"] });

    failGit = false;
    await host.settleMaterialization(repoId, "Git follower recovery control");
    const healthy = await waitForRepoMaterialization(host, repoId, "ok");
    context.diagnostic(`recovered daemon status row: ${JSON.stringify(healthy)}`);
    assert.equal(healthy.materialization?.lastCheckpointRevision, acceptedWhilePending.acceptance?.revisionTo);
    const recovered = await host.run(
      repoId,
      {
        kind: "receipt-show",
        opId: accepted.opId,
        waitFor: ["accepted_durable", "projection_visible", "git_verified"],
        timeoutMs: 5_000,
      },
      auth,
    );
    assert.equal(recovered.outcome, "applied", JSON.stringify(recovered));
    assert.equal(recovered.wait?.state, "satisfied");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a request parked behind a non-settling initial attachment times out as repo_warming", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-warming-timeout-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-warming-timeout");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "host-warming-timeout",
    userRoot,
    createConvenienceLinks: false,
  });
  const host = await openDaemonHost({ daemonId: "host-warming-timeout", userRoot, shutdownRequested: () => true });
  try {
    const started = performance.now(),
      receipt = await host.run("host-warming-timeout", { kind: "task-list" }, auth),
      elapsedMs = performance.now() - started;
    assert.equal(receipt.outcome, "op_rejected");
    assert.equal(receipt.code, "repo_warming");
    assert.ok(elapsedMs >= 4_500, `warming timeout returned too early: ${elapsedMs.toFixed(1)}ms`);
    assert.ok(elapsedMs < 8_000, `warming timeout exceeded its bounded window: ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a missing-root repository can be unbound through daemon-level local authority", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-unregister-warming-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-unregister-warming");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "host-unregister-warming",
    userRoot,
    createConvenienceLinks: false,
  });
  rmSync(rootDir, { recursive: true, force: true });
  const host = await openDaemonHost({ daemonId: "host-unregister-warming", userRoot });
  try {
    const receipt = await host.admin({ kind: "unbind", repoId: "host-unregister-warming" }, auth);
    assert.equal(receipt.outcome, "applied");
    assert.equal(readDaemonRegistry({ userRoot }).repos.length, 0);
    await host.attachmentsSettled();
    assert.equal(
      host.status().repos.some((repo) => repo.repoId === "host-unregister-warming"),
      false,
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cache purge removes only derived local state and unbinds the repository", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-cache-purge-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "host-cache-purge";
  rosterRepo(rootDir, repoId);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: repoId, userRoot });
  await host.attachmentsSettled();
  const derived = ["cache", "adopt-claims", "runtime/dispatches", "presets"];
  for (const relative of derived) {
    const directory = path.join(rootDir, ".harness", relative);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "fixture"), "derived\n");
  }
  try {
    const receipt = await host.admin({ kind: "purge", repoId, scope: "cache" }, auth);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.deepEqual(receipt.removed, derived.map((relative) => `.harness/${relative}`).sort());
    assert.deepEqual(receipt.preserved, [
      ".harness/store",
      ".harness/wal",
      ".harness/store/imports",
      "harness",
      ".worktrees",
      ".gitignore",
    ]);
    assert.equal(readDaemonRegistry({ userRoot }).repos.length, 0);
    for (const relative of derived) assert.equal(existsSync(path.join(rootDir, ".harness", relative)), false);
    assert.equal(existsSync(path.join(rootDir, ".harness/store")), true);
    assert.equal(existsSync(path.join(rootDir, "harness")), true);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("unbind rejects an active task lease without changing registry or repository files", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-unbind-lease-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "host-unbind-lease";
  rosterRepo(rootDir, repoId);
  const prepared = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: "prepare",
  });
  await prepared.close();
  const store = makeTaskEventStore({ repoId: workspaceId(repoId), rootDir });
  for (const [index, fixtureEvent] of lifecycleFixture({ taskId: "task-live", executionId: "execution-live" })
    .events.slice(0, 2)
    .entries()) {
    const event =
      fixtureEvent.type === "execution_started"
        ? {
            ...fixtureEvent,
            workspaceRevision: index + 3,
            payload: {
              ...fixtureEvent.payload,
              lease: { ...fixtureEvent.payload.lease, expiresAt: "2027-09-15T00:00:00.000Z" },
              leaseExpiresAt: "2027-09-15T00:00:00.000Z",
            },
          }
        : { ...fixtureEvent, workspaceRevision: index + 3 };
    store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
  }
  await store.drain();
  registerDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: repoId, userRoot });
  await host.attachmentsSettled();
  try {
    assert.equal(host.status().repos.find((repo) => repo.repoId === repoId)?.state, "attached");
    const projection = makeTaskProjection({
      rootDir,
      eventStore: makeTaskEventReader({ repoId: workspaceId(repoId), rootDir }),
    });
    assert.equal(projection.list().rows.find((row) => row.taskId === "task-live")?.snapshot.lease?.phase, "held");
    projection.close();
    const registryBefore = readFileSync(path.join(userRoot, "registry.json")),
      ledgerBefore = readFileSync(path.join(rootDir, "harness/harness.yaml")),
      receipt = await host.admin({ kind: "unbind", repoId }, auth);
    assert.equal(receipt.outcome, "rejected");
    assert.equal(receipt.code, "repo_in_flight");
    assert.equal(
      receipt.blockingWork?.some((item) => item.kind === "task-lease" && item.taskId === "task-live"),
      true,
    );
    assert.deepEqual(
      (receipt as { next?: readonly { command: string }[] }).next?.map((entry) => entry.command),
      ["ha task release task-live"],
    );
    assert.deepEqual(readFileSync(path.join(userRoot, "registry.json")), registryBefore);
    assert.deepEqual(readFileSync(path.join(rootDir, "harness/harness.yaml")), ledgerBefore);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an unactivated repository is unavailable while an activated peer attaches and serves", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-unactivated-")),
    userRoot = path.join(parent, "user"),
    inactive = path.join(parent, "inactive"),
    active = path.join(parent, "active");
  rosterRepo(inactive, "inactive");
  mkdirSync(path.join(inactive, "harness/events"), { recursive: true });
  writeFileSync(path.join(inactive, "harness/events/head.json"), '{"revision":1}\n');
  rosterRepo(active, "active");
  registerProductDaemonRepo({
    canonicalRoot: inactive,
    repoId: "inactive",
    userRoot,
    createConvenienceLinks: false,
  });
  registerDaemonRepo({ canonicalRoot: active, repoId: "active", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "host-unactivated", userRoot });
  try {
    await host.attachmentsSettled();
    const inactiveStatus = host.status().repos.find((repo) => repo.repoId === "inactive")!;
    assert.equal(inactiveStatus.state, "unavailable");
    assert.match(String(inactiveStatus.lastError), /run operator conversion before attaching this repository/u);
    assert.equal((await host.run("inactive", { kind: "task-list" }, auth)).code, "repo_unavailable");
    assert.equal((await host.run("active", { kind: "task-list" }, auth)).outcome, "applied");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the host-level re-probe is throttled to one attempt per interval", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-throttle-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-throttle");
  const root = canonicalRoot(rootDir),
    lockPath = `${root}.harness-anything-writer.lock`;
  registerDaemonRepo({ canonicalRoot: root, repoId: "host-throttle", userRoot, createConvenienceLinks: false });
  let clock = "2026-08-18T00:00:00.000Z";
  writeFileSync(lockPath, `${process.pid}\n`);
  const host = await openDaemonHost({ daemonId: "host-throttle", userRoot, now: () => clock });
  await host.attachmentsSettled();
  try {
    const rejected = await host.run("host-throttle", { kind: "task-list" }, auth); // probe 1 fails on the live lock
    assert.equal(rejected.outcome, "op_rejected");
    assert.equal(rejected.code, "repo_unavailable");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-throttle")!.state, "unavailable");
    rmSync(lockPath);
    clock = "2026-08-18T00:00:01.000Z"; // inside the throttle window of probe 1
    const throttled = await host.run("host-throttle", { kind: "task-list" }, auth);
    assert.equal(throttled.outcome, "op_rejected");
    assert.equal(throttled.code, "repo_unavailable"); // no probe ran
    clock = "2026-08-18T00:00:06.000Z"; // past the throttle window
    const healed = await host.run("host-throttle", { kind: "task-list" }, auth);
    assert.equal(healed.outcome, "applied", JSON.stringify(healed));
    assert.equal(host.status().repos.find((repo) => repo.repoId === "host-throttle")!.state, "attached");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("repository modes close local, center-assignment, and edge command families", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-modes-")),
    userRoot = path.join(parent, "user"),
    roots = Object.fromEntries(["local", "center", "edge"].map((name) => [name, path.join(parent, name)]));
  for (const [name, rootDir] of Object.entries(roots)) {
    rosterRepo(rootDir, name);
    registerDaemonRepo({
      canonicalRoot: rootDir,
      repoId: name,
      mode: name === "center" ? "remote-center" : name === "edge" ? "remote-edge" : "local",
      userRoot,
      createConvenienceLinks: false,
    });
  }
  const host = await openDaemonHost({ daemonId: "host-modes", userRoot });
  await host.attachmentsSettled();
  const assignment = (repoId: string) =>
    ({
      transportKind: "unix-socket",
      assignmentBinding: {
        nodeId: "node-mode",
        repoId,
        taskId: "task-mode",
        executionId: "execution-mode",
        assignmentId: `assignment-${repoId}`,
        paths: [],
        actor: { principal: { personId: "writer" }, executor: null },
      },
    }) as const;
  try {
    assert.deepEqual(
      host.status().repos.map(({ repoId, mode }) => [repoId, mode]),
      [
        ["center", "remote-center"],
        ["edge", "remote-edge"],
        ["local", "local"],
      ],
    );
    const sourceCommit = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
    });
    assert.match(
      host.status().summary,
      sourceCommit.status === 0
        ? new RegExp(`repos=3 entry=(?:source|dist) commit=${sourceCommit.stdout.trim()}$`, "u")
        : /repos=3 entry=(?:source|dist) commit=unknown$/u,
    );
    assert.equal(
      (await host.run("local", { kind: "task-create", taskId: "task-local", title: "Local" }, auth)).outcome,
      "applied",
    );
    assert.equal(
      (
        await host.run(
          "local",
          { kind: "task-create", taskId: "task-local-remote", title: "Assignment on local" },
          assignment("local"),
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await host.run("center", { kind: "task-create", taskId: "task-center-local", title: "Wrong ingress" }, auth))
        .code,
      "repo_mode_requires_center_ingress",
    );
    const mismatchedLocalAuth = {
      ...auth,
      unixSocketOwnerBoundary: { ...auth.unixSocketOwnerBoundary, ownerUid: (process.getuid?.() ?? 0) + 1_000 },
    };
    assert.equal((await host.run("center", { kind: "task-list" }, mismatchedLocalAuth)).code, "credential_unknown");
    assert.equal(
      (await host.run("center", { kind: "projection-rebuild" }, mismatchedLocalAuth)).code,
      "credential_unknown",
    );
    assert.equal((await host.run("center", { kind: "projection-rebuild" }, auth)).outcome, "applied");
    assert.equal(
      (await host.run("center", { kind: "task-create", taskId: "task-center", title: "Center" }, assignment("center")))
        .outcome,
      "applied",
    );
    assert.equal((await host.run("edge", { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal(
      (await host.run("edge", { kind: "task-create", taskId: "task-edge", title: "Edge" }, auth)).code,
      "repo_mode_read_only",
    );
    assert.equal((await host.run("edge", { kind: "projection-rebuild" }, auth)).code, "repo_mode_read_only");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("registry mode is authoritative before refresh and refresh replaces a drifted Cell", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-mode-refresh-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "mode-refresh");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "mode-refresh",
    mode: "local",
    userRoot,
    createConvenienceLinks: false,
  });
  const host = await openDaemonHost({ daemonId: "mode-refresh", userRoot });
  await host.attachmentsSettled();
  try {
    const generation = host.status().repos[0]?.generation;
    registerDaemonRepo({
      canonicalRoot: rootDir,
      repoId: "mode-refresh",
      mode: "remote-edge",
      userRoot,
      createConvenienceLinks: false,
    });
    const denied = await host.run(
      "mode-refresh",
      { kind: "task-create", taskId: "task_mode_drift", title: "Mode drift" },
      auth,
    );
    assert.equal(denied.outcome, "op_rejected");
    assert.equal(denied.code, "repo_mode_read_only");
    const refresh = await host.requestControl({ kind: "refresh", authorityRepoId: "mode-refresh" }, auth);
    assert.equal(refresh.outcome, "pending");
    const settled = await waitControl(host, refresh.operationId);
    assert.equal(settled.phase, "settled");
    const status = host.status().repos[0]!;
    assert.equal(status.mode, "remote-edge");
    assert.notEqual(status.generation, generation);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("remote-edge Cell terminal side effects require Cell-level mode admission", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-cell-terminal-mode-")),
    rootDir = path.join(parent, "repo");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    rosterRepo(rootDir, "cell-terminal-mode");
    cell = await openRepoCell({
      repoId: workspaceId("cell-terminal-mode"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "cell-terminal-mode",
      mode: "remote-edge",
    });
    const binding = { actor: { principal: { personId: "writer" }, executor: null }, source: "local" as const };
    assert.throws(
      () => cell!.terminal.spawn({}, binding),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "repo_mode_read_only",
    );
    assert.throws(
      () => cell!.terminal.spawnTrusted({} as never, binding),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "repo_mode_read_only",
    );
  } finally {
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon admission rejects a mismatched kernel projection schema and recovers after rebuild", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-schema-admission-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "schema-admission");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId: "schema-admission", userRoot, createConvenienceLinks: false });
  const cache = path.join(rootDir, ".harness/cache/task.sqlite");
  const projection = makeTaskProjection({
    rootDir,
    eventStore: {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
  });
  projection.list();
  projection.close();
  const db = new DatabaseSync(cache);
  db.exec("UPDATE projection_meta SET schema_version = 999 WHERE singleton = 1;");
  db.close();
  let clock = "2026-08-18T00:00:00.000Z";
  const host = await openDaemonHost({ daemonId: "schema-admission", userRoot, now: () => clock });
  await host.attachmentsSettled();
  try {
    const unavailable = host.status().repos.find((repo) => repo.repoId === "schema-admission")!;
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.causeClass, "data-shape");
    assert.match(String(unavailable.lastError), /kernel projection schema 999/u);
    assert.equal((await host.run("schema-admission", { kind: "task-list" }, auth)).code, "repo_unavailable");
    const repaired = new DatabaseSync(cache);
    repaired.exec("UPDATE projection_meta SET schema_version = 2 WHERE singleton = 1;");
    repaired.close();
    clock = "2026-08-18T00:00:06.000Z";
    assert.equal((await host.run("schema-admission", { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "schema-admission")?.state, "attached");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "schema-admission")?.attach, undefined);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon status exposes an ahead projection cache without letting rebuild discard it", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-ahead-projection-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "ahead-projection");
  const event = { ...lifecycleFixture().events[0]!, workspaceRevision: 5 },
    headlessStore = {
      readHead: () => null,
      readBatch: () => ({ sourceRevision: 0, events: [], cursor: null, done: true, accessedItems: 0 }),
      readContentBlob: () => null,
    },
    projection = makeTaskProjection({ rootDir, eventStore: headlessStore });
  projection.apply(event, taskLifecycleWritePlan(event));
  projection.close();
  const retained = readFileSync(projection.path);
  registerDaemonRepo({ canonicalRoot: rootDir, repoId: "ahead-projection", userRoot, createConvenienceLinks: false });
  const host = await openDaemonHost({ daemonId: "ahead-projection", userRoot });
  await host.attachmentsSettled();
  try {
    const unavailable = host.status().repos.find((repo) => repo.repoId === "ahead-projection")!;
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.causeClass, "data-shape", JSON.stringify(unavailable));
    assert.match(String(unavailable.lastError), /event stream head is 1.*revisions 2-5.*cache retained/iu);
    const rebuild = await host.run("ahead-projection", { kind: "projection-rebuild" }, auth);
    assert.equal(rebuild.code, "repo_unavailable");
    assert.deepEqual(rebuild.diagnostic, { kind: "failure", code: "repo_unavailable" });
    assert.deepEqual(readFileSync(projection.path), retained);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a host-rejected action keeps its coded message as the receipt explanation", () => {
  const message = "CI receipt cannot support completion: evidence executionId is not the current execution.",
    receipt = rejectHostAction({ kind: "task-complete", taskId: "task-1" } as RepoTaskAction, "invalid_proof", message);
  assert.equal(receipt.code, "invalid_proof");
  assert.equal(receipt.rejectionExplanation, message);
  assert.deepEqual(receipt.diagnostic, { kind: "failure", code: "invalid_proof" });
});

test("a host-rejected preset run keeps its coded message as the receipt explanation", () => {
  const message = "Repository repository-a is still warming up.",
    receipt = rejectPresetRun("run-1", "repo_warming", message);
  assert.equal(receipt.code, "repo_warming");
  assert.equal(receipt.rejectionExplanation, message);
});

test("local system binding uses the stable owner fallback when no POSIX UID exists", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-binding-fallback-"));
  try {
    const binding = localSystemBinding(rootDir),
      ownerUid = process.getuid?.() ?? 0;
    assert.equal(binding.source, "local");
    assert.equal(binding.authorizationBindingMode, "default");
    assert.equal(binding.actor.principal.personId, `local-user-${ownerUid}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Windows binding simulates a missing process.getuid without changing G2 authorization mode", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-binding-win32-")),
    originalGetuid = Object.getOwnPropertyDescriptor(process, "getuid"),
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const binding = localSystemBinding(rootDir);
    assert.equal(binding.actor.principal.personId, "local-user-0");
    assert.equal(binding.source, "local");
    assert.equal(binding.authorizationBindingMode, "default");
  } finally {
    if (originalGetuid === undefined) delete process.getuid;
    else Object.defineProperty(process, "getuid", originalGetuid);
    if (originalPlatform === undefined) delete process.platform;
    else Object.defineProperty(process, "platform", originalPlatform);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function systemRow(host: Awaited<ReturnType<typeof openDaemonHost>>, repoId: string): Record<string, unknown> {
  const system = host.system(auth) as { readonly repos: readonly Record<string, unknown>[] };
  const row = system.repos.find((repo) => repo.repoId === repoId);
  assert.ok(row, `gui-system-status must list ${repoId}`);
  return row;
}
async function waitControl(host: Awaited<ReturnType<typeof openDaemonHost>>, operationId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const receipt = host.controlReceipt(operationId, auth);
    if (receipt.phase === "settled" || receipt.phase === "failed") return receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`control ${operationId} did not settle`);
}

async function waitForRepoMaterialization(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  repoId: string,
  state: "ok" | "retrying" | "failed",
): Promise<RepoCellStatus> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const row = host.status().repos.find((repo) => repo.repoId === repoId);
    if (row?.materialization?.state === state) return row;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`repo ${repoId} materialization did not reach ${state}`);
}
