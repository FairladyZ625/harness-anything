// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { localUserDaemonEndpoint, requestLocalDaemonJsonRpc } from "../../daemon/src/index.ts";
import { readDaemonRegistry } from "../../kernel/src/index.ts";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";
import { initializeHarness } from "../src/commands/init.ts";

const DAEMON_REFRESH_TEST_TIMEOUT_MS = positiveIntegerEnv("HARNESS_TEST_DAEMON_REFRESH_TIMEOUT_MS", 180_000);
const DAEMON_REFRESH_AUTOSTART_TIMEOUT_MS = positiveIntegerEnv("HARNESS_TEST_DAEMON_REFRESH_AUTOSTART_TIMEOUT_MS", 20_000);
const DAEMON_REFRESH_CONTROL_TIMEOUT_MS = positiveIntegerEnv("HARNESS_TEST_DAEMON_REFRESH_CONTROL_TIMEOUT_MS", 10_000);
const DAEMON_REFRESH_REQUEST_TIMEOUT_MS = positiveIntegerEnv("HARNESS_TEST_DAEMON_REFRESH_REQUEST_TIMEOUT_MS", 90_000);

test("refresh derives and preflight failure scenarios share one isolated service fixture", { timeout: DAEMON_REFRESH_TEST_TIMEOUT_MS }, async (t) => {
  const fixtureTiming = new RefreshTestTiming("shared-fixture");
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const classicRoot = path.join(fixture.root, "classic-repo");
  const preflightDelayMarker = path.join(fixture.root, "refresh-preflight-delay.marker");
  const preflightDelayMs = positiveIntegerEnv("HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_DELAY_MS", 0);
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: String(DAEMON_REFRESH_AUTOSTART_TIMEOUT_MS),
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: String(DAEMON_REFRESH_REQUEST_TIMEOUT_MS),
    ...(preflightDelayMs > 0 ? {
      HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_DELAY_MS: String(preflightDelayMs),
      HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_DELAY_MARKER: preflightDelayMarker
    } : {})
  };
  const validManifest = readFileSync(fixture.manifestPath, "utf8");
  try {
    const registered = fixtureTiming.measure("register", () => runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register",
      "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot,
      "--no-link",
      "--json"
    ], env));
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const started = fixtureTiming.measure("daemon-start", () => runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service",
      "--authority-manifest", fixture.manifestPath,
      "--json"
    ], env));
    assert.equal(started.started, true, JSON.stringify(started));
    const launchReceipt = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      {},
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const launchDetails = launchReceipt.details as Record<string, unknown>;
    const launchSpec = launchDetails.data as { readonly args?: ReadonlyArray<string> };
    const manifestIndex = launchSpec.args?.indexOf("--authority-manifest") ?? -1;
    assert.notEqual(manifestIndex, -1, JSON.stringify(launchSpec));
    assert.equal(launchSpec.args?.[manifestIndex + 1], fixture.manifestPath);

    await t.test("refresh preflight reports the real manifest failure and leaves the running daemon unchanged", async () => {
      const timing = new RefreshTestTiming("preflight-failure");
      const before = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
      assert.equal(before.reachable, true, JSON.stringify(before));
      assert.equal(typeof before.pid, "number");
      try {
        writeFileSync(fixture.manifestPath, "{}\n", "utf8");
        const refresh = timing.measure("preflight", () => runRawJsonMaybeFail(fixture.repoRoot, [
          "daemon", "refresh",
          "--trigger", "post-merge",
          "--timeout-ms", String(DAEMON_REFRESH_CONTROL_TIMEOUT_MS),
          "--user-root", userRoot
        ], env));
        assert.notEqual(refresh.status, 0, JSON.stringify(refresh.receipt));
        assert.match(JSON.stringify(refresh.receipt), /AUTHORITY_PRODUCTION_MANIFEST_SCHEMA_INVALID/u);
        assert.doesNotMatch(JSON.stringify(refresh.receipt), /did not become reachable/u);

        const after = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
        assert.equal(after.reachable, true, JSON.stringify(after));
        assert.equal(after.pid, before.pid);
        process.kill(before.pid as number, 0);
        console.log(JSON.stringify({ scenario: "preflight-failure", beforePid: before.pid, afterPid: after.pid, reachable: after.reachable, refresh: refresh.receipt }));
      } finally {
        writeFileSync(fixture.manifestPath, validManifest, "utf8");
        timing.report();
      }
    });

    await t.test("restart preflight reports the real manifest failure and leaves the running daemon unchanged", async () => {
      const before = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
      assert.equal(before.reachable, true, JSON.stringify(before));
      assert.equal(typeof before.pid, "number");
      try {
        writeFileSync(fixture.manifestPath, "{}\n", "utf8");
        const restart = runRawJsonMaybeFail(fixture.repoRoot, [
          "daemon", "restart",
          "--timeout-ms", String(DAEMON_REFRESH_CONTROL_TIMEOUT_MS),
          "--user-root", userRoot
        ], env);
        assert.notEqual(restart.status, 0, JSON.stringify(restart.receipt));
        assert.match(JSON.stringify(restart.receipt), /AUTHORITY_PRODUCTION_MANIFEST_SCHEMA_INVALID/u);
        assert.doesNotMatch(JSON.stringify(restart.receipt), /FAILED_AFTER_HANDOFF/u);

        const after = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
        assert.equal(after.reachable, true, JSON.stringify(after));
        assert.equal(after.pid, before.pid);
        process.kill(before.pid as number, 0);
      } finally {
        writeFileSync(fixture.manifestPath, validManifest, "utf8");
      }
    });

    await t.test("refresh derives the explicit manifest across a mixed registry and converges on a ready replacement", async () => {
      const timing = new RefreshTestTiming("derived-manifest-refresh");
      const before = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
      assert.equal(typeof before.pid, "number");

      mkdirSync(classicRoot, { recursive: true });
      initializeHarness({ rootDir: classicRoot }, false, "Classic");
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "repo", "register", "--repo-id", "classic",
        "--canonical-root", classicRoot, "--user-root", userRoot, "--no-link", "--json"
      ], env);
      const registry = readDaemonRegistry({ userRoot });
      assert.equal(registry.repos.find((repo) => repo.repoId === "canonical")?.authorityManifestPath, fixture.manifestPath);
      assert.equal(registry.repos.find((repo) => repo.repoId === "classic")?.authorityManifestPath, undefined);

      if (preflightDelayMs > 0) writeFileSync(preflightDelayMarker, "ready\n", "utf8");
      const stopPressure = startRefreshCpuPressure();
      const refreshStartedAt = Date.now();
      let refresh: ReturnType<typeof runRawJsonMaybeFail>;
      try {
        refresh = timing.measure("refresh-total", () => runRawJsonMaybeFail(fixture.repoRoot, [
          "daemon", "refresh", "--trigger", "post-merge", "--timeout-ms", String(DAEMON_REFRESH_CONTROL_TIMEOUT_MS), "--user-root", userRoot
        ], env));
      } finally {
        stopPressure();
        rmSync(preflightDelayMarker, { force: true });
      }
      const refreshFinishedAt = Date.now();
      assert.equal(refresh.status, 0, JSON.stringify(refresh.receipt));
      assert.equal(refresh.receipt.ok, true, JSON.stringify(refresh.receipt));
      timing.recordRefreshReceipt(refresh.receipt, refreshStartedAt, refreshFinishedAt);
      const convergence = assertRefreshConvergence(refresh.receipt, before.pid as number);
      const after = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
      assert.equal(after.reachable, true, JSON.stringify({ refresh, after }));
      assert.equal(after.pid, convergence.replacementPid);
      const beforeService = before.service as { readonly build: { readonly loadedIdentity: string } };
      const afterService = after.service as {
        readonly build: { readonly loadedIdentity: string; readonly installedIdentity: string };
        readonly activeControl: unknown;
      };
      assert.equal(afterService.build.loadedIdentity, afterService.build.installedIdentity);
      assert.equal(afterService.build.loadedIdentity, beforeService.build.loadedIdentity);
      assert.equal(afterService.activeControl, null);
      process.kill(after.pid as number, 0);
      console.log(JSON.stringify({ scenario: "derived-manifest-refresh", events: convergence.events, beforePid: before.pid, afterPid: after.pid, reachable: after.reachable }));
      timing.report();
    });
  } finally {
    writeFileSync(fixture.manifestPath, validManifest, "utf8");
    rmSync(preflightDelayMarker, { force: true });
    await fixtureTiming.measureAsync("daemon-stop", () => stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined));
    rmSync(fixture.root, { recursive: true, force: true });
    fixtureTiming.report();
  }
});

test("restart replacement launch failure restores a reachable daemon", { timeout: DAEMON_REFRESH_TEST_TIMEOUT_MS }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const failureMarker = path.join(fixture.root, "fail-first-replacement.marker");
  const preloadPath = path.resolve("packages/cli/test/fixtures/daemon-fail-first-replacement-preload.mjs");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: String(DAEMON_REFRESH_REQUEST_TIMEOUT_MS),
    HARNESS_TEST_DAEMON_REPLACEMENT_FAILURE_MARKER: failureMarker,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim()
  };
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    const beforePid = started.pid as number;
    assert.equal(typeof beforePid, "number", JSON.stringify(started));

    writeFileSync(failureMarker, "fail the first non-check replacement\n", "utf8");
    const restart = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "restart", "--timeout-ms", "3000",
      "--replacement-timeout-ms", String(DAEMON_REFRESH_AUTOSTART_TIMEOUT_MS),
      "--user-root", userRoot
    ], env);
    assert.notEqual(restart.status, 0, JSON.stringify(restart.receipt));
    assert.match(JSON.stringify(restart.receipt), /DAEMON_RESTART_REPLACEMENT_FAILED_AFTER_HANDOFF/u);
    assert.match(JSON.stringify(restart.receipt), /service restored and reachable/u);

    const after = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "status", "--user-root", userRoot
    ], env);
    assert.equal(after.status, 0, JSON.stringify({ restart: restart.receipt, after: after.receipt }));
    assert.equal(after.receipt.reachable, true, JSON.stringify(after.receipt));
    assert.equal(typeof after.receipt.pid, "number", JSON.stringify(after.receipt));
    assert.notEqual(after.receipt.pid, beforePid, JSON.stringify({ beforePid, after: after.receipt }));
    process.kill(after.receipt.pid as number, 0);
  } finally {
    rmSync(failureMarker, { force: true });
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refresh explicitly exits the old owner after safe shutdown even with an active resource", { timeout: DAEMON_REFRESH_TEST_TIMEOUT_MS }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const markerPath = path.join(fixture.root, "old-owner-resource.marker");
  const evidencePath = path.join(fixture.root, "old-owner-resources.json");
  const preloadPath = path.resolve("packages/cli/test/fixtures/daemon-owner-active-resource-preload.mjs");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: String(DAEMON_REFRESH_AUTOSTART_TIMEOUT_MS),
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: String(DAEMON_REFRESH_REQUEST_TIMEOUT_MS),
    HARNESS_TEST_DAEMON_OWNER_RESOURCE_MARKER: markerPath,
    HARNESS_TEST_DAEMON_OWNER_RESOURCE_EVIDENCE: evidencePath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim()
  };
  let oldPid: number | undefined;
  let persistentClient: net.Socket | undefined;
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    oldPid = started.pid as number;
    assert.equal(typeof oldPid, "number", JSON.stringify(started));
    persistentClient = net.createConnection(localUserDaemonEndpoint(userRoot));
    await new Promise<void>((resolve, reject) => {
      persistentClient!.once("connect", resolve);
      persistentClient!.once("error", reject);
    });
    const persistentClientClosed = new Promise<void>((resolve) => persistentClient!.once("close", () => resolve()));

    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh", "--trigger", "post-merge", "--timeout-ms", String(DAEMON_REFRESH_CONTROL_TIMEOUT_MS), "--user-root", userRoot
    ], env);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      readonly pid: number;
      readonly resources: ReadonlyArray<string>;
    };
    console.log(JSON.stringify({ scenario: "old-owner-active-resource", oldPid, evidence, refresh: refresh.receipt }));
    assert.equal(refresh.status, 0, JSON.stringify(refresh.receipt));
    await persistentClientClosed;
    const convergence = assertRefreshConvergence(refresh.receipt, oldPid);
    assert.equal(evidence.pid, oldPid);
    assert.equal(evidence.resources.includes("Timeout"), true, JSON.stringify(evidence));
    console.log(JSON.stringify({ scenario: "old-owner-explicit-exit", events: convergence.events, oldPid, replacementPid: convergence.replacementPid }));
  } finally {
    persistentClient?.destroy();
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    if (oldPid !== undefined && processIsAlive(oldPid)) process.kill(oldPid, "SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("refresh reports a stuck drain timeout and leaves the old owner alive", { timeout: DAEMON_REFRESH_TEST_TIMEOUT_MS }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const markerPath = path.join(fixture.root, "old-owner-stuck-drain.marker");
  const preloadPath = path.resolve("packages/cli/test/fixtures/daemon-stuck-drain-preload.mjs");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: String(DAEMON_REFRESH_AUTOSTART_TIMEOUT_MS),
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: String(DAEMON_REFRESH_REQUEST_TIMEOUT_MS),
    HARNESS_TEST_DAEMON_STUCK_DRAIN_MARKER: markerPath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim()
  };
  let oldPid: number | undefined;
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    oldPid = started.pid as number;
    assert.equal(typeof oldPid, "number", JSON.stringify(started));

    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh", "--trigger", "post-merge", "--timeout-ms", "1000", "--user-root", userRoot
    ], env);
    const status = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
    assert.notEqual(refresh.status, 0, JSON.stringify(refresh.receipt));
    assert.match(JSON.stringify(refresh.receipt), /daemon_queue_drain_timeout/u);
    assert.match(JSON.stringify(refresh.receipt), /in-flight operations failed to settle in time/u);
    assert.equal(processIsAlive(oldPid), true);

    const service = status.service as {
      readonly pid?: unknown;
      readonly activeControl?: { readonly phase?: unknown; readonly failure?: { readonly code?: unknown } };
    };
    assert.equal(status.reachable, true, JSON.stringify(status));
    assert.equal(service.pid, oldPid);
    assert.equal(service.activeControl?.phase, "failed");
    assert.equal(service.activeControl?.failure?.code, "daemon_queue_drain_timeout");
    console.log(JSON.stringify({ scenario: "stuck-drain-owner-remains", oldPid, refresh: refresh.receipt, activeControl: service.activeControl }));
  } finally {
    if (oldPid !== undefined && processIsAlive(oldPid)) process.kill(oldPid, "SIGKILL");
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertRefreshConvergence(receipt: Record<string, any>, oldPid: number): {
  readonly events: ReadonlyArray<string>;
  readonly replacementPid: number;
} {
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  assert.equal(receipt.controlSchema, "daemon-control-accepted/v1", JSON.stringify(receipt));
  const before = receipt.before as Record<string, any>;
  assert.equal(before.pid, oldPid, JSON.stringify(receipt));
  assert.equal(before.queueDepth, 0, JSON.stringify(receipt));
  assert.equal(typeof before.launchConfiguration, "object", JSON.stringify(receipt));

  const replacement = receipt.replacement as Record<string, any>;
  assert.equal(replacement.schema, "daemon-status/v2", JSON.stringify(receipt));
  assert.equal(replacement.started, true, JSON.stringify(receipt));
  assert.equal(typeof replacement.pid, "number", JSON.stringify(receipt));
  assert.notEqual(replacement.pid, oldPid, JSON.stringify(receipt));
  assert.equal(replacement.service?.activeControl, null, JSON.stringify(receipt));
  assert.equal(replacement.service?.build?.loadedIdentity, replacement.service?.build?.installedIdentity, JSON.stringify(receipt));
  assert.equal(processIsAlive(oldPid), false, `old daemon owner ${oldPid} must exit before replacement readiness is accepted`);
  process.kill(replacement.pid as number, 0);

  return {
    events: ["accepted", "drain-preflight-complete", "old-owner-exited", "replacement-ready"],
    replacementPid: replacement.pid as number
  };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class RefreshTestTiming {
  private readonly startedAt = performance.now();
  private readonly phasesMs: Record<string, number> = {};
  private readonly scenario: string;

  constructor(scenario: string) {
    this.scenario = scenario;
  }

  measure<T>(phase: string, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.phasesMs[phase] = roundMs(performance.now() - startedAt);
    }
  }

  async measureAsync<T>(phase: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.phasesMs[phase] = roundMs(performance.now() - startedAt);
    }
  }

  recordRefreshReceipt(receipt: Record<string, unknown>, refreshStartedAt: number, refreshFinishedAt: number): void {
    const requestedAt = Date.parse(String(receipt.requestedAt));
    const replacement = receipt.replacement as { readonly service?: { readonly startedAt?: unknown } } | undefined;
    const replacementStartedAt = Date.parse(String(replacement?.service?.startedAt));
    if (!Number.isFinite(requestedAt) || !Number.isFinite(replacementStartedAt)) return;
    this.phasesMs["prepare-and-preflight"] = roundMs(Math.max(0, requestedAt - refreshStartedAt));
    this.phasesMs["drain-exit-and-spawn"] = roundMs(Math.max(0, replacementStartedAt - requestedAt));
    this.phasesMs["replacement-readiness"] = roundMs(Math.max(0, refreshFinishedAt - replacementStartedAt));
  }

  report(): void {
    console.log(JSON.stringify({
      scenario: `${this.scenario}-timing`,
      phasesMs: this.phasesMs,
      totalMs: roundMs(performance.now() - this.startedAt)
    }));
  }
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function startRefreshCpuPressure(): () => void {
  const burners = positiveIntegerEnv("HARNESS_TEST_DAEMON_REFRESH_CPU_BURNERS", 0);
  const children: ChildProcess[] = Array.from({ length: burners }, () => spawn(
    process.execPath,
    ["-e", "while (true) {}"],
    { stdio: "ignore" }
  ));
  return () => {
    for (const child of children) child.kill("SIGTERM");
  };
}
