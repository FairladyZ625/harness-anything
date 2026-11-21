import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { verifyTarballArchive } from "../check-package-tarball-exports.mjs";
import { lastReceipt, smokeIdentity } from "../fixtures/smoke-identity.mjs";
import { preparePackageExports, restorePackageExports } from "../package-exports-lifecycle.mjs";
import { env as smokeEnv, resolveBinCommand, workspaceDependencyClosure } from "../smoke-cli-package.mjs";
import { repoRoot } from "./git.mjs";
import { normalizeRepoPath } from "./module-policy.mjs";

export const DEFAULT_DEADLINE_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PROCESS_TREE_KILL_GRACE_MS = 300;
const PID_POLL_INTERVAL_MS = 50;
const STOP_SETTLE_POLLS = 20;
const GONE_RECEIPT_CODES = new Set(["daemon_unavailable", "daemon_stopped_by_operator"]);
const ARM64_CONTRACT_TESTS = Object.freeze([
  "packages/daemon/test/node-pty-prebuild.test.ts",
  "packages/daemon/test/linux-arm64-platform.test.ts",
]);
const TARBALL_CHECK_PACKAGES = new Set([
  "@harness-anything/cli",
  "@harness-anything/daemon",
  "@harness-anything/kernel",
]);

function sanitizedHostEnv(overrides = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
  return { ...base, ...overrides };
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function createDeadlineBudget(deadlineMs, now = () => Date.now()) {
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  const stages = [];
  const elapsedMs = () => Math.max(0, Math.round(now() - startedAt));
  const isExpired = () => now() > deadlineAt;
  const remainingMs = (label) => {
    const remaining = Math.floor(deadlineAt - now());
    if (remaining <= 0) {
      const error = new Error(
        `linux-arm64-smoke exceeded ${deadlineMs}ms end-to-end budget before ${label} (${elapsedMs()}ms elapsed)`,
      );
      error.code = "arm64_smoke_deadline_exceeded";
      throw error;
    }
    return remaining;
  };
  const checkAfter = (label) => {
    if (now() > deadlineAt) {
      return `stage ${label} exceeded ${deadlineMs}ms end-to-end budget (${elapsedMs()}ms elapsed)`;
    }
    return null;
  };
  const recordStage = (name, stageStart, ok) => {
    stages.push({ name, durationMs: Math.max(0, Math.round(now() - stageStart)), ok });
  };
  return { deadlineMs, startedAt, deadlineAt, stages, elapsedMs, isExpired, remainingMs, checkAfter, recordStage };
}

export function verifyHostArchitecture({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  requireLinuxArm64 = false,
} = {}) {
  const errors = [];
  const checks = [];
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    errors.push(`Node >= 24 is required for linux-arm64 smoke; got ${nodeVersion}`);
  } else {
    checks.push(`node runtime ${nodeVersion} satisfies >=24`);
  }
  if (requireLinuxArm64 && (platform !== "linux" || arch !== "arm64")) {
    errors.push(`expected linux-arm64 runner, got ${platform}-${arch}`);
  } else {
    checks.push(`host architecture ${platform}-${arch}${requireLinuxArm64 ? " verified as linux-arm64" : ""}`);
  }
  return { ok: errors.length === 0, errors, checks };
}

export function verifyNodeSqlite() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE arm64_smoke (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO arm64_smoke (id, value) VALUES (?, ?)").run("probe", "ok");
    const row = db.prepare("SELECT id, value FROM arm64_smoke WHERE id = ?").get("probe");
    if (row?.id !== "probe" || row?.value !== "ok") {
      return { ok: false, errors: [`node:sqlite round-trip mismatch: ${JSON.stringify(row)}`], checks: [] };
    }
    return { ok: true, errors: [], checks: ["node:sqlite DatabaseSync round-trip passed"] };
  } finally {
    db.close();
  }
}

export async function verifyNodePty({
  platform = process.platform,
  arch = process.arch,
  packageRoot = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json")),
  runLivePty = true,
  timeoutMs = 30_000,
  spawnPty,
} = {}) {
  const errors = [];
  const checks = [];
  const arm64Prebuild = path.join(packageRoot, "prebuilds", "linux-arm64");
  if (!existsSync(arm64Prebuild) || !readdirSync(arm64Prebuild).includes("pty.node")) {
    errors.push(`node-pty prebuilds/linux-arm64/pty.node is missing under ${packageRoot}`);
  } else {
    checks.push("node-pty ships prebuilds/linux-arm64/pty.node");
  }
  if (platform === "linux" && arch === "arm64") {
    const hostPrebuild = path.join(packageRoot, "prebuilds", `${platform}-${arch}`, "pty.node");
    if (!existsSync(hostPrebuild)) errors.push(`host prebuild missing: ${hostPrebuild}`);
  }
  if (runLivePty && platform !== "win32") {
    const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    const pty = await import("node-pty");
    let output;
    try {
      output = await new Promise((resolve, reject) => {
        let buffer = "";
        let settled = false;
        const ptyOptions = {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env: process.env,
        };
        const child = spawnPty
          ? spawnPty(process.execPath, ["-e", 'process.stdout.write("ha-arm64-pty-ok")'], ptyOptions)
          : pty.spawn(process.execPath, ["-e", 'process.stdout.write("ha-arm64-pty-ok")'], ptyOptions);
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          child.kill?.("SIGKILL");
          if (typeof child.pid === "number" && Number.isInteger(child.pid) && child.pid > 0) {
            signalProcess(child.pid, "SIGKILL");
          }
          finish(reject, new Error(`node-pty live spawn timed out after ${effectiveTimeoutMs}ms`));
        }, effectiveTimeoutMs);
        timer.unref?.();
        child.onData((chunk) => {
          buffer += chunk;
        });
        child.onExit(({ exitCode }) => {
          if (exitCode !== 0) finish(reject, new Error(`node-pty probe exited with code ${exitCode}: ${buffer}`));
          else finish(resolve, buffer);
        });
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { ok: false, errors, checks };
    }
    if (!output.includes("ha-arm64-pty-ok")) {
      errors.push(`node-pty live spawn output missing marker: ${JSON.stringify(output)}`);
    } else {
      checks.push(`node-pty native addon loaded and spawned PTY on ${platform}-${arch}`);
    }
  }
  return { ok: errors.length === 0, errors, checks };
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

async function terminateProcessTree(
  child,
  { graceMs = PROCESS_TREE_KILL_GRACE_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS },
) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return waitForChildExit(child, cleanupTimeoutMs);
  }
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return waitForChildExit(child, cleanupTimeoutMs);
  }
  const pgidAlive = signalProcessGroup(child.pid, "SIGTERM");
  if (!pgidAlive) signalProcess(child.pid, "SIGTERM");
  const exitedGracefully = await waitForChildExit(child, Math.min(graceMs, cleanupTimeoutMs));
  if (!exitedGracefully) {
    if (!signalProcessGroup(child.pid, "SIGKILL")) signalProcess(child.pid, "SIGKILL");
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    await waitForChildExit(child, cleanupTimeoutMs);
  }
  return (child.exitCode !== null || child.signalCode !== null) && !processIsAlive(child.pid);
}

async function attemptTerminateProcessTree(child, options) {
  try {
    const terminatedCleanly = await terminateProcessTree(child, options);
    return { ok: true, terminatedCleanly, error: null };
  } catch (error) {
    return { ok: false, terminatedCleanly: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function runBoundedCommandAsync(
  command,
  args,
  { cwd, env, timeoutMs, input, label, graceMs = PROCESS_TREE_KILL_GRACE_MS, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS },
) {
  const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    if (input !== undefined && child.stdin) {
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") stderr += `\nstdin error: ${error.message}`;
      });
      child.stdin.end(input);
    }
    const timer = setTimeout(async () => {
      timedOut = true;
      const termination = await attemptTerminateProcessTree(child, { graceMs, cleanupTimeoutMs });
      const suffix = !termination.ok
        ? ` (cleanup error: ${termination.error})`
        : termination.terminatedCleanly
          ? ""
          : ` (process tree did not exit within ${cleanupTimeoutMs}ms)`;
      finish({
        ok: false,
        status: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        timedOut: true,
        terminatedCleanly: termination.terminatedCleanly,
        errorMessage: `${label} timed out after ${effectiveTimeoutMs}ms${suffix}`,
      });
    }, effectiveTimeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        status: null,
        signal: null,
        stdout,
        stderr,
        timedOut: false,
        terminatedCleanly: true,
        errorMessage: `${label} failed to spawn: ${error.message}`,
      });
    });
    child.on("close", (status, signal) => {
      if (timedOut) return;
      finish({
        ok: status === 0,
        status,
        signal,
        stdout,
        stderr,
        timedOut: false,
        terminatedCleanly: true,
        errorMessage: status === 0 ? null : `${label} exited ${status}: ${(stderr || stdout).trim()}`,
      });
    });
  });
}

function runNpmAsync(args, options) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runBoundedCommandAsync(npm, args, {
    ...options,
    env: options.env ?? sanitizedHostEnv(),
  });
}

function parseCliResult(result) {
  try {
    return { ...result, receipt: lastReceipt(result.stdout) };
  } catch (error) {
    return { ...result, receipt: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function readDaemonPid(userRoot) {
  const pidPath = path.join(userRoot, "daemon-default.pid");
  if (!existsSync(pidPath)) return { state: "absent", pid: null };
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return { state: "invalid", pid: null };
  return { state: "present", pid };
}

function daemonPidAlive(userRoot) {
  const info = readDaemonPid(userRoot);
  if (info.state !== "present") return false;
  return processIsAlive(info.pid);
}

async function terminateDaemonPidFile(userRoot, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS) {
  const info = readDaemonPid(userRoot);
  if (info.state === "absent") return { ok: true, reason: "no_pid_file", pid: null };
  if (info.state === "invalid")
    return { ok: false, reason: "invalid_pid", pid: null, error: "invalid daemon pid file" };
  const { pid } = info;
  if (!processIsAlive(pid)) return { ok: true, reason: "already_exited", pid };
  const gracePolls = Math.max(
    1,
    Math.ceil(Math.min(PROCESS_TREE_KILL_GRACE_MS, cleanupTimeoutMs) / PID_POLL_INTERVAL_MS),
  );
  const killPolls = Math.max(1, Math.ceil(cleanupTimeoutMs / PID_POLL_INTERVAL_MS));
  try {
    signalProcess(pid, "SIGTERM");
    for (let attempt = 0; attempt < gracePolls && processIsAlive(pid); attempt += 1) await delay(PID_POLL_INTERVAL_MS);
    if (processIsAlive(pid)) {
      signalProcess(pid, "SIGKILL");
      for (let attempt = 0; attempt < killPolls && processIsAlive(pid); attempt += 1) await delay(PID_POLL_INTERVAL_MS);
    }
    if (processIsAlive(pid)) {
      return { ok: false, pid, reason: "survived_sigkill", error: `pid ${pid} survived SIGKILL` };
    }
    return { ok: true, pid, reason: "terminated" };
  } catch (error) {
    return { ok: false, pid, reason: "kill_error", error: error instanceof Error ? error.message : String(error) };
  }
}

export function isConfirmedDaemonGone(statusResult) {
  return (
    statusResult.status !== 0 &&
    statusResult.timedOut !== true &&
    typeof statusResult.receipt?.code === "string" &&
    GONE_RECEIPT_CODES.has(statusResult.receipt.code)
  );
}

export async function verifyDaemonStoppedAndCleanup({
  label,
  userRoot,
  stopDaemon,
  started,
  alreadyStopped,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
}) {
  const cleanupErrors = [];
  const pidAliveBefore = daemonPidAlive(userRoot);
  if (!started && !pidAliveBefore) return { ok: true, errors: cleanupErrors };
  if (alreadyStopped && !pidAliveBefore) return { ok: true, errors: cleanupErrors };

  const stopResult = await stopDaemon(cleanupTimeoutMs);
  const stopConfirmedOk = stopResult.status === 0 && stopResult.receipt?.ok === true;
  const stopConfirmedAlreadyGone = isConfirmedDaemonGone(stopResult);
  if (!stopConfirmedOk && !stopConfirmedAlreadyGone) {
    cleanupErrors.push(
      `${label} cleanup daemon stop failed: status=${stopResult.status} timedOut=${Boolean(stopResult.timedOut)} code=${stopResult.receipt?.code ?? "none"} detail=${(stopResult.stderr || stopResult.stdout || stopResult.errorMessage || "").trim()}`,
    );
  }
  const killResult = await terminateDaemonPidFile(userRoot, cleanupTimeoutMs);
  if (!killResult.ok) {
    cleanupErrors.push(`${label} cleanup pid termination failed: ${killResult.error ?? killResult.reason}`);
  }
  return { ok: cleanupErrors.length === 0, errors: cleanupErrors };
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else files.push(path.relative(directory, fullPath).split(path.sep).join("/"));
    }
  };
  walk(directory);
  return files.sort();
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function generateLocalhostTlsCert(keyPath, certPath, tempRoot, budget) {
  const result = await runBoundedCommandAsync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    {
      cwd: tempRoot,
      env: sanitizedHostEnv(),
      timeoutMs: budget.remainingMs("openssl localhost cert"),
      label: "openssl localhost cert",
    },
  );
  if (!result.ok) throw new Error(result.errorMessage);
}

function checkExecutableBit(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runAsyncCleanupStep(label, fn) {
  try {
    const result = await fn();
    if (result && result.ok === false) {
      const details = Array.isArray(result.errors)
        ? result.errors
        : [result.errorMessage ?? `${label} reported failure`];
      return { ok: false, errors: details };
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`${label} failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function removeDirectorySafely(dirPath, label) {
  try {
    rmSync(dirPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`${label} failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export async function verifyInstalledPackageBins(consumerDir, { budget } = {}) {
  const errors = [];
  const checks = [];
  const requiredBins = [
    { packageName: "@harness-anything/cli", alias: "ha", expectedTarget: "dist/cli/src/index.js" },
    { packageName: "@harness-anything/cli", alias: "harness-anything", expectedTarget: "dist/cli/src/index.js" },
    { packageName: "@harness-anything/daemon", alias: "harness-anything-daemon", expectedTarget: "dist/index.js" },
  ];
  const resolved = {};
  const checkedTargets = new Set();

  for (const { packageName, alias, expectedTarget } of requiredBins) {
    const pkgRoot = path.join(consumerDir, "node_modules", ...packageName.split("/"));
    const manifestPath = path.join(pkgRoot, "package.json");
    if (!existsSync(manifestPath)) {
      errors.push(`${packageName} package.json is missing after isolated install: ${manifestPath}`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const declaredTarget =
      typeof manifest.bin === "string"
        ? packageName.split("/").at(-1) === alias
          ? manifest.bin
          : undefined
        : manifest.bin?.[alias];
    if (typeof declaredTarget !== "string" || declaredTarget.length === 0) {
      errors.push(`${packageName} installed package.json is missing bin mapping "${alias}"`);
      continue;
    }
    const normalizedTarget = normalizeRepoPath(declaredTarget);
    if (normalizedTarget === null) {
      errors.push(`${packageName} bin "${alias}" target is not a normalized relative path: ${declaredTarget}`);
      continue;
    }
    if (normalizedTarget !== expectedTarget) {
      errors.push(`${packageName} bin "${alias}" target ${normalizedTarget} differs from expected ${expectedTarget}`);
    }
    const targetFile = path.join(pkgRoot, normalizedTarget);
    if (!existsSync(targetFile)) {
      errors.push(`${packageName} bin "${alias}" target file is missing: ${targetFile}`);
      continue;
    }

    const command = resolveBinCommand(consumerDir, alias);
    if (!existsSync(command.file)) {
      errors.push(`installed public bin "${alias}" is missing under node_modules/.bin: ${command.file}`);
      continue;
    }
    if (process.platform !== "win32") {
      const execCheck = checkExecutableBit(command.file);
      if (!execCheck.ok) {
        errors.push(`installed public bin "${alias}" is not executable (${command.file}): ${execCheck.error}`);
        continue;
      }
    }
    resolved[alias] = command;

    if (!checkedTargets.has(targetFile)) {
      checkedTargets.add(targetFile);
      const syntaxTimeoutMs = budget ? budget.remainingMs(`syntax check ${packageName} bin`) : 30_000;
      const syntax = await runBoundedCommandAsync(process.execPath, ["--check", targetFile], {
        cwd: consumerDir,
        env: sanitizedHostEnv(),
        timeoutMs: syntaxTimeoutMs,
        label: `syntax check ${packageName} bin`,
      });
      if (!syntax.ok) {
        errors.push(syntax.errorMessage);
        continue;
      }
    }
    checks.push(`installed public bin "${alias}" verified (${path.relative(consumerDir, command.file)})`);
  }

  return {
    ok: errors.length === 0,
    errors,
    checks,
    cliBins:
      resolved.ha && resolved["harness-anything"]
        ? { ha: resolved.ha, harnessAnything: resolved["harness-anything"] }
        : null,
    daemonBin: resolved["harness-anything-daemon"] ?? null,
  };
}

async function buildWorkspacePackage(rootDir, name, budget) {
  const directory = name.slice("@harness-anything/".length);
  const packageDir = path.posix.join("packages", directory);
  const source = path.join(rootDir, packageDir);
  const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const buildScript = manifest.scripts?.["build:publish"] ? "build:publish" : "build";

  // Always start from a clean dist/ inside the single observable deadline so pre-budget
  // npm ci prepare output can never bypass compilation timing.
  rmSync(path.join(source, "dist"), { recursive: true, force: true });

  const tscBin = path.join(rootDir, "node_modules/typescript/bin/tsc");
  const scriptText = manifest.scripts?.[buildScript] ?? "";
  const tsconfigMatch = /\btsc\s+-p\s+(\S+)/u.exec(scriptText);
  if (tsconfigMatch && existsSync(tscBin)) {
    const tscArgs = [tscBin, "--noCheck", "-p", tsconfigMatch[1]];
    const compiled = await runBoundedCommandAsync(process.execPath, tscArgs, {
      cwd: source,
      env: sanitizedHostEnv(),
      timeoutMs: budget.remainingMs(`build ${name}`),
      label: `build ${name}`,
    });
    if (!compiled.ok) return compiled;
    if (scriptText.includes("copy-assets.mjs")) {
      const copied = await runBoundedCommandAsync(process.execPath, ["scripts/copy-assets.mjs"], {
        cwd: source,
        env: sanitizedHostEnv(),
        timeoutMs: budget.remainingMs(`copy-assets ${name}`),
        label: `copy-assets ${name}`,
      });
      if (!copied.ok) return copied;
    }
  } else {
    const built = await runNpmAsync(["run", buildScript, "-w", name], {
      cwd: rootDir,
      timeoutMs: budget.remainingMs(`build ${name}`),
      label: `build ${name}`,
    });
    if (!built.ok) return built;
  }

  if (name === "@harness-anything/daemon") {
    for (const marker of ["dist/index.js", "dist/build-id.txt"]) {
      if (!existsSync(path.join(source, marker))) {
        return { ok: false, errorMessage: `build ${name} did not produce ${marker}` };
      }
    }
  }
  return { ok: true, errorMessage: null };
}

export async function packAndInstallArm64Packages(rootDir, { tempRoot, budget, verifyTarball = verifyTarballArchive }) {
  const errors = [];
  const checks = [];
  const packDir = path.join(tempRoot, "pack");
  const stageRoot = path.join(tempRoot, "stage");
  const consumerDir = path.join(tempRoot, "consumer");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(path.join(consumerDir, "package.json"), '{"private":true,"type":"module"}\n');

  const workspaces = workspaceDependencyClosure(rootDir, "@harness-anything/cli");

  // Typechecking runs in the dedicated PR typecheck lane; compile the full workspace closure
  // (including @harness-anything/daemon from clean dist/) in parallel inside the single 180s budget.
  const buildStart = Date.now();
  const buildResults = await Promise.all(workspaces.map((name) => buildWorkspacePackage(rootDir, name, budget)));
  for (const result of buildResults) {
    if (!result.ok) errors.push(result.errorMessage);
  }
  if (errors.length > 0) return { ok: false, errors, checks, consumerDir, cliBins: null, daemonBin: null };
  checks.push(
    `workspace closure compiled from clean dist in ${Date.now() - buildStart}ms (${workspaces.length} packages)`,
  );

  // Staging intentionally runs preparePackageExports + `npm pack --ignore-scripts` in tempRoot/stage
  // instead of mutating repository package.json files or re-running synchronous `npm run build` via
  // prepack. Coverage: clean tsc + copy-assets emit, publishConfig.exports parity, declared source
  // bin mappings + exports + kernel ontology facets via verifyTarballArchive, isolated npm install,
  // and live execution of installed `node_modules/.bin/ha` + `harness-anything` shims. Difference vs
  // package-policy: full npm pack prepack/postpack shell hooks are covered by the package-policy lane.
  const packStart = Date.now();
  const packResults = await Promise.all(
    workspaces.map(async (name) => {
      const directory = name.slice("@harness-anything/".length);
      const packageDir = path.posix.join("packages", directory);
      const source = path.join(rootDir, packageDir);
      const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
      const stage = path.join(stageRoot, directory);
      mkdirSync(stage, { recursive: true });
      for (const file of new Set(["package.json", ...(manifest.files ?? [])])) {
        cpSync(path.join(source, file), path.join(stage, file), { recursive: true });
      }
      preparePackageExports(stage, process.pid);
      let packed;
      try {
        packed = await runNpmAsync(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], {
          cwd: stage,
          timeoutMs: budget.remainingMs(`npm pack ${name}`),
          label: `npm pack ${name}`,
        });
      } finally {
        restorePackageExports(stage);
      }
      if (!packed.ok) return { ok: false, errors: [packed.errorMessage], checks: [], tarballPath: null };
      const [{ filename } = {}] = JSON.parse(packed.stdout);
      const tarballPath = path.join(packDir, filename ?? "");
      if (!filename || !existsSync(tarballPath)) {
        return { ok: false, errors: [`npm pack did not produce a tarball for ${name}`], checks: [], tarballPath: null };
      }
      const pkgChecks = [];
      if (TARBALL_CHECK_PACKAGES.has(name)) {
        const violations = verifyTarball(tarballPath, manifest, packageDir, rootDir);
        if (violations.length > 0) return { ok: false, errors: violations, checks: [], tarballPath: null };
        pkgChecks.push(`${name}: tarball exports and declared bin mappings verified (${filename})`);
      }
      return { ok: true, errors: [], checks: pkgChecks, tarballPath };
    }),
  );
  const tarballs = [];
  for (const result of packResults) {
    checks.push(...result.checks);
    errors.push(...result.errors);
    if (result.tarballPath) tarballs.push(result.tarballPath);
  }
  if (errors.length > 0) return { ok: false, errors, checks, consumerDir, cliBins: null, daemonBin: null };
  checks.push(`tarballs packed and verified in ${Date.now() - packStart}ms`);

  const installStart = Date.now();
  const installed = await runNpmAsync(["install", "--no-audit", "--no-fund", "--prefer-offline", ...tarballs], {
    cwd: consumerDir,
    timeoutMs: budget.remainingMs("isolated npm install"),
    label: "isolated npm install",
  });
  if (!installed.ok) {
    errors.push(installed.errorMessage);
    return { ok: false, errors, checks, consumerDir, cliBins: null, daemonBin: null };
  }
  checks.push(`isolated consumer install completed in ${Date.now() - installStart}ms`);

  const binCheck = await verifyInstalledPackageBins(consumerDir, { budget });
  checks.push(...binCheck.checks);
  errors.push(...binCheck.errors);
  return {
    ok: errors.length === 0,
    errors,
    checks,
    consumerDir,
    cliBins: binCheck.cliBins,
    daemonBin: binCheck.daemonBin,
  };
}

function runInstalledBinAsync(binCommand, args, options) {
  return runBoundedCommandAsync(binCommand.file, [...binCommand.argsPrefix, ...args], options);
}

async function runPackagedColdSmoke(cliBins, consumerDir, tempRoot, budget) {
  const errors = [];
  const checks = [];
  const coldHome = path.join(tempRoot, "cold-home");
  const coldRoot = path.join(tempRoot, "cold-daemon-root");
  mkdirSync(coldHome, { recursive: true });
  const env = smokeEnv(coldRoot, coldHome);

  for (const [alias, command] of [
    ["ha", cliBins.ha],
    ["harness-anything", cliBins.harnessAnything],
  ]) {
    const help = await runInstalledBinAsync(command, ["--help"], {
      cwd: consumerDir,
      env,
      timeoutMs: budget.remainingMs(`installed ${alias} --help`),
      label: `installed ${alias} --help`,
    });
    if (!help.ok) {
      errors.push(help.errorMessage);
    } else if (!/ha daemon start --service/u.test(help.stdout)) {
      errors.push(`installed ${alias} --help did not include expected daemon control usage`);
    } else if (filesBelow(coldRoot).length > 0) {
      errors.push(`installed ${alias} --help created daemon state: ${filesBelow(coldRoot).join(", ")}`);
    } else {
      checks.push(`installed ${alias} --help cold-started without daemon state`);
    }
  }

  const coldStatus = parseCliResult(
    await runInstalledBinAsync(cliBins.ha, ["--json", "daemon", "status", "--user-root", coldRoot], {
      cwd: consumerDir,
      env,
      timeoutMs: budget.remainingMs("installed ha cold daemon status"),
      label: "installed ha cold daemon status",
    }),
  );
  if (coldStatus.status === 0 || coldStatus.receipt?.code !== "daemon_unavailable") {
    errors.push(
      `installed ha cold daemon status did not fail closed as daemon_unavailable: ${coldStatus.stdout}${coldStatus.stderr}`,
    );
  } else if (filesBelow(coldRoot).length > 0) {
    errors.push(`installed ha cold daemon status created state: ${filesBelow(coldRoot).join(", ")}`);
  } else {
    checks.push("installed ha cold daemon status failed closed as daemon_unavailable");
  }

  return { ok: errors.length === 0, errors, checks };
}

async function gitExec(cwd, args, budget, label) {
  const result = await runBoundedCommandAsync("git", args, {
    cwd,
    env: sanitizedHostEnv({
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? path.join(cwd, ".gitconfig-empty") : "/dev/null",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? path.join(cwd, ".gitconfig-empty") : "/dev/null",
    }),
    timeoutMs: budget.remainingMs(label),
    label,
  });
  if (!result.ok) throw new Error(result.errorMessage);
}

export async function runPackagedDaemonAndEdgeSmoke({ cliBins, tempRoot, budget }) {
  const errors = [];
  const checks = [];
  const record = (label, ok, detail) => {
    if (ok) checks.push(label);
    else errors.push(`${label}: ${detail}`);
  };

  const originGit = path.join(tempRoot, "origin.git");
  const seedRepo = path.join(tempRoot, "seed");
  const centerRepo = path.join(tempRoot, "center-repo");
  const centerUser = path.join(tempRoot, "center-user");
  const centerHome = path.join(tempRoot, "center-home");
  const edgeRepo = path.join(tempRoot, "edge-repo");
  const edgeUser = path.join(tempRoot, "edge-user");
  const edgeHome = path.join(tempRoot, "edge-home");
  const tlsKey = path.join(tempRoot, "fleet-localhost.key");
  const tlsCert = path.join(tempRoot, "fleet-localhost.crt");

  mkdirSync(originGit, { recursive: true });
  mkdirSync(seedRepo, { recursive: true });
  mkdirSync(centerHome, { recursive: true });
  mkdirSync(edgeHome, { recursive: true });

  await generateLocalhostTlsCert(tlsKey, tlsCert, tempRoot, budget);
  const centerPort = await reserveLoopbackPort();

  await gitExec(originGit, ["init", "--bare", "-q", "--initial-branch=main"], budget, "git init origin");
  await gitExec(seedRepo, ["init", "-q", "--initial-branch=main"], budget, "git init seed");
  await gitExec(seedRepo, ["config", "user.name", "ARM64 Smoke"], budget, "git config seed");
  await gitExec(seedRepo, ["config", "user.email", "arm64-smoke@harness.invalid"], budget, "git config seed");
  writeFileSync(path.join(seedRepo, "README.md"), "# ARM64 Smoke Repository\n");
  await gitExec(seedRepo, ["add", "README.md"], budget, "git add seed");
  await gitExec(seedRepo, ["commit", "-qm", "seed"], budget, "git commit seed");
  await gitExec(seedRepo, ["remote", "add", "origin", originGit], budget, "git remote seed");
  await gitExec(seedRepo, ["push", "-q", "origin", "main"], budget, "git push seed");
  await gitExec(tempRoot, ["clone", "-q", originGit, centerRepo], budget, "git clone center");
  await gitExec(tempRoot, ["clone", "-q", originGit, edgeRepo], budget, "git clone edge");
  for (const repo of [centerRepo, edgeRepo]) {
    await gitExec(repo, ["config", "user.name", "ARM64 Smoke"], budget, "git config repo");
    await gitExec(repo, ["config", "user.email", "arm64-smoke@harness.invalid"], budget, "git config repo");
  }

  const centerEnv = { ...smokeEnv(centerUser, centerHome), NODE_EXTRA_CA_CERTS: tlsCert };
  const edgeEnv = { ...smokeEnv(edgeUser, edgeHome), NODE_EXTRA_CA_CERTS: tlsCert };
  const runPackagedCli = async (
    binCommand,
    alias,
    repo,
    env,
    args,
    input,
    timeoutMs = budget.remainingMs(`${alias} ${args.slice(0, 3).join(" ")}`),
  ) =>
    parseCliResult(
      await runInstalledBinAsync(binCommand, ["--root", repo, "--json", ...args], {
        cwd: repo,
        env,
        input,
        timeoutMs,
        label: `${alias} ${args.slice(0, 3).join(" ")}`,
      }),
    );
  const center = (args, input) => runPackagedCli(cliBins.ha, "ha", centerRepo, centerEnv, args, input);
  const centerFullAlias = (args, input) =>
    runPackagedCli(cliBins.harnessAnything, "harness-anything", centerRepo, centerEnv, args, input);
  const edge = (args, input) => runPackagedCli(cliBins.ha, "ha", edgeRepo, edgeEnv, args, input);

  let identity = null;
  let centerDaemonStarted = false;
  let centerDaemonStopped = false;
  let edgeDaemonStarted = false;
  let edgeDaemonStopped = false;

  try {
    identity = await smokeIdentity(tempRoot, "arm64smoke", {
      tls: { key: readFileSync(tlsKey, "utf8"), cert: readFileSync(tlsCert, "utf8") },
      timeoutMs: budget.remainingMs("smoke identity startup"),
    });
    identity.configure(centerUser);

    const centerStarted = await center(["daemon", "start", "--service"]);
    centerDaemonStarted = centerStarted.status === 0 && centerStarted.receipt?.ok === true;
    record(
      "packaged center daemon starts",
      centerDaemonStarted,
      `exit ${centerStarted.status} ${centerStarted.stderr.trim() || centerStarted.stdout.trim()}`,
    );
    if (!centerDaemonStarted) return { ok: false, errors, checks };

    await identity.prepareAsync(center);
    checks.push("external HTTPS OIDC bootstrap-admin and center login succeeded");

    const initialized = await center([
      "init",
      "--repo-id",
      "arm64smoke",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    record(
      "packaged center init publishes scaffold",
      initialized.status === 0 && initialized.receipt?.outcome === "applied",
      `exit ${initialized.status} ${initialized.stderr.trim() || JSON.stringify(initialized.receipt)}`,
    );
    if (initialized.status !== 0) return { ok: false, errors, checks };

    const centerConfigPath = path.join(centerRepo, "harness/harness.yaml");
    record(
      "center harness.yaml exists with LF line endings",
      existsSync(centerConfigPath) && !readFileSync(centerConfigPath, "utf8").includes("\r"),
      `${centerConfigPath} missing or contains CR`,
    );

    const centerStatus = await centerFullAlias(["daemon", "status"]);
    record(
      "installed harness-anything alias answers center daemon status from dist",
      centerStatus.status === 0 && centerStatus.receipt?.ok === true && centerStatus.receipt?.entry === "dist",
      `exit ${centerStatus.status} ${centerStatus.stderr.trim() || JSON.stringify(centerStatus.receipt)}`,
    );

    const created = await center([
      "task",
      "create",
      "--admin",
      "--id",
      "arm64-center-task",
      "--title",
      "ARM64 Center Task",
    ]);
    record(
      "center publishes initial task",
      created.status === 0 && created.receipt?.outcome === "applied",
      `exit ${created.status} ${created.stderr.trim() || JSON.stringify(created.receipt)}`,
    );

    const fact = await center([
      "fact",
      "record",
      "--task",
      "arm64-center-task",
      "--statement",
      "ARM64 center fact for edge verification.",
      "--source",
      "linux-arm64-smoke",
    ]);
    record("center publishes fact", fact.status === 0, `exit ${fact.status} ${fact.stderr.trim()}`);

    const fleetStarted = await center([
      "daemon",
      "fleet",
      "center",
      "start",
      "--port",
      String(centerPort),
      "--bind",
      "127.0.0.1",
      "--external-url",
      `https://localhost:${centerPort}`,
      "--key",
      tlsKey,
      "--cert",
      tlsCert,
      "--repo",
      "arm64smoke",
      "--quota-bytes",
      "67108864",
    ]);
    const boundPort = Number(fleetStarted.receipt?.port);
    record(
      "center starts Fleet TLS listener",
      fleetStarted.status === 0 && fleetStarted.receipt?.ok === true && boundPort === centerPort,
      `exit ${fleetStarted.status} ${fleetStarted.stderr.trim() || JSON.stringify(fleetStarted.receipt)}`,
    );
    if (boundPort !== centerPort) return { ok: false, errors, checks };

    const invite = await center([
      "bootstrap",
      "--operation",
      "edge-join-create",
      "--person-id",
      "owner",
      "--join-repo",
      "arm64smoke",
      "--join-group",
      "admin",
    ]);
    const inviteLink = typeof invite.receipt?.link === "string" ? invite.receipt.link : "";
    record(
      "center creates pinned Fleet edge join invitation",
      invite.status === 0 && invite.receipt?.ok === true && inviteLink.startsWith("harness-edge://join/"),
      `exit ${invite.status} ${invite.stderr.trim() || JSON.stringify(invite.receipt)}`,
    );
    if (!inviteLink.startsWith("harness-edge://join/")) return { ok: false, errors, checks };

    const edgeStarted = await edge(["daemon", "start", "--service"]);
    edgeDaemonStarted = edgeStarted.status === 0 && edgeStarted.receipt?.ok === true;
    record(
      "isolated edge daemon starts without local rbac config",
      edgeDaemonStarted && !existsSync(path.join(edgeUser, "rbac", "config.json")),
      `exit ${edgeStarted.status} ${edgeStarted.stderr.trim() || edgeStarted.stdout.trim()}`,
    );
    if (!edgeDaemonStarted) return { ok: false, errors, checks };

    const edgeJoined = parseCliResult(
      await runInstalledBinAsync(
        cliBins.harnessAnything,
        ["--json", "edge", "join", inviteLink, "--root", edgeRepo, "--quota-bytes", "67108864"],
        {
          cwd: tempRoot,
          env: edgeEnv,
          timeoutMs: budget.remainingMs("harness-anything edge join"),
          label: "harness-anything edge join",
        },
      ),
    );
    record(
      "edge joins center over pinned TLS via installed harness-anything alias, authenticates via external OIDC, and completes initial sync",
      edgeJoined.status === 0 && edgeJoined.receipt?.ok === true,
      `exit ${edgeJoined.status} ${edgeJoined.stderr.trim() || JSON.stringify(edgeJoined.receipt)}`,
    );
    if (edgeJoined.status !== 0) return { ok: false, errors, checks };

    const initialEdgeList = await edge(["task", "list"]);
    const initialRows = Array.isArray(initialEdgeList.receipt?.rows) ? initialEdgeList.receipt.rows : [];
    const hasInitialTask = initialRows.some(
      (row) => row?.taskId === "arm64-center-task" && row?.title === "ARM64 Center Task",
    );
    record(
      "edge reads back center task through isolated edge daemon",
      initialEdgeList.status === 0 && initialEdgeList.receipt?.ok === true && hasInitialTask,
      `exit ${initialEdgeList.status} rows=${JSON.stringify(initialRows)} stderr=${initialEdgeList.stderr.trim()}`,
    );

    const deltaCreated = await center([
      "task",
      "create",
      "--admin",
      "--id",
      "arm64-edge-delta",
      "--title",
      "ARM64 Edge Delta Task",
    ]);
    record(
      "center publishes second task for discriminating edge propagation check",
      deltaCreated.status === 0 && deltaCreated.receipt?.outcome === "applied",
      `exit ${deltaCreated.status} ${deltaCreated.stderr.trim() || JSON.stringify(deltaCreated.receipt)}`,
    );
    let deltaEdgeList = await edge(["task", "list"]);
    let deltaRows = Array.isArray(deltaEdgeList.receipt?.rows) ? deltaEdgeList.receipt.rows : [];
    const hasBoth = (rows) =>
      rows.some((row) => row?.taskId === "arm64-center-task") &&
      rows.some((row) => row?.taskId === "arm64-edge-delta" && row?.title === "ARM64 Edge Delta Task");
    for (let attempt = 0; !hasBoth(deltaRows) && attempt < 15; attempt += 1) {
      deltaEdgeList = await edge(["task", "list"]);
      deltaRows = Array.isArray(deltaEdgeList.receipt?.rows) ? deltaEdgeList.receipt.rows : [];
    }
    record(
      "edge discriminating readback reflects live center delta",
      deltaEdgeList.status === 0 && deltaEdgeList.receipt?.ok === true && hasBoth(deltaRows),
      `exit ${deltaEdgeList.status} rows=${JSON.stringify(deltaRows)} stderr=${deltaEdgeList.stderr.trim()}`,
    );

    const edgeStopped = await edge(["daemon", "stop"]);
    const edgeStopOk = edgeStopped.status === 0 && edgeStopped.receipt?.ok === true;
    record(
      "edge daemon stops cleanly",
      edgeStopOk,
      `exit ${edgeStopped.status} receipt=${JSON.stringify(edgeStopped.receipt)} stderr=${edgeStopped.stderr.trim()}`,
    );
    let edgeAfter = await edge(["daemon", "status"]);
    for (
      let attempt = 0;
      (edgeAfter.status === 0 || edgeAfter.receipt?.code === "daemon_stopping") && attempt < STOP_SETTLE_POLLS;
      attempt += 1
    ) {
      await delay(100);
      edgeAfter = await edge(["daemon", "status"]);
    }
    const edgeGone = isConfirmedDaemonGone(edgeAfter) && !daemonPidAlive(edgeUser);
    edgeDaemonStopped = edgeStopOk && edgeGone;
    record(
      "edge daemon reports gone after stop",
      edgeGone,
      `status=${edgeAfter.status} timedOut=${Boolean(edgeAfter.timedOut)} code=${edgeAfter.receipt?.code ?? "none"} pidAlive=${daemonPidAlive(edgeUser)}`,
    );

    const centerStopped = await center(["daemon", "stop"]);
    const centerStopOk = centerStopped.status === 0 && centerStopped.receipt?.ok === true;
    record(
      "center daemon stops cleanly",
      centerStopOk,
      `exit ${centerStopped.status} receipt=${JSON.stringify(centerStopped.receipt)} stderr=${centerStopped.stderr.trim()}`,
    );
    let centerAfter = await center(["daemon", "status"]);
    for (
      let attempt = 0;
      (centerAfter.status === 0 || centerAfter.receipt?.code === "daemon_stopping") && attempt < STOP_SETTLE_POLLS;
      attempt += 1
    ) {
      await delay(100);
      centerAfter = await center(["daemon", "status"]);
    }
    const centerGone = isConfirmedDaemonGone(centerAfter) && !daemonPidAlive(centerUser);
    centerDaemonStopped = centerStopOk && centerGone;
    record(
      "center daemon reports gone after stop",
      centerGone,
      `status=${centerAfter.status} timedOut=${Boolean(centerAfter.timedOut)} code=${centerAfter.receipt?.code ?? "none"} pidAlive=${daemonPidAlive(centerUser)}`,
    );
  } finally {
    const edgeCleanup = await verifyDaemonStoppedAndCleanup({
      label: "edge",
      userRoot: edgeUser,
      started: edgeDaemonStarted,
      alreadyStopped: edgeDaemonStopped,
      stopDaemon: (timeoutMs) =>
        runPackagedCli(cliBins.ha, "ha", edgeRepo, edgeEnv, ["daemon", "stop"], undefined, timeoutMs),
    });
    errors.push(...edgeCleanup.errors);

    const centerCleanup = await verifyDaemonStoppedAndCleanup({
      label: "center",
      userRoot: centerUser,
      started: centerDaemonStarted,
      alreadyStopped: centerDaemonStopped,
      stopDaemon: (timeoutMs) =>
        runPackagedCli(cliBins.ha, "ha", centerRepo, centerEnv, ["daemon", "stop"], undefined, timeoutMs),
    });
    errors.push(...centerCleanup.errors);

    if (identity !== null) {
      const identityClose = await runAsyncCleanupStep("identity worker close", () => identity.close());
      errors.push(...identityClose.errors);
    }
  }

  return { ok: errors.length === 0, errors, checks };
}

export async function evaluateLinuxArm64Smoke(
  rootDir,
  {
    requireLinuxArm64 = false,
    platform = process.platform,
    arch = process.arch,
    nodeVersion = process.versions.node,
    deadlineMs = DEFAULT_DEADLINE_MS,
    now = () => Date.now(),
    runLivePty = true,
    runPackInstall = packAndInstallArm64Packages,
    runColdSmoke = runPackagedColdSmoke,
    runDaemonEdgeSmoke = runPackagedDaemonAndEdgeSmoke,
    runContractTests = true,
    onCleanup,
  } = {},
) {
  const budget = createDeadlineBudget(deadlineMs, now);
  const errors = [];
  const checks = [];
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ha-arm64-smoke-"));

  const runStage = async (name, fn) => {
    const stageStart = now();
    let stageOk = false;
    try {
      budget.remainingMs(name);
      const result = await fn();
      if (result) {
        if (Array.isArray(result.checks)) checks.push(...result.checks);
        if (Array.isArray(result.errors)) errors.push(...result.errors);
      }
      const overtime = budget.checkAfter(name);
      if (overtime) errors.push(overtime);
      stageOk = (!result || result.ok !== false) && overtime === null;
      return result;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      stageOk = false;
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)], checks: [] };
    } finally {
      budget.recordStage(name, stageStart, stageOk);
    }
  };

  try {
    await runStage("host-arch", () => verifyHostArchitecture({ platform, arch, nodeVersion, requireLinuxArm64 }));
    if (!budget.isExpired()) {
      await runStage("native-modules", async () => {
        const pty = await verifyNodePty({
          platform,
          arch,
          runLivePty,
          timeoutMs: budget.remainingMs("native-modules"),
        });
        const sqlite = verifyNodeSqlite();
        return {
          ok: pty.ok && sqlite.ok,
          checks: [...pty.checks, ...sqlite.checks],
          errors: [...pty.errors, ...sqlite.errors],
        };
      });
    }

    const packed = budget.isExpired()
      ? null
      : await runStage("build-and-pack", () => runPackInstall(rootDir, { tempRoot, budget }));

    if (!budget.isExpired() && packed?.ok && packed.cliBins) {
      await runStage("packaged-cli-cold", () =>
        runColdSmoke(packed.cliBins, packed.consumerDir ?? tempRoot, tempRoot, budget),
      );
      if (!budget.isExpired()) {
        await runStage("daemon-and-edge-smoke", () =>
          runDaemonEdgeSmoke({ cliBins: packed.cliBins, tempRoot, budget }),
        );
      }
    }

    if (runContractTests && !budget.isExpired()) {
      await runStage("contract-tests", async () => {
        const args = ["tools/run-node-tests.mjs", ...ARM64_CONTRACT_TESTS.flatMap((file) => ["--file", file])];
        const contractRun = await runBoundedCommandAsync(process.execPath, args, {
          cwd: rootDir,
          env: sanitizedHostEnv(),
          timeoutMs: budget.remainingMs("contract-tests"),
          label: "linux-arm64 contract tests",
        });
        if (!contractRun.ok) {
          return { ok: false, errors: [contractRun.errorMessage], checks: [] };
        }
        return {
          ok: true,
          errors: [],
          checks: [`linux-arm64 contract tests passed (${ARM64_CONTRACT_TESTS.length} files)`],
        };
      });
    }
  } finally {
    if (onCleanup) {
      const callbackCleanup = await runAsyncCleanupStep("cleanup callback", () => onCleanup());
      errors.push(...callbackCleanup.errors);
    }
    const tempCleanup = removeDirectorySafely(tempRoot, "tempRoot cleanup");
    errors.push(...tempCleanup.errors);
  }

  return {
    ok: errors.length === 0 && budget.elapsedMs() <= deadlineMs,
    errors,
    checks,
    stages: budget.stages,
    totalMs: budget.elapsedMs(),
    deadlineMs,
  };
}

function parseDeadlineArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--deadline-ms") {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return DEFAULT_DEADLINE_MS;
}

export async function main(argv = process.argv.slice(2)) {
  const requireLinuxArm64 = argv.includes("--require-linux-arm64");
  const deadlineMs = parseDeadlineArg(argv);
  const result = await evaluateLinuxArm64Smoke(repoRoot(), { requireLinuxArm64, deadlineMs });
  for (const check of result.checks) console.log(`linux-arm64-smoke: ${check}`);
  for (const stage of result.stages) {
    console.log(`linux-arm64-smoke: stage ${stage.name} ${stage.durationMs}ms (${stage.ok ? "ok" : "failed"})`);
  }
  console.log(`linux-arm64-smoke: total ${result.totalMs}ms / ${result.deadlineMs}ms`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`linux-arm64-smoke: ${error}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
