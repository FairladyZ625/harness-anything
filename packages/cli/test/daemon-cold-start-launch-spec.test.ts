// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { localUserDaemonEndpoint, requestLocalDaemonJsonRpc } from "../../daemon/src/index.ts";
import { readDaemonRegistry, registerDaemonRepo } from "../../kernel/src/index.ts";
import { initializeHarness } from "../src/commands/init.ts";
import {
  daemonLaunchOptionsResolvedFlag,
  daemonLaunchSpecPath,
  preflightDaemonLaunch
} from "../src/daemon/daemon-launch-spec.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

const execFileAsync = promisify(execFile);

test("service cold start restores, overrides, and diagnoses the persisted launch spec", { timeout: 90_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const classicRoot = path.join(fixture.root, "classic-repo");
  const replacementManifest = path.join(fixture.root, "replacement-authority-manifest.json");
  const endpoint = localUserDaemonEndpoint(userRoot);
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
    assert.equal(first.endpoint, endpoint, JSON.stringify(first));
    assert.equal(first.daemonId, `ha-${String(first.pid)}`, JSON.stringify(first));
    assert.equal(
      readDaemonRegistry({ userRoot }).repos.find((repo) => repo.repoId === "canonical")?.authorityManifestPath,
      fixture.manifestPath
    );
    const persistedLaunchSpec = JSON.parse(readFileSync(daemonLaunchSpecPath(userRoot, endpoint), "utf8")) as {
      readonly endpoint: string;
      readonly options: { readonly authorityManifest?: string };
    };
    assert.equal(persistedLaunchSpec.endpoint, endpoint);
    assert.equal(persistedLaunchSpec.options.authorityManifest, fixture.manifestPath);
    assert.equal((await readRunningLaunchSpec(fixture.repoRoot, userRoot)).args.includes(daemonLaunchOptionsResolvedFlag), true);

    mkdirSync(classicRoot, { recursive: true });
    initializeHarness({ rootDir: classicRoot }, false, "Classic");
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "classic",
      "--canonical-root", classicRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    await stopDaemon(fixture.repoRoot, userRoot);

    const autostartedSpec = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      {},
      20_000,
      {
        userRoot,
        allowLegacySocket: false,
        autostart: {
          entryPath: path.resolve("packages/cli/src/index.ts"),
          idleExitMs: 60_000,
          timeoutMs: 20_000,
          env: cliTestEnv(env)
        }
      }
    );
    assert.equal(optionValue(launchSpecArgs(autostartedSpec), "--authority-manifest"), fixture.manifestPath);
    assert.match(readFileSync(daemonLaunchSpecPath(userRoot, endpoint), "utf8"), new RegExp(escapeRegExp(fixture.manifestPath), "u"));
    await stopDaemon(fixture.repoRoot, userRoot);

    spawn(process.execPath, [
      path.resolve("packages/cli/src/index.ts"),
      "--root", fixture.repoRoot,
      "daemon", "start", "--foreground",
      "--user-root", userRoot,
      "--json"
    ], {
      stdio: "ignore",
      env: cliTestEnv(env)
    });
    const foregroundSpec = await pollUntil(
      () => requestLocalDaemonJsonRpc(fixture.repoRoot, "admin.daemon.launch-spec", {}, 1_000, {
        userRoot,
        allowLegacySocket: false
      }),
      () => true,
      (_candidate, error) => String(error ?? "foreground daemon did not publish its launch spec"),
      { timeoutMs: 20_000 }
    );
    assert.equal(optionValue(launchSpecArgs(foregroundSpec), "--authority-manifest"), fixture.manifestPath);
    assert.match(readFileSync(daemonLaunchSpecPath(userRoot, endpoint), "utf8"), new RegExp(escapeRegExp(fixture.manifestPath), "u"));
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
    assert.match(readFileSync(daemonLaunchSpecPath(userRoot, endpoint), "utf8"), new RegExp(escapeRegExp(replacementManifest), "u"));
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
  const endpoint = localUserDaemonEndpoint(userRoot);
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
    assert.equal(existsSync(daemonLaunchSpecPath(userRoot, endpoint)), false);
    await assert.rejects(preflightDaemonLaunch({
      execPath: process.execPath,
      execArgv: [...process.execArgv],
      entrypoint: path.resolve("packages/cli/src/index.ts"),
      args: [
        "--root", fixture.repoRoot, "daemon", "serve", "--repo", "canonical",
        "--socket", path.join(userRoot, "preflight.sock"), "--user-root", userRoot, "--idle-ms", "0"
      ]
    }), /AUTHORITY_MANIFEST_REGISTRY_INCOMPLETE/u);
    assert.equal(existsSync(daemonLaunchSpecPath(userRoot, endpoint)), false);

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

test("occupied daemon socket does not persist a new authority manifest registry pointer", async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const endpoint = localUserDaemonEndpoint(userRoot);
  const owner = net.createServer();
  try {
    mkdirSync(userRoot, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.listen(endpoint, () => resolve());
    });
    writeFileSync(`${endpoint}.owner`, JSON.stringify({
      schema: "daemon-socket-owner/v1",
      pid: process.pid,
      ownerToken: "occupied-socket-test-owner"
    }));

    await assert.rejects(execFileAsync(process.execPath, [
      path.resolve("packages/cli/src/index.ts"),
      "--root", fixture.repoRoot,
      "daemon", "serve",
      "--repo", "canonical",
      "--socket", endpoint,
      "--user-root", userRoot,
      "--authority-manifest", fixture.manifestPath
    ], { encoding: "utf8", env: cliTestEnv({ HARNESS_DAEMON_USER_ROOT: userRoot }) }), /already owned/u);

    assert.equal(
      readDaemonRegistry({ userRoot }).repos.find((repo) => repo.repoId === "canonical")?.authorityManifestPath,
      undefined
    );
  } finally {
    await new Promise<void>((resolve) => owner.close(() => resolve()));
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon start rejects explicit empty or valueless launch options before persisted fallback", () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot
  };
  try {
    for (const args of [
      ["daemon", "start", "--service", "--authority-manifest", "", "--json"],
      ["--authored-root", "", "daemon", "start", "--service", "--json"],
      ["daemon", "start", "--service", "--authority-manifest"],
      ["daemon", "start", "--service", "--authored-root"]
    ]) {
      const failed = runRawJsonMaybeFail(fixture.repoRoot, args, env);
      assert.notEqual(failed.status, 0, JSON.stringify({ args, receipt: failed.receipt }));
      assert.match(JSON.stringify(failed.receipt), /requires a non-empty path value/u);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("relative launch paths retain their original cwd meaning across a service cold start", { timeout: 45_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const cwdA = path.join(fixture.root, "cwd-a");
  const cwdB = path.join(fixture.root, "cwd-b");
  const endpoint = localUserDaemonEndpoint(userRoot);
  const env = { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_USER_ROOT: userRoot };
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  try {
    const first = runDaemonJsonFromCwd(cwdA, path.relative(cwdA, fixture.repoRoot), [
      "daemon", "start", "--service",
      "--authority-manifest", path.relative(cwdA, fixture.manifestPath),
      "--authored-root", path.relative(fixture.repoRoot, fixture.authoredRoot)
    ], env);
    assert.equal(first.ok, true, JSON.stringify(first));
    await stopDaemon(fixture.repoRoot, userRoot);

    const persisted = JSON.parse(readFileSync(daemonLaunchSpecPath(userRoot, endpoint), "utf8")) as {
      readonly options: { readonly authorityManifest?: string; readonly authoredRoot?: string };
    };
    assert.equal(persisted.options.authorityManifest, fixture.manifestPath);
    assert.equal(persisted.options.authoredRoot, fixture.authoredRoot);

    const restored = runDaemonJsonFromCwd(cwdB, path.relative(cwdB, fixture.repoRoot), ["daemon", "start", "--service"], env);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const running = await readRunningLaunchSpec(fixture.repoRoot, userRoot);
    assert.equal(optionValue(running.args, "--root"), fixture.repoRoot);
    assert.equal(optionValue(running.args, "--authority-manifest"), fixture.manifestPath);
    assert.equal(optionValue(running.args, "--authored-root"), fixture.authoredRoot);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("daemon serve and start reject malformed launch path boundaries without persisting a spec", async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = { HARNESS_DAEMON_MODE: "local", HARNESS_DAEMON_USER_ROOT: userRoot };
  const malformed = [
    ["--root"],
    ["--root", ""],
    ["--root", "--socket", path.join(fixture.root, "daemon.sock")],
    ["--socket"],
    ["--user-root"],
    ["--socket", "--root", fixture.repoRoot],
    ["--user-root", "-relative-root"]
  ];
  try {
    for (const optionArgs of malformed) {
      const serve = spawnSync(process.execPath, [
        path.resolve("packages/cli/src/index.ts"), "--root", fixture.repoRoot,
        "daemon", "serve", ...optionArgs
      ], { encoding: "utf8", env: cliTestEnv(env) });
      assert.notEqual(serve.status, 0, JSON.stringify({ optionArgs, stdout: serve.stdout, stderr: serve.stderr }));
      assert.match(serve.stderr, /requires a non-empty, non-flag path value/u);

      const start = runRawJsonMaybeFail(fixture.repoRoot, ["daemon", "start", "--service", ...optionArgs], env);
      assert.notEqual(start.status, 0, JSON.stringify({ optionArgs, receipt: start.receipt }));
      assert.match(JSON.stringify(start.receipt), /requires a non-empty, non-flag path value/u);
    }
    for (const mode of ["--service", "--foreground"]) {
      const authored = runRawJsonMaybeFail(fixture.repoRoot, [
        "daemon", "start", mode, "--authored-root", "--json"
      ], env);
      assert.notEqual(authored.status, 0, JSON.stringify(authored.receipt));
      assert.match(JSON.stringify(authored.receipt), /--authored-root requires a non-empty path value/u);
    }
    assert.deepEqual(daemonLaunchSpecFiles(fixture.root), []);
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

function launchSpecArgs(receipt: Record<string, unknown>): ReadonlyArray<string> {
  const details = receipt.details as { readonly data?: unknown };
  assert.equal(isRecord(details.data), true, JSON.stringify(receipt));
  const data = details.data as Record<string, unknown>;
  assert.equal(Array.isArray(data.args), true, JSON.stringify(receipt));
  return data.args as ReadonlyArray<string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function runDaemonJsonFromCwd(
  cwd: string,
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [
    path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "--json", ...args
  ], { cwd, encoding: "utf8", env: cliTestEnv(env) });
  assert.equal(result.stderr, "", result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function daemonLaunchSpecFiles(rootDir: string): ReadonlyArray<string> {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { recursive: true })
    .filter((entry) => path.basename(entry).startsWith("daemon-launch-spec."));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
