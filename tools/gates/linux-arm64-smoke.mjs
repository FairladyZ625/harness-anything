import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { verifyTarballArchive } from "../check-package-tarball-exports.mjs";
import { lastReceipt, smokeIdentity } from "../fixtures/smoke-identity.mjs";
import { preparePackageExports, restorePackageExports } from "../package-exports-lifecycle.mjs";
import { env as smokeEnv, workspaceDependencyClosure } from "../smoke-cli-package.mjs";
import { repoRoot } from "./git.mjs";
import { normalizeRepoPath } from "./module-policy.mjs";

export const DEFAULT_DEADLINE_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const STOP_SETTLE_POLLS = 20;
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

function createDeadlineBudget(deadlineMs, now = () => Date.now()) {
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;
  const stages = [];
  const elapsedMs = () => Math.max(0, Math.round(now() - startedAt));
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
  return { deadlineMs, startedAt, deadlineAt, stages, elapsedMs, remainingMs, checkAfter, recordStage };
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

export function daemonEntrypoints(rootDir) {
  const packagePath = path.join(rootDir, "packages/daemon/package.json");
  if (!existsSync(packagePath)) return { entries: [], errors: ["packages/daemon/package.json is missing"] };
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const targets = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const entries = [];
  const errors = [];
  for (const target of new Set(targets)) {
    const normalized = normalizeRepoPath(target);
    if (normalized === null) {
      errors.push(`Daemon bin target is not a normalized relative path: ${target}`);
      continue;
    }
    const absolutePath = path.join(rootDir, "packages/daemon", normalized);
    if (!existsSync(absolutePath)) errors.push(`Daemon bin target is not built: packages/daemon/${normalized}`);
    else entries.push(absolutePath);
  }
  if (targets.length === 0) errors.push("packages/daemon/package.json declares no bin entrypoints");
  return { entries, errors };
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
          child.kill?.();
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

function runBoundedCommand(command, args, { cwd, env, timeoutMs, input, label }) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: Math.max(1, Math.floor(timeoutMs)),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: true,
      errorMessage: `${label} timed out after ${Math.floor(timeoutMs)}ms`,
    };
  }
  if (result.error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: false,
      errorMessage: `${label} failed to spawn: ${result.error.message}`,
    };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: false,
    errorMessage:
      result.status === 0 ? null : `${label} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
  };
}

function runBoundedCommandAsync(command, args, { cwd, env, timeoutMs, label }) {
  const effectiveTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish({
        ok: false,
        status: null,
        stdout,
        stderr,
        timedOut: true,
        errorMessage: `${label} timed out after ${effectiveTimeoutMs}ms`,
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
        stdout,
        stderr,
        timedOut: false,
        errorMessage: `${label} failed to spawn: ${error.message}`,
      });
    });
    child.on("close", (status) => {
      if (timedOut) return;
      finish({
        ok: status === 0,
        status,
        stdout,
        stderr,
        timedOut: false,
        errorMessage: status === 0 ? null : `${label} exited ${status}: ${(stderr || stdout).trim()}`,
      });
    });
  });
}

function runNpm(args, options) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return runBoundedCommand(npm, args, {
    ...options,
    env: options.env ?? sanitizedHostEnv(),
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

function terminateDaemonPidFile(userRoot) {
  const pidPath = path.join(userRoot, "daemon-default.pid");
  if (!existsSync(pidPath)) return { ok: false, reason: "no_pid_file" };
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "invalid_pid" };
  try {
    process.kill(pid, "SIGKILL");
    return { ok: true, pid };
  } catch (error) {
    return { ok: false, pid, error: error instanceof Error ? error.message : String(error) };
  }
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

function generateLocalhostTlsCert(keyPath, certPath) {
  execFileSync(
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
    { stdio: "ignore" },
  );
}

async function buildWorkspacePackage(rootDir, name, budget) {
  const directory = name.slice("@harness-anything/".length);
  const packageDir = path.posix.join("packages", directory);
  const source = path.join(rootDir, packageDir);
  const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const buildScript = manifest.scripts?.["build:publish"] ? "build:publish" : "build";
  const daemonAlreadyBuilt =
    name === "@harness-anything/daemon" &&
    existsSync(path.join(source, "dist/index.js")) &&
    existsSync(path.join(source, "dist/build-id.txt"));
  if (daemonAlreadyBuilt) return { ok: true, errorMessage: null };

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
    return { ok: true, errorMessage: null };
  }

  return runNpmAsync(["run", buildScript, "-w", name], {
    cwd: rootDir,
    timeoutMs: budget.remainingMs(`build ${name}`),
    label: `build ${name}`,
  });
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

  // Typechecking runs in the dedicated PR typecheck lane; emit the workspace closure in parallel with --noCheck.
  const buildStart = Date.now();
  const buildResults = await Promise.all(workspaces.map((name) => buildWorkspacePackage(rootDir, name, budget)));
  for (const result of buildResults) {
    if (!result.ok) errors.push(result.errorMessage);
  }
  if (errors.length > 0) return { ok: false, errors, checks, consumerDir, cliEntry: null, daemonEntry: null };
  checks.push(`workspace closure compiled in ${Date.now() - buildStart}ms (${workspaces.length} packages)`);

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
        pkgChecks.push(`${name}: tarball exports and bin targets verified (${filename})`);
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
  if (errors.length > 0) return { ok: false, errors, checks, consumerDir, cliEntry: null, daemonEntry: null };
  checks.push(`tarballs packed and verified in ${Date.now() - packStart}ms`);

  const installStart = Date.now();
  const installed = runNpm(["install", "--no-audit", "--no-fund", "--prefer-offline", ...tarballs], {
    cwd: consumerDir,
    timeoutMs: budget.remainingMs("isolated npm install"),
    label: "isolated npm install",
  });
  if (!installed.ok) {
    errors.push(installed.errorMessage);
    return { ok: false, errors, checks, consumerDir, cliEntry: null, daemonEntry: null };
  }
  checks.push(`isolated consumer install completed in ${Date.now() - installStart}ms`);

  const cliEntry = path.join(consumerDir, "node_modules/@harness-anything/cli/dist/cli/src/index.js");
  const daemonEntry = path.join(consumerDir, "node_modules/@harness-anything/daemon/dist/index.js");
  for (const [label, entry] of [
    ["installed CLI bin", cliEntry],
    ["installed daemon bin", daemonEntry],
  ]) {
    if (!existsSync(entry)) {
      errors.push(`${label} is missing after isolated install: ${entry}`);
      continue;
    }
    const syntax = runBoundedCommand(process.execPath, ["--check", entry], {
      cwd: consumerDir,
      env: sanitizedHostEnv(),
      timeoutMs: budget.remainingMs(`syntax check ${label}`),
      label: `syntax check ${label}`,
    });
    if (!syntax.ok) errors.push(syntax.errorMessage);
    else checks.push(`${label}: installed and parseable`);
  }

  return { ok: errors.length === 0, errors, checks, consumerDir, cliEntry, daemonEntry };
}

function runPackagedColdSmoke(cliEntry, consumerDir, tempRoot, budget) {
  const errors = [];
  const checks = [];
  const coldHome = path.join(tempRoot, "cold-home");
  const coldRoot = path.join(tempRoot, "cold-daemon-root");
  mkdirSync(coldHome, { recursive: true });
  const env = smokeEnv(coldRoot, coldHome);

  const help = runBoundedCommand(process.execPath, [cliEntry, "--help"], {
    cwd: consumerDir,
    env,
    timeoutMs: budget.remainingMs("packaged CLI --help"),
    label: "packaged CLI --help",
  });
  if (!help.ok) {
    errors.push(help.errorMessage);
  } else if (!/ha daemon start --service/u.test(help.stdout)) {
    errors.push("packaged CLI --help did not include expected daemon control usage");
  } else if (filesBelow(coldRoot).length > 0) {
    errors.push(`packaged CLI --help created daemon state: ${filesBelow(coldRoot).join(", ")}`);
  } else {
    checks.push("packaged CLI --help cold-started without daemon state");
  }

  const coldStatus = parseCliResult(
    runBoundedCommand(process.execPath, [cliEntry, "--json", "daemon", "status", "--user-root", coldRoot], {
      cwd: consumerDir,
      env,
      timeoutMs: budget.remainingMs("packaged CLI cold daemon status"),
      label: "packaged CLI cold daemon status",
    }),
  );
  if (coldStatus.status === 0 || coldStatus.receipt?.code !== "daemon_unavailable") {
    errors.push(
      `packaged CLI cold daemon status did not fail closed as daemon_unavailable: ${coldStatus.stdout}${coldStatus.stderr}`,
    );
  } else if (filesBelow(coldRoot).length > 0) {
    errors.push(`packaged CLI cold daemon status created state: ${filesBelow(coldRoot).join(", ")}`);
  } else {
    checks.push("packaged CLI cold daemon status failed closed as daemon_unavailable");
  }

  return { ok: errors.length === 0, errors, checks };
}

function gitSync(cwd, args, timeoutMs, label) {
  const result = runBoundedCommand("git", args, {
    cwd,
    env: sanitizedHostEnv({
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? path.join(cwd, ".gitconfig-empty") : "/dev/null",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? path.join(cwd, ".gitconfig-empty") : "/dev/null",
    }),
    timeoutMs,
    label,
  });
  if (!result.ok) throw new Error(result.errorMessage);
}

export async function runPackagedDaemonAndEdgeSmoke({ cliEntry, tempRoot, budget }) {
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

  generateLocalhostTlsCert(tlsKey, tlsCert);
  const centerPort = await reserveLoopbackPort();

  gitSync(
    originGit,
    ["init", "--bare", "-q", "--initial-branch=main"],
    budget.remainingMs("git init origin"),
    "git init origin",
  );
  gitSync(seedRepo, ["init", "-q", "--initial-branch=main"], budget.remainingMs("git init seed"), "git init seed");
  gitSync(seedRepo, ["config", "user.name", "ARM64 Smoke"], budget.remainingMs("git config seed"), "git config seed");
  gitSync(
    seedRepo,
    ["config", "user.email", "arm64-smoke@harness.invalid"],
    budget.remainingMs("git config seed"),
    "git config seed",
  );
  writeFileSync(path.join(seedRepo, "README.md"), "# ARM64 Smoke Repository\n");
  gitSync(seedRepo, ["add", "README.md"], budget.remainingMs("git add seed"), "git add seed");
  gitSync(seedRepo, ["commit", "-qm", "seed"], budget.remainingMs("git commit seed"), "git commit seed");
  gitSync(seedRepo, ["remote", "add", "origin", originGit], budget.remainingMs("git remote seed"), "git remote seed");
  gitSync(seedRepo, ["push", "-q", "origin", "main"], budget.remainingMs("git push seed"), "git push seed");
  gitSync(tempRoot, ["clone", "-q", originGit, centerRepo], budget.remainingMs("git clone center"), "git clone center");
  gitSync(tempRoot, ["clone", "-q", originGit, edgeRepo], budget.remainingMs("git clone edge"), "git clone edge");
  for (const repo of [centerRepo, edgeRepo]) {
    gitSync(repo, ["config", "user.name", "ARM64 Smoke"], budget.remainingMs("git config repo"), "git config repo");
    gitSync(
      repo,
      ["config", "user.email", "arm64-smoke@harness.invalid"],
      budget.remainingMs("git config repo"),
      "git config repo",
    );
  }

  const centerEnv = { ...smokeEnv(centerUser, centerHome), NODE_EXTRA_CA_CERTS: tlsCert };
  const edgeEnv = { ...smokeEnv(edgeUser, edgeHome), NODE_EXTRA_CA_CERTS: tlsCert };
  const runPackagedCli = (repo, env, args, input, timeoutMs = budget.remainingMs(`ha ${args.slice(0, 3).join(" ")}`)) =>
    parseCliResult(
      runBoundedCommand(process.execPath, [cliEntry, "--root", repo, "--json", ...args], {
        cwd: repo,
        env,
        input,
        timeoutMs,
        label: `ha ${args.slice(0, 3).join(" ")}`,
      }),
    );
  const center = (args, input) => runPackagedCli(centerRepo, centerEnv, args, input);
  const edge = (args, input) => runPackagedCli(edgeRepo, edgeEnv, args, input);

  const identity = await smokeIdentity(tempRoot, "arm64smoke", {
    tls: { key: readFileSync(tlsKey, "utf8"), cert: readFileSync(tlsCert, "utf8") },
  });

  try {
    identity.configure(centerUser);
    const centerStarted = center(["daemon", "start", "--service"]);
    record(
      "packaged center daemon starts",
      centerStarted.status === 0 && centerStarted.receipt?.ok === true,
      `exit ${centerStarted.status} ${centerStarted.stderr.trim() || centerStarted.stdout.trim()}`,
    );
    if (centerStarted.status !== 0) return { ok: false, errors, checks };

    identity.prepare(center);
    checks.push("external HTTPS OIDC bootstrap-admin and center login succeeded");

    const initialized = center(["init", "--repo-id", "arm64smoke", "--person-id", "owner", "--display-name", "Owner"]);
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

    const centerStatus = center(["daemon", "status"]);
    record(
      "packaged center daemon status answers from dist",
      centerStatus.status === 0 && centerStatus.receipt?.ok === true && centerStatus.receipt?.entry === "dist",
      `exit ${centerStatus.status} ${centerStatus.stderr.trim() || JSON.stringify(centerStatus.receipt)}`,
    );

    const created = center(["task", "create", "--admin", "--id", "arm64-center-task", "--title", "ARM64 Center Task"]);
    record(
      "center publishes initial task",
      created.status === 0 && created.receipt?.outcome === "applied",
      `exit ${created.status} ${created.stderr.trim() || JSON.stringify(created.receipt)}`,
    );

    const fact = center([
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

    const fleetStarted = center([
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

    const invite = center([
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

    const edgeStarted = edge(["daemon", "start", "--service"]);
    record(
      "isolated edge daemon starts without local rbac config",
      edgeStarted.status === 0 &&
        edgeStarted.receipt?.ok === true &&
        !existsSync(path.join(edgeUser, "rbac", "config.json")),
      `exit ${edgeStarted.status} ${edgeStarted.stderr.trim() || edgeStarted.stdout.trim()}`,
    );
    if (edgeStarted.status !== 0) return { ok: false, errors, checks };

    const edgeJoined = parseCliResult(
      runBoundedCommand(
        process.execPath,
        [cliEntry, "--json", "edge", "join", inviteLink, "--root", edgeRepo, "--quota-bytes", "67108864"],
        {
          cwd: tempRoot,
          env: edgeEnv,
          timeoutMs: budget.remainingMs("ha edge join"),
          label: "ha edge join",
        },
      ),
    );
    record(
      "edge joins center over pinned TLS, authenticates via external OIDC, and completes initial sync",
      edgeJoined.status === 0 && edgeJoined.receipt?.ok === true,
      `exit ${edgeJoined.status} ${edgeJoined.stderr.trim() || JSON.stringify(edgeJoined.receipt)}`,
    );
    if (edgeJoined.status !== 0) return { ok: false, errors, checks };

    const initialEdgeList = edge(["task", "list"]);
    const initialRows = Array.isArray(initialEdgeList.receipt?.rows) ? initialEdgeList.receipt.rows : [];
    const hasInitialTask = initialRows.some(
      (row) => row?.taskId === "arm64-center-task" && row?.title === "ARM64 Center Task",
    );
    record(
      "edge reads back center task through isolated edge daemon",
      initialEdgeList.status === 0 && initialEdgeList.receipt?.ok === true && hasInitialTask,
      `exit ${initialEdgeList.status} rows=${JSON.stringify(initialRows)} stderr=${initialEdgeList.stderr.trim()}`,
    );

    const deltaCreated = center([
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
    let deltaEdgeList = edge(["task", "list"]);
    let deltaRows = Array.isArray(deltaEdgeList.receipt?.rows) ? deltaEdgeList.receipt.rows : [];
    const hasBoth = (rows) =>
      rows.some((row) => row?.taskId === "arm64-center-task") &&
      rows.some((row) => row?.taskId === "arm64-edge-delta" && row?.title === "ARM64 Edge Delta Task");
    for (let attempt = 0; !hasBoth(deltaRows) && attempt < 15; attempt += 1) {
      deltaEdgeList = edge(["task", "list"]);
      deltaRows = Array.isArray(deltaEdgeList.receipt?.rows) ? deltaEdgeList.receipt.rows : [];
    }
    record(
      "edge discriminating readback reflects live center delta",
      deltaEdgeList.status === 0 && deltaEdgeList.receipt?.ok === true && hasBoth(deltaRows),
      `exit ${deltaEdgeList.status} rows=${JSON.stringify(deltaRows)} stderr=${deltaEdgeList.stderr.trim()}`,
    );

    const edgeStopped = edge(["daemon", "stop"]);
    record(
      "edge daemon stops cleanly",
      edgeStopped.status === 0,
      `exit ${edgeStopped.status} ${edgeStopped.stderr.trim()}`,
    );
    let edgeAfter = edge(["daemon", "status"]);
    for (let attempt = 0; edgeAfter.status === 0 && attempt < STOP_SETTLE_POLLS; attempt += 1) {
      edgeAfter = edge(["daemon", "status"]);
    }
    record("edge daemon reports gone after stop", edgeAfter.status !== 0, "edge daemon still answering after stop");

    const centerStopped = center(["daemon", "stop"]);
    record(
      "center daemon stops cleanly",
      centerStopped.status === 0,
      `exit ${centerStopped.status} ${centerStopped.stderr.trim()}`,
    );
    let centerAfter = center(["daemon", "status"]);
    for (let attempt = 0; centerAfter.status === 0 && attempt < STOP_SETTLE_POLLS; attempt += 1) {
      centerAfter = center(["daemon", "status"]);
    }
    record(
      "center daemon reports gone after stop",
      centerAfter.status !== 0,
      "center daemon still answering after stop",
    );
  } finally {
    runPackagedCli(edgeRepo, edgeEnv, ["daemon", "stop"], undefined, CLEANUP_TIMEOUT_MS);
    runPackagedCli(centerRepo, centerEnv, ["daemon", "stop"], undefined, CLEANUP_TIMEOUT_MS);
    terminateDaemonPidFile(edgeUser);
    terminateDaemonPidFile(centerUser);
    await identity.close();
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

    const packed = await runStage("build-and-pack", () => runPackInstall(rootDir, { tempRoot, budget }));

    if (packed?.ok && packed.cliEntry) {
      await runStage("packaged-cli-cold", () =>
        runColdSmoke(packed.cliEntry, packed.consumerDir ?? tempRoot, tempRoot, budget),
      );
      await runStage("daemon-and-edge-smoke", () =>
        runDaemonEdgeSmoke({ cliEntry: packed.cliEntry, tempRoot, budget }),
      );
    }

    if (runContractTests) {
      await runStage("contract-tests", () => {
        const args = ["tools/run-node-tests.mjs", ...ARM64_CONTRACT_TESTS.flatMap((file) => ["--file", file])];
        const contractRun = runBoundedCommand(process.execPath, args, {
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
    await onCleanup?.();
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
