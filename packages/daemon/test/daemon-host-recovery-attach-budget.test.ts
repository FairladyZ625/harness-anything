// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
} from "./repo-settings.fixture.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";

test("a repository whose open never settles is bounded by an attach budget while the rest attach and serve", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-attach-budget-")),
    userRoot = path.join(parent, "user"),
    hung = path.join(parent, "aaa-hung"),
    live = path.join(parent, "zzz-live"),
    records: Record<string, unknown>[] = [];
  rosterRepo(hung, "aaa-hung");
  rosterRepo(live, "zzz-live");
  registerDaemonRepo({ canonicalRoot: hung, repoId: "aaa-hung", userRoot, createConvenienceLinks: false });
  registerDaemonRepo({ canonicalRoot: live, repoId: "zzz-live", userRoot, createConvenienceLinks: false });
  const hungOpens: Array<(cell: Awaited<ReturnType<typeof openRepoCell>>) => void> = [];
  const liveCell = await openRepoCell({
    repoId: workspaceId("zzz-live"),
    rootDir: canonicalRoot(live),
    ownerId: "attach-budget",
  });
  const openCell: typeof openRepoCell = async (cellInput) =>
    cellInput.repoId === workspaceId("aaa-hung")
      ? new Promise((resolve) => {
          hungOpens.push(resolve);
        })
      : liveCell;
  const host = await openDaemonHost({
    daemonId: "attach-budget",
    userRoot,
    attachTimeoutMs: 2_000,
    openCell,
    recordLifecycle: (record) => records.push(record),
  });
  try {
    await host.attachmentsSettled();
    assert.equal(
      records.some(
        (record) =>
          record.event === "repo_attach_timed_out" && record.repoId === "aaa-hung" && record.durationMs === 2_000,
      ),
      true,
    );
    assert.equal(
      records.some(
        (record) => record.event === "attachments_settled" && record.attached === 1 && record.unavailable === 1,
      ),
      true,
    );
    const latched = host.status().repos.find((repo) => repo.repoId === "aaa-hung")!;
    assert.equal(latched.state, "unavailable");
    assert.match(String(latched.lastError), /did not finish attaching within 2000ms/u);
    assert.equal((await host.run("aaa-hung", { kind: "task-list" }, auth)).code, "repo_unavailable");
    assert.equal((await host.run("zzz-live", { kind: "task-list" }, auth)).outcome, "applied");
    hungOpens[0]!(
      await openRepoCell({ repoId: workspaceId("aaa-hung"), rootDir: canonicalRoot(hung), ownerId: "attach-budget" }),
    );
    for (
      let attempt = 0;
      attempt < 100 && host.status().repos.find((repo) => repo.repoId === "aaa-hung")?.state !== "attached";
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      host.status().repos.find((repo) => repo.repoId === "aaa-hung")?.state,
      "attached",
      "a late open completion must heal the timed-out latch",
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

// The registry row is the only authority at publication time. Both cases below hang the very
// first openCell so the registry can be changed while the attach is genuinely in flight, then
// hand the host a real Cell (holding the workspace writer lock) as the late completion.
function gateFirstOpen(repoId: string): {
  readonly openCell: typeof openRepoCell;
  readonly release: (cell: Awaited<ReturnType<typeof openRepoCell>>) => Promise<void>;
} {
  type Resolve = (cell: Awaited<ReturnType<typeof openRepoCell>>) => void;
  let gated = false,
    announce!: (resolve: Resolve) => void;
  const arrived = new Promise<Resolve>((resolve) => {
    announce = resolve;
  });
  return {
    openCell: async (cellInput) => {
      if (cellInput.repoId !== workspaceId(repoId) || gated) return openRepoCell(cellInput);
      gated = true;
      return new Promise((resolve) => {
        announce(resolve);
      });
    },
    release: async (cell) => {
      (await arrived)(cell);
    },
  };
}

test("a disabled repository is not resurrected by its in-flight attach landing late", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-disable-attach-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    records: Record<string, unknown>[] = [];
  rosterRepo(rootDir, "disable-attach");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId: "disable-attach", userRoot, createConvenienceLinks: false });
  const root = canonicalRoot(rootDir),
    lockPath = `${root}.harness-anything-writer.lock`,
    gate = gateFirstOpen("disable-attach"),
    host = await openDaemonHost({
      daemonId: "disable-attach",
      userRoot,
      attachTimeoutMs: 2_000,
      openCell: gate.openCell,
      recordLifecycle: (record) => records.push(record),
    });
  try {
    await host.attachmentsSettled(); // the attach budget expires; the underlying open is still hung
    const started = performance.now(),
      disabled = await host.admin({ kind: "update", repoId: "disable-attach", state: "disabled" }, auth),
      elapsedMs = performance.now() - started;
    assert.equal(disabled.outcome, "applied");
    assert.ok(elapsedMs < 1_000, `disable must not wait for the in-flight attach: ${elapsedMs.toFixed(1)}ms`);
    // The late completion is a real Cell: it owns a writer worker and the workspace lock.
    const late = await openRepoCell({
      repoId: workspaceId("disable-attach"),
      rootDir: root,
      ownerId: "disable-attach",
    });
    assert.equal(existsSync(lockPath), true, "the late Cell must really hold the workspace writer lock");
    await gate.release(late);
    for (
      let attempt = 0;
      attempt < 500 && !records.some((record) => record.event === "repo_attach_discarded");
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      records.some((record) => record.event === "repo_attach_discarded" && record.repoId === "disable-attach"),
      true,
      "a disabled repo's late attach must record a discard terminal",
    );
    assert.equal(
      records.some((record) => record.event === "repo_attach_completed" && record.repoId === "disable-attach"),
      false,
      "a disabled repo must never publish an attach",
    );
    assert.equal(late.status().state, "closed", "the discarded Cell must be closed, not just dropped from the map");
    assert.equal(existsSync(lockPath), false, "the discarded attach must release the workspace writer lock");
    assert.equal(
      host.status().repos.some((repo) => repo.repoId === "disable-attach"),
      false,
    );
    // Re-enabling is unaffected: the next registry refresh opens a fresh Cell and serves writes.
    assert.equal(
      (await host.admin({ kind: "update", repoId: "disable-attach", state: "enabled" }, auth)).outcome,
      "applied",
    );
    assert.equal(host.status().repos.find((repo) => repo.repoId === "disable-attach")?.state, "attached");
    assert.equal(
      (
        await host.run(
          "disable-attach",
          { kind: "task-create", taskId: "task_disable_attach", title: "Disable attach" },
          auth,
        )
      ).outcome,
      "applied",
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an attach that lands after its registration changed mode is discarded and reopens in the new mode", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-mode-attach-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    records: Record<string, unknown>[] = [];
  let clock = "2026-09-10T00:00:00.000Z";
  rosterRepo(rootDir, "mode-attach");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "mode-attach",
    mode: "local",
    userRoot,
    createConvenienceLinks: false,
  });
  const root = canonicalRoot(rootDir),
    lockPath = `${root}.harness-anything-writer.lock`,
    gate = gateFirstOpen("mode-attach"),
    host = await openDaemonHost({
      daemonId: "mode-attach",
      userRoot,
      attachTimeoutMs: 2_000,
      openCell: gate.openCell,
      now: () => clock,
      recordLifecycle: (record) => records.push(record),
    });
  try {
    await host.attachmentsSettled();
    assert.equal(
      (await host.admin({ kind: "update", repoId: "mode-attach", mode: "remote-edge" }, auth)).outcome,
      "applied",
    );
    const late = await openRepoCell({ repoId: workspaceId("mode-attach"), rootDir: root, ownerId: "mode-attach" });
    assert.equal(existsSync(lockPath), true);
    await gate.release(late);
    for (
      let attempt = 0;
      attempt < 500 && !records.some((record) => record.event === "repo_attach_discarded");
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      records.some((record) => record.event === "repo_attach_discarded" && record.repoId === "mode-attach"),
      true,
    );
    assert.equal(
      records.some((record) => record.event === "repo_attach_completed" && record.repoId === "mode-attach"),
      false,
      "a stale-mode attach must not publish",
    );
    assert.equal(late.status().state, "closed");
    assert.equal(existsSync(lockPath), false);
    const latched = host.status().repos.find((repo) => repo.repoId === "mode-attach")!;
    assert.equal(latched.state, "unavailable");
    assert.match(String(latched.lastError), /changed registration while it was attaching/u);
    assert.equal(latched.causeClass, "infrastructure");
    // Past the reprobe throttle the still-enabled repo reopens under the registry's current mode.
    clock = "2026-09-10T00:00:30.000Z";
    assert.equal((await host.run("mode-attach", { kind: "task-list" }, auth)).outcome, "applied");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "mode-attach")?.mode, "remote-edge");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
