// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DAEMON_ATTACH_TIMEOUT_ENV, MAX_DAEMON_ATTACH_TIMEOUT_MS } from "../src/daemon-host/attach-timeout.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { daemonPidPath, daemonSingletonLockPath } from "../src/daemon-host/daemon-singleton.ts";
import { daemonLifecycleLogPath, readDaemonLifecycleGeneration } from "../src/daemon-host/lifecycle-log.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import {
  openBootstrappedRepoCell as openRepoCell,
  registerBootstrappedDaemonRepo as registerDaemonRepo,
} from "./repo-settings.fixture.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { eventually } from "./fixtures/runtime-ingress.ts";
import { waitForArrival, watchFileArrival } from "../../../tools/fixtures/event-arrival.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
  signInPolicyTestUser(userRoot, "writer", ["aaa-hung", "zzz-live"], "admin");
  const hungOpens: Array<{
    readonly resolve: (cell: Awaited<ReturnType<typeof openRepoCell>>) => void;
    readonly reject: (error: Error) => void;
    settled: boolean;
  }> = [];
  const liveCell = await openRepoCell({
    repoId: workspaceId("zzz-live"),
    rootDir: canonicalRoot(live),
    ownerId: "attach-budget",
  });
  const openCell: typeof openRepoCell = async (cellInput) =>
    cellInput.repoId === workspaceId("aaa-hung")
      ? new Promise((resolve, reject) => {
          hungOpens.push({ resolve, reject, settled: false });
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
          record.event === "repo_attach_timed_out" &&
          record.repoId === "aaa-hung" &&
          record.rootDir === canonicalRoot(hung) &&
          record.durationMs === 2_000,
      ),
      true,
      `expected repo_attach_timed_out with rootDir=${canonicalRoot(hung)}, got ${JSON.stringify(records)}`,
    );
    assert.equal(
      host.status().repos.filter((repo) => repo.repoId === "aaa-hung").length,
      1,
      "timed-out open must latch a single unavailable status row",
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
    hungOpens[0]!.settled = true;
    hungOpens[0]!.resolve(
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
    for (const pending of hungOpens)
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(new Error("test cleanup"));
      }
    await host.close();
    removeTempRepository(parent);
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
  signInPolicyTestUser(userRoot, "writer", ["disable-attach"], "admin");
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
    assert.equal(
      (await host.admin({ kind: "update", repoId: "disable-attach", state: "disabled" }, auth)).outcome,
      "applied",
    );
    // The gated open is still parked, so reaching this line already proves disable did not wait
    // for it. A wall-clock budget here only measured CI scheduling delay, not that property.
    assert.equal(
      records.some((record) => record.event === "repo_attach_completed" || record.event === "repo_attach_discarded"),
      false,
      "disable must not wait for the in-flight attach",
    );
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
    assert.equal(host.status().repos.find((repo) => repo.repoId === "disable-attach")?.state, "closed");
    // Re-enabling is unaffected: the next registry refresh opens a fresh Cell and serves writes.
    // That open runs under the same 2s attach budget. Losing it is the designed unavailable latch:
    // the open keeps running and performOpenRegistered publishes the Cell when it completes, so
    // wait for the published attach instead of sampling the state at the budget boundary.
    assert.equal(
      (await host.admin({ kind: "update", repoId: "disable-attach", state: "enabled" }, auth)).outcome,
      "applied",
    );
    await eventually(() => host.status().repos.find((repo) => repo.repoId === "disable-attach")?.state === "attached");
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
    removeTempRepository(parent);
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
  signInPolicyTestUser(userRoot, "writer", ["mode-attach"], "admin");
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
    // The probe starts recovery, which may finish after the attach budget expires.
    await host.run("mode-attach", { kind: "settings-read" }, auth);
    await eventually(() => host.status().repos.find((repo) => repo.repoId === "mode-attach")?.state === "attached");
    // Public reads of the recovered edge still require its own replica.
    const read = await host.run("mode-attach", { kind: "settings-read" }, auth);
    assert.equal(read.outcome, "op_rejected", JSON.stringify(read));
    assert.equal(read.code, "replica_unavailable", JSON.stringify(read));
    assert.equal(host.status().repos.find((repo) => repo.repoId === "mode-attach")?.state, "attached");
    assert.equal(host.status().repos.find((repo) => repo.repoId === "mode-attach")?.mode, "remote-edge");
    assert.equal((await host.run("mode-attach", { kind: "task-list" }, auth)).code, "replica_unavailable");
    assert.equal(
      (await host.run("mode-attach", { kind: "task-create", taskId: "task_mode_attach", title: "Mode attach" }, auth))
        .code,
      "fleet_edge_config_invalid",
    );
  } finally {
    await host.close();
    removeTempRepository(parent);
  }
});

test("startDaemon and openDaemonHost reject invalid attachTimeoutMs fail-closed without claiming locks", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-attach-timeout-invalid-")),
    daemonId = "invalid-budget";
  try {
    for (const invalid of [0, -1, 1.5, Number.NaN, MAX_DAEMON_ATTACH_TIMEOUT_MS + 1]) {
      await assert.rejects(
        () => startDaemon({ daemonId, userRoot, attachTimeoutMs: invalid }),
        /Invalid attachTimeoutMs/u,
      );
      await assert.rejects(
        () => openDaemonHost({ daemonId, userRoot, attachTimeoutMs: invalid }),
        /Invalid attachTimeoutMs/u,
      );
    }
    assert.equal(existsSync(daemonPidPath(userRoot, daemonId)), false);
    assert.equal(existsSync(daemonSingletonLockPath(userRoot, daemonId)), false);
  } finally {
    removeTempRepository(userRoot);
  }
});

test(
  "daemon bin entrypoint forwards HARNESS_DAEMON_ATTACH_TIMEOUT_MS and --attach-timeout-ms to live attach budget",
  { timeout: 60_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-bin-attach-budget-")),
      binEntry = path.resolve(import.meta.dirname, "../src/daemon-host/bin.ts"),
      hook = path.join(parent, "hang-repo-cell-open.mjs");
    writeFileSync(
      hook,
      `
      import { registerHooks } from "node:module";
      registerHooks({
        load(url, context, next) {
          if (/\\/repo-cell-open\\.(?:ts|js)$/.test(new URL(url).pathname)) {
            return {
              format: "module",
              shortCircuit: true,
              source: "export function openRepoCell() { return new Promise(() => {}); }",
            };
          }
          return next(url, context);
        },
      });
    `,
      "utf8",
    );
    try {
      for (const scenario of [
        {
          daemonId: "env-budget",
          extraArgs: [] as string[],
          envValue: "250",
          expectedMs: 250,
        },
        {
          daemonId: "flag-budget",
          extraArgs: ["--attach-timeout-ms", "300"],
          envValue: "900000",
          expectedMs: 300,
        },
      ]) {
        const userRoot = path.join(parent, `user-${scenario.daemonId}`),
          repoRoot = path.join(parent, `repo-${scenario.daemonId}`),
          lifecyclePath = daemonLifecycleLogPath(userRoot, scenario.daemonId);
        rosterRepo(repoRoot, "hung-repo");
        registerDaemonRepo({ canonicalRoot: repoRoot, repoId: "hung-repo", userRoot, createConvenienceLinks: false });
        const childEnv = { ...process.env };
        delete childEnv.HARNESS_ACTOR;
        childEnv[DAEMON_ATTACH_TIMEOUT_ENV] = scenario.envValue;
        childEnv.NODE_OPTIONS = `--import=${pathToFileURL(hook).href}`;
        let stderr = "";
        const child: ChildProcess = spawn(
          process.execPath,
          [binEntry, "serve", "--user-root", userRoot, "--daemon-id", scenario.daemonId, ...scenario.extraArgs],
          { env: childEnv, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
        );
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        try {
          const timedOut = await waitForArrival(
            () => {
              if (child.exitCode !== null)
                assert.fail(`daemon exited prematurely (${child.exitCode}) for ${scenario.daemonId}: ${stderr}`);
              return (
                readDaemonLifecycleGeneration(userRoot, scenario.daemonId).find(
                  (record) => record.event === "repo_attach_timed_out" && record.repoId === "hung-repo",
                ) ?? null
              );
            },
            (arrive) => {
              const unwatch = watchFileArrival(lifecyclePath)(arrive);
              child.once("exit", arrive);
              return () => {
                child.off("exit", arrive);
                unwatch();
              };
            },
          );
          assert.equal(timedOut.durationMs, scenario.expectedMs, `${scenario.daemonId}: ${JSON.stringify(timedOut)}`);
          assert.equal(
            timedOut.rootDir,
            canonicalRoot(repoRoot),
            `${scenario.daemonId}: repo_attach_timed_out must carry rootDir`,
          );
        } finally {
          if (child.exitCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        }
      }
    } finally {
      removeTempRepository(parent);
    }
  },
);

test("repo attach publishes repo_attach_completed without waiting for a blocked schedule refresh", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-attach-scheduler-")),
    userRoot = path.join(parent, "user"),
    repoRoot = path.join(parent, "repo"),
    records: Record<string, unknown>[] = [],
    staleClaimFence = "claim_stale_builtin_backup";
  rosterRepo(repoRoot, "sched-blocked");
  signInPolicyTestUser(userRoot, "writer", ["sched-blocked"], "admin");

  let announceBuiltinCheck!: (claimFence: string) => void;
  let releaseBuiltinCheck!: (alive: boolean) => void;
  const builtinCheckStarted = new Promise<string>((resolve) => {
    announceBuiltinCheck = resolve;
  });
  const builtinCheckGate = new Promise<boolean>((resolve) => {
    releaseBuiltinCheck = resolve;
  });
  let builtinCheckResolved = false;

  const realCell = await openRepoCell({
    repoId: workspaceId("sched-blocked"),
    rootDir: canonicalRoot(repoRoot),
    ownerId: "attach-scheduler",
  });
  const openCell: typeof openRepoCell = async () => ({
    ...realCell,
    run: async (action, binding, signal) => {
      if (action.kind === "schedule-list")
        return {
          schema: "command-receipt/v2",
          ok: true,
          command: "schedule-list",
          outcome: "applied",
          evidence: "schedule-list:1",
          schedules: [
            {
              scheduleId: "builtin-ledger-backup",
              state: "paused",
              mode: "detect",
              definitionRevision: 1,
              updatedAt: "2026-09-10T00:00:00.000Z",
              nextRunAt: null,
              spec: {
                title: "Ledger backup",
                trigger: { kind: "interval", everyMs: 60_000, anchorAt: "2026-09-10T00:00:00.000Z" },
                target: { kind: "builtin", builtinId: "ledger-backup" },
              },
              status: {
                automaticEvaluatedThrough: "2026-09-10T00:00:00.000Z",
                activeRun: {
                  claimFence: staleClaimFence,
                  scheduledFor: "2026-09-10T00:00:00.000Z",
                  startedAt: "2026-09-10T00:00:00.000Z",
                },
              },
            },
          ],
        } as Awaited<ReturnType<typeof realCell.run>>;
      return realCell.run(action, binding, signal);
    },
    hasBuiltinExecutor: async (claimFence) => {
      announceBuiltinCheck(claimFence);
      const alive = await builtinCheckGate;
      builtinCheckResolved = true;
      return alive;
    },
  });

  const host = await openDaemonHost({
    daemonId: "attach-scheduler",
    userRoot,
    attachTimeoutMs: 500,
    openCell,
    recordLifecycle: (record) => records.push(record),
  });
  try {
    // Mirror `daemon start` followed by `daemon repo register`: scheduler is already started.
    await host.attachmentsSettled();
    const registered = await host.admin({ kind: "register", repoId: "sched-blocked", rootDir: repoRoot }, auth);
    assert.equal(registered.outcome, "applied", JSON.stringify(registered));
    assert.equal(builtinCheckResolved, false, "attach must return before blocked scheduler refresh finishes");
    assert.equal(
      records.some(
        (record) =>
          record.event === "repo_attach_completed" &&
          record.repoId === "sched-blocked" &&
          record.rootDir === canonicalRoot(repoRoot),
      ),
      true,
      `expected repo_attach_completed, got ${JSON.stringify(records)}`,
    );
    assert.equal(
      records.some((record) => record.event === "repo_attach_timed_out" && record.repoId === "sched-blocked"),
      false,
      `blocked scheduler refresh must not trip attach timeout: ${JSON.stringify(records)}`,
    );
    const matchingRows = host.status().repos.filter((repo) => repo.repoId === "sched-blocked");
    assert.equal(
      matchingRows.length,
      1,
      `must not emit duplicate attached+unavailable rows: ${JSON.stringify(matchingRows)}`,
    );
    assert.equal(matchingRows[0]?.state, "attached");
    assert.equal(await builtinCheckStarted, staleClaimFence, "scheduler refresh must still run asynchronously");
  } finally {
    releaseBuiltinCheck(true);
    await host.close();
    removeTempRepository(parent);
  }
});
