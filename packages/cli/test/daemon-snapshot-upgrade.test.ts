// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  runDaemonProductCommand,
  type DaemonControlLifecycle
} from "../src/commands/daemon/productization.ts";

const controlTarget = {
  repoId: "canonical",
  canonicalRoot: "/repo",
  userRoot: "/user-root",
  daemonId: "default",
  socketPath: "/user-root/daemon.sock",
  legacySocketPath: "/repo/legacy.sock",
  registered: true
} as const;

const runningLaunchConfiguration = {
  execPath: "/usr/bin/node",
  execArgv: ["--import", "tsx"],
  entrypoint: "/snapshots/release-1/dist/cli/src/index.js",
  args: ["--root", "/repo", "daemon", "serve", "--socket", "/user-root/daemon.sock"]
} as const;

test("daemon upgrade preserves explicit and omitted version arguments across the control wire", async () => {
  for (const scenario of [
    { args: ["--version", "stable-2026-07-22b"], expectedVersion: "stable-2026-07-22b" },
    { args: [], expectedVersion: undefined }
  ] as const) {
    let wirePayload: Record<string, unknown> | undefined;
    const result = await runCapturedUpgrade({
      target: controlTarget,
      prepareReplacement: async () => runningLaunchConfiguration,
      probeStatus: async () => undefined,
      ownerIsAlive: () => false,
      startReplacement: async () => v2DaemonStatus(84),
      wait: async () => undefined
    }, "/snapshots/selected/dist/cli/src/index.js", async (request) => {
      wirePayload = request.params.payload as Record<string, unknown>;
      return {
        schema: "daemon-control-accepted/v1",
        accepted: true,
        operationId: "control-upgrade",
        kind: "upgrade",
        before: { pid: 42, loadedIdentity: oldIdentity, launchConfiguration: runningLaunchConfiguration }
      };
    }, scenario.args);

    assert.equal(result.exitCode, 0, JSON.stringify(result.receipt));
    assert.equal(result.installedVersion, scenario.expectedVersion);
    assert.equal(result.receipt.kind, "upgrade");
    assert.equal(wirePayload?.kind, "upgrade");
    assert.equal(wirePayload?.trigger, "explicit");
  }
});

test("daemon upgrade switches to the installed snapshot only after drain handoff", async () => {
  const starts: string[] = [];
  const snapshotEntrypoint = "/user-root/daemon-snapshots/release-2/dist/cli/src/index.js";
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => undefined,
    ownerIsAlive: () => false,
    startReplacement: async (_target, _timeoutMs, launchConfiguration) => {
      starts.push(launchConfiguration.entrypoint);
      return v2DaemonStatus(84);
    },
    wait: async () => undefined
  }, snapshotEntrypoint);

  assert.equal(exitCode, 0, JSON.stringify(receipt));
  assert.deepEqual(starts, [snapshotEntrypoint]);
  const snapshot = receipt.snapshot as Record<string, unknown>;
  assert.equal(snapshot.entrypoint, snapshotEntrypoint);
  assert.equal(snapshot.installed, true);
});

test("daemon upgrade drain timeout leaves the old daemon serving and does not switch launch configuration", async () => {
  let replacementStarts = 0;
  let oldOwnerAlive = true;
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => v2DaemonStatus(42, oldIdentity),
    ownerIsAlive: () => oldOwnerAlive,
    startReplacement: async () => {
      replacementStarts += 1;
      return v2DaemonStatus(84);
    },
    wait: async () => undefined
  }, "/snapshots/release-timeout/dist/cli/src/index.js", async () => {
    oldOwnerAlive = true;
    throw new Error("daemon_queue_drain_timeout: in-flight journal write retained");
  });

  assert.equal(exitCode, 1);
  assert.equal(replacementStarts, 0);
  assert.equal(oldOwnerAlive, true);
  assert.match(controlErrorHint(receipt), /daemon_queue_drain_timeout/u);
});

test("daemon upgrade rolls back to the previous snapshot when new snapshot health verification fails", async () => {
  const starts: string[] = [];
  const stoppedPids: number[] = [];
  const snapshotEntrypoint = "/snapshots/release-bad/dist/cli/src/index.js";
  let endpointProbe = 0;
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => {
      endpointProbe += 1;
      return undefined;
    },
    ownerIsAlive: () => false,
    startReplacement: async (_target, _timeoutMs, launchConfiguration) => {
      starts.push(launchConfiguration.entrypoint);
      return launchConfiguration.entrypoint === snapshotEntrypoint
        ? v2DaemonStatus(84, oldIdentity)
        : v2DaemonStatus(85, oldIdentity);
    },
    stopReplacement: async (_target, pid) => { stoppedPids.push(pid); },
    wait: async () => undefined
  }, snapshotEntrypoint);

  assert.equal(exitCode, 1);
  assert.deepEqual(starts, [snapshotEntrypoint, runningLaunchConfiguration.entrypoint]);
  assert.deepEqual(stoppedPids, [84]);
  assert.ok(endpointProbe >= 2);
  assert.match(controlErrorHint(receipt), /previous snapshot restored and authority converged/u);
});

test("daemon upgrade stops a wrong-snapshot handoff occupant and retries with bounded evidence", async () => {
  const activeOwners = new Set<number>([59096]);
  const starts: string[] = [];
  const stoppedPids: number[] = [];
  let maximumOwners = activeOwners.size;
  let probe = 0;
  const snapshotEntrypoint = "/snapshots/stable-2026-07-22/dist/cli/src/index.js";
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => {
      probe += 1;
      if (probe === 1) return v2DaemonStatus(59096, oldIdentity);
      return undefined;
    },
    ownerIsAlive: () => false,
    startReplacement: async (_target, _timeoutMs, launchConfiguration) => {
      assert.equal(activeOwners.size, 0, "the competing owner must exit before snapshot startup");
      starts.push(launchConfiguration.entrypoint);
      activeOwners.add(84);
      maximumOwners = Math.max(maximumOwners, activeOwners.size);
      return v2DaemonStatus(84);
    },
    stopReplacement: async (_target, pid) => {
      assert.deepEqual([...activeOwners], [pid]);
      activeOwners.delete(pid);
      stoppedPids.push(pid);
    },
    wait: async () => undefined
  }, snapshotEntrypoint, undefined, ["--version", "stable-2026-07-22"]);

  assert.equal(exitCode, 0, JSON.stringify(receipt));
  assert.equal(maximumOwners, 1, "handoff must retain the single-owner invariant");
  assert.deepEqual(stoppedPids, [59096]);
  assert.deepEqual(starts, [snapshotEntrypoint]);
  const replacement = receipt.replacement as {
    readonly handoffRecovery: {
      readonly maxAttempts: number;
      readonly attemptsUsed: number;
      readonly retryCount: number;
      readonly attempts: ReadonlyArray<Record<string, unknown>>;
    };
  };
  assert.deepEqual(replacement.handoffRecovery, {
    maxAttempts: 3,
    attemptsUsed: 2,
    retryCount: 1,
    attempts: [{
      attempt: 1,
      occupantPid: 59096,
      loadedIdentity: oldIdentity,
      expectedSnapshotIdentity: newIdentity,
      disposition: "stopped-and-retrying"
    }]
  });
});

test("daemon upgrade retries when cleanup proves a new wrong-snapshot successor took the endpoint", async () => {
  const probeStatuses = [
    v2DaemonStatus(59095, oldIdentity),
    v2DaemonStatus(59096, oldIdentity),
    v2DaemonStatus(59096, oldIdentity),
    undefined
  ];
  const stoppedPids: number[] = [];
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => probeStatuses.shift(),
    ownerIsAlive: () => false,
    startReplacement: async () => v2DaemonStatus(84),
    stopReplacement: async (_target, pid) => {
      stoppedPids.push(pid);
      if (pid === 59095) throw new Error("target endpoint became reachable again with pid 59096");
    },
    wait: async () => undefined
  }, "/snapshots/stable-2026-07-22/dist/cli/src/index.js");

  assert.equal(exitCode, 0, JSON.stringify(receipt));
  assert.deepEqual(stoppedPids, [59095, 59096]);
  const recovery = ((receipt.replacement as Record<string, unknown>).handoffRecovery) as {
    readonly attemptsUsed: number;
    readonly retryCount: number;
    readonly attempts: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(recovery.attemptsUsed, 3);
  assert.equal(recovery.retryCount, 2);
  assert.deepEqual(recovery.attempts[0], {
    attempt: 1,
    occupantPid: 59095,
    loadedIdentity: oldIdentity,
    expectedSnapshotIdentity: newIdentity,
    disposition: "stopped-successor-detected",
    cleanupFailure: "target endpoint became reachable again with pid 59096",
    successorPid: 59096
  });
});

test("daemon upgrade exhausts wrong-snapshot retries fail-closed with every disposition in the receipt", async () => {
  const occupantPids = [59096, 59097, 59098];
  let probe = 0;
  const stoppedPids: number[] = [];
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: controlTarget,
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => v2DaemonStatus(occupantPids[probe++]!, oldIdentity),
    ownerIsAlive: () => false,
    startReplacement: async () => {
      throw new Error("an occupied endpoint must not start the snapshot replacement");
    },
    stopReplacement: async (_target, pid) => { stoppedPids.push(pid); },
    wait: async () => undefined
  }, "/snapshots/stable-2026-07-22/dist/cli/src/index.js", undefined, [
    "--version", "stable-2026-07-22"
  ]);

  assert.equal(exitCode, 1);
  assert.deepEqual(stoppedPids, occupantPids);
  const hint = controlErrorHint(receipt);
  assert.match(hint, /DAEMON_UPGRADE_HANDOFF_RETRIES_EXHAUSTED/u);
  assert.match(hint, /Retry exactly with: ha daemon upgrade --timeout-ms 100 --version stable-2026-07-22/u);
  const evidenceMatch = /Handoff recovery evidence: (\{.+\})$/u.exec(hint);
  assert.ok(evidenceMatch);
  assert.deepEqual(JSON.parse(evidenceMatch[1]!) as Record<string, unknown>, {
    maxAttempts: 3,
    attemptsUsed: 3,
    retryCount: 3,
    attempts: occupantPids.map((occupantPid, index) => ({
      attempt: index + 1,
      occupantPid,
      loadedIdentity: oldIdentity,
      expectedSnapshotIdentity: newIdentity,
      disposition: index === 2 ? "stopped-retry-exhausted" : "stopped-and-retrying"
    }))
  });
});

test("daemon upgrade custom-socket failure does not claim the default stop command is precise", async () => {
  const customEndpoint = "/tmp/custom daemon.sock";
  const { exitCode, receipt } = await runCapturedUpgrade({
    target: { ...controlTarget, socketPath: customEndpoint },
    prepareReplacement: async () => runningLaunchConfiguration,
    probeStatus: async () => v2DaemonStatus(59096, oldIdentity),
    ownerIsAlive: () => false,
    startReplacement: async () => {
      throw new Error("an occupied endpoint must not start the snapshot replacement");
    },
    stopReplacement: async () => { throw new Error("endpoint owner did not exit"); },
    wait: async () => undefined
  }, "/snapshots/stable-2026-07-22/dist/cli/src/index.js", undefined, [
    "--version", "stable-2026-07-22", "--socket", customEndpoint
  ]);

  const hint = controlErrorHint(receipt);
  assert.equal(exitCode, 1);
  assert.doesNotMatch(hint, /ha daemon stop --user-root/u);
  assert.match(hint, /ha daemon stop does not target custom endpoint '\/tmp\/custom daemon\.sock'/u);
  assert.match(hint, /retry exactly with: ha daemon upgrade .* --socket '\/tmp\/custom daemon\.sock'/u);
});

const oldIdentity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function runCapturedUpgrade(
  daemonControlLifecycle: DaemonControlLifecycle,
  snapshotEntrypoint: string,
  requestDaemonControl: ((request: { readonly method: string; readonly params: Record<string, unknown> }) => Promise<Record<string, unknown>>) | undefined = undefined,
  extraArgs: ReadonlyArray<string> = []
): Promise<{ readonly exitCode: number; readonly receipt: Record<string, unknown>; readonly installedVersion: string | undefined }> {
  let installedVersion: string | undefined;
  requestDaemonControl ??= async () => ({
    schema: "daemon-control-accepted/v1",
    accepted: true,
    operationId: "control-upgrade",
    kind: "upgrade",
    before: { pid: 42, loadedIdentity: oldIdentity, launchConfiguration: runningLaunchConfiguration }
  });
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => output.push(String(message));
  try {
    const exitCode = await runDaemonProductCommand({
      rootDir: "/repo",
      json: true,
      args: ["daemon", "upgrade", "--timeout-ms", "100", ...extraArgs],
      runServe: async () => undefined,
      requestDaemonControl,
      daemonControlLifecycle,
      installDaemonSnapshot: (installInput) => {
        installedVersion = installInput.version;
        return {
          installed: true,
          snapshotDir: path.dirname(path.dirname(path.dirname(path.dirname(snapshotEntrypoint)))),
          entrypoint: snapshotEntrypoint,
          manifestPath: "/snapshots/manifest.json",
          manifest: {
            schema: "daemon-snapshot-manifest/v1",
            version: "test",
            sourceRef: "HEAD",
            sourceCommit: "a".repeat(40),
            sourceDirty: false,
            sourceFingerprint: "a".repeat(40),
            builtAt: "2026-07-22T00:00:00.000Z",
            entrypoint: "dist/cli/src/index.js",
            contentFingerprint: "sha256:" + "b".repeat(64),
            artifactFileCount: 1,
            runtimePackages: []
          }
        };
      },
      daemonSourceEntrypoint: () => "/repo/packages/cli/src/index.ts",
      calculateInstalledIdentity: () => "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    });
    return { exitCode, receipt: JSON.parse(output.at(-1) ?? "") as Record<string, unknown>, installedVersion };
  } finally {
    console.log = originalLog;
  }
}

function controlErrorHint(receipt: Record<string, unknown>): string {
  const error = receipt.error;
  return typeof error === "object" && error !== null && "hint" in error ? String(error.hint) : "";
}

function v2DaemonStatus(pid: number, loadedIdentity = newIdentity): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid,
      build: { loadedIdentity, installedIdentity: loadedIdentity },
      activeControl: null
    }
  };
}

const newIdentity = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
