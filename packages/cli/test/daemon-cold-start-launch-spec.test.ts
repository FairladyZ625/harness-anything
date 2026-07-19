// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/index.ts";
import { readDaemonRegistry, registerDaemonRepo } from "../../kernel/src/index.ts";
import { initializeHarness } from "../src/commands/init.ts";
import { daemonLaunchSpecPath, preflightDaemonLaunch } from "../src/daemon/daemon-launch-spec.ts";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

test("service cold start restores, overrides, and diagnoses the persisted launch spec", { timeout: 90_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const classicRoot = path.join(fixture.root, "classic-repo");
  const replacementManifest = path.join(fixture.root, "replacement-authority-manifest.json");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  try {
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    const first = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    assert.equal(first.started, true, JSON.stringify(first));
    assert.equal(typeof first.pid, "number", JSON.stringify(first));
    assert.match(readFileSync(daemonLaunchSpecPath(userRoot, "default"), "utf8"), new RegExp(escapeRegExp(fixture.manifestPath), "u"));

    mkdirSync(classicRoot, { recursive: true });
    initializeHarness({ rootDir: classicRoot }, false, "Classic");
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "classic",
      "--canonical-root", classicRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    await stopDaemon(fixture.repoRoot, userRoot);

    const restored = runDaemonCommand(fixture.repoRoot, ["daemon", "start", "--service", "--json"], env);
    assert.equal(restored.started, true, JSON.stringify(restored));
    assert.equal(typeof restored.pid, "number", JSON.stringify(restored));
    assert.notEqual(restored.pid, first.pid);
    const restoredSpec = await readRunningLaunchSpec(fixture.repoRoot, userRoot);
    assert.equal(optionValue(restoredSpec.args, "--authority-manifest"), fixture.manifestPath);
    if (process.platform !== "win32") {
      const restoredCommand = execFileSync("ps", ["-p", String(restored.pid), "-o", "command="], { encoding: "utf8" });
      assert.match(restoredCommand, new RegExp(escapeRegExp(fixture.manifestPath), "u"));
    }
    await stopDaemon(fixture.repoRoot, userRoot);

    copyFileSync(fixture.manifestPath, replacementManifest);
    const overridden = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", replacementManifest, "--json"
    ], env);
    assert.equal(overridden.started, true, JSON.stringify(overridden));
    const overriddenSpec = await readRunningLaunchSpec(fixture.repoRoot, userRoot);
    assert.equal(optionValue(overriddenSpec.args, "--authority-manifest"), replacementManifest);
    assert.match(readFileSync(daemonLaunchSpecPath(userRoot, "default"), "utf8"), new RegExp(escapeRegExp(replacementManifest), "u"));
    await stopDaemon(fixture.repoRoot, userRoot);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("service cold start without a required manifest reports the preflight cause and recovery command", { timeout: 30_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const classicRoot = path.join(fixture.root, "classic-repo");
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot
  };
  try {
    mkdirSync(classicRoot, { recursive: true });
    initializeHarness({ rootDir: classicRoot }, false, "Classic");
    registerDaemonRepo({
      userRoot,
      repoId: "canonical",
      canonicalRoot: fixture.repoRoot,
      authorityManifestPath: fixture.manifestPath,
      createConvenienceLinks: false
    });
    registerDaemonRepo({
      userRoot,
      repoId: "classic",
      canonicalRoot: classicRoot,
      createConvenienceLinks: false
    });
    assert.equal(
      readDaemonRegistry({ userRoot }).repos.find((repo) => repo.repoId === "canonical")?.authorityManifestPath,
      fixture.manifestPath
    );
    assert.equal(existsSync(daemonLaunchSpecPath(userRoot, "default")), false);
    await assert.rejects(preflightDaemonLaunch({
      execPath: process.execPath,
      execArgv: [...process.execArgv],
      entrypoint: path.resolve("packages/cli/src/index.ts"),
      args: [
        "--root", fixture.repoRoot, "daemon", "serve", "--repo", "canonical",
        "--socket", path.join(userRoot, "preflight.sock"), "--user-root", userRoot, "--idle-ms", "0"
      ]
    }), /AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE/u);
    assert.equal(existsSync(daemonLaunchSpecPath(userRoot, "default")), false);

    const missing = runRawJsonMaybeFail(fixture.repoRoot, ["daemon", "start", "--service"], env);
    assert.notEqual(missing.status, 0, JSON.stringify(missing.receipt));
    const failure = JSON.stringify(missing.receipt);
    assert.match(failure, /AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE/u);
    assert.match(failure, /Missing required option --authority-manifest/u);
    assert.match(failure, /ha daemon start --service --user-root <user-root> --authority-manifest <path>/u);
    assert.doesNotMatch(failure, /did not become reachable/u);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function readRunningLaunchSpec(
  rootDir: string,
  userRoot: string
): Promise<{ readonly args: ReadonlyArray<string> }> {
  const receipt = await requestLocalDaemonJsonRpc(rootDir, "admin.daemon.launch-spec", {}, 1_000, {
    userRoot,
    allowLegacySocket: false
  });
  const details = receipt.details as { readonly data?: unknown };
  assert.equal(isRecord(details.data), true, JSON.stringify(receipt));
  const data = details.data as Record<string, unknown>;
  assert.equal(Array.isArray(data.args), true, JSON.stringify(receipt));
  return { args: data.args as ReadonlyArray<string> };
}

function optionValue(args: ReadonlyArray<string>, option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
