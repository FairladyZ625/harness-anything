import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./git.mjs";
import { normalizeRepoPath } from "./module-policy.mjs";
import { evaluatePlatformSmoke } from "./platform-smoke.mjs";
import { evaluateWindowsFirstRun } from "./windows-first-run.mjs";

const STEP_TIMEOUT_MS = 120_000;
const ARM64_CONTRACT_TESTS = Object.freeze([
  "packages/daemon/test/node-pty-prebuild.test.ts",
  "packages/daemon/test/linux-arm64-platform.test.ts",
]);

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
    const pty = await import("node-pty");
    const output = await new Promise((resolve, reject) => {
      let buffer = "";
      const child = pty.spawn(process.execPath, ["-e", 'process.stdout.write("ha-arm64-pty-ok")'], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
      });
      child.onData((chunk) => {
        buffer += chunk;
      });
      child.onExit(({ exitCode }) => {
        if (exitCode !== 0) reject(new Error(`node-pty probe exited with code ${exitCode}: ${buffer}`));
        else resolve(buffer);
      });
    });
    if (!output.includes("ha-arm64-pty-ok")) {
      errors.push(`node-pty live spawn output missing marker: ${JSON.stringify(output)}`);
    } else {
      checks.push(`node-pty native addon loaded and spawned PTY on ${platform}-${arch}`);
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
    runLivePty = true,
    runPlatformSmoke = evaluatePlatformSmoke,
    runFirstRun = evaluateWindowsFirstRun,
    runContractTests = true,
  } = {},
) {
  const errors = [];
  const checks = [];
  const merge = (result) => {
    checks.push(...result.checks);
    errors.push(...result.errors);
  };

  merge(verifyHostArchitecture({ platform, arch, nodeVersion, requireLinuxArm64 }));
  merge(await verifyNodePty({ platform, arch, runLivePty }));
  merge(verifyNodeSqlite());

  const daemon = daemonEntrypoints(rootDir);
  errors.push(...daemon.errors);
  for (const entry of daemon.entries) {
    const syntax = spawnSync(process.execPath, ["--check", entry], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      windowsHide: true,
    });
    if (syntax.status !== 0) {
      errors.push(`${path.relative(rootDir, entry)} is not parseable by node: ${(syntax.stderr ?? "").trim()}`);
    } else {
      checks.push(`${path.relative(rootDir, entry)}: parseable`);
    }
  }

  merge(runPlatformSmoke(rootDir));
  merge(await runFirstRun(rootDir));

  if (runContractTests) {
    const args = ["tools/run-node-tests.mjs", ...ARM64_CONTRACT_TESTS.flatMap((file) => ["--file", file])];
    const contractRun = spawnSync(process.execPath, args, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      windowsHide: true,
    });
    if (contractRun.status !== 0) {
      errors.push(
        `linux-arm64 contract tests failed (exit ${contractRun.status}): ${(contractRun.stderr || contractRun.stdout || "").trim()}`,
      );
    } else {
      checks.push(`linux-arm64 contract tests passed (${ARM64_CONTRACT_TESTS.length} files)`);
    }
  }

  return { ok: errors.length === 0, errors, checks };
}

export async function main(argv = process.argv.slice(2)) {
  const requireLinuxArm64 = argv.includes("--require-linux-arm64");
  const result = await evaluateLinuxArm64Smoke(repoRoot(), { requireLinuxArm64 });
  for (const check of result.checks) console.log(`linux-arm64-smoke: ${check}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`linux-arm64-smoke: ${error}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
