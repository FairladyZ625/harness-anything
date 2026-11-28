// Build isolation, dist provisioning, and cross-platform tree-copy helpers for
// tools/old-data-copy-evidence.mjs. Extracted so each module stays cohesive and below the
// repository file-complexity ceiling while old-data-copy-evidence.mjs re-exports all public helpers.
import { spawnSync } from "node:child_process";
import { cp, copyFile, link } from "node:fs/promises";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { cmdShellInvocation } from "../packages/storage/src/store/cmd-command-line.ts";
import { materialize } from "./readonly-checkout.mjs";

const PROGRESS_INTERVAL_MS = 15_000;
const NATIVE_COPY_CONCURRENCY = 16;
const NATIVE_COPY_EXPAND_DEPTH = 4;

const EXCLUDED_BUILD_PACKAGE_DIRS = new Set([
  "node_modules",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "examples",
  "docs",
  "build-resources",
  "dist-electron",
  ".runtime-cache",
]);

const WIN32_VERBATIM_SPAWN =
  "const { spawnSync } = require('node:child_process');" +
  "const inv = JSON.parse(process.argv[1]);" +
  "const res = spawnSync(inv.command, inv.args, { stdio: 'inherit', windowsVerbatimArguments: Boolean(inv.windowsVerbatimArguments) });" +
  "process.exit(res.status ?? 1);";

export function reportProgress(message) {
  console.error(`[old-data-copy] ${message}`);
}

export async function withProgressHeartbeat(label, operation, intervalMs = PROGRESS_INTERVAL_MS) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    reportProgress(`${label} running (${elapsedSec}s elapsed)`);
  }, intervalMs);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

export function isInsideDir(parentDir, targetPath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function joinCrossPlatform(baseDir, ...parts) {
  return baseDir.includes("\\") ? path.win32.join(baseDir, ...parts) : path.join(baseDir, ...parts);
}

export function dirnameCrossPlatform(targetPath) {
  return targetPath.includes("\\") ? path.win32.dirname(targetPath) : path.dirname(targetPath);
}

/** Tree-copy flags: clone blocks instead of rewriting them wherever the filesystem supports it
 *  (APFS clonefile on darwin, reflink on linux filesystems that have it). */
export function copyTreeArgs(platform = process.platform) {
  if (platform === "darwin") return ["-cR"];
  if (platform === "linux") return ["-a", "--reflink=auto"];
  if (platform === "win32") return [];
  return ["-a"];
}

export function copyTreeMethod(platform = process.platform) {
  if (platform === "win32") return "node fs.cp recursive";
  return copyTreeArgs(platform).join(" ");
}

function externalCpAvailable(platform = process.platform, environment = process.env) {
  if (platform === "win32") return false;
  const pathEnv = environment.PATH ?? environment.Path ?? "";
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    if (existsSync(path.join(dir, "cp"))) return true;
  }
  return false;
}

function planNativeCopy(sourceDir, targetDir, filter, depth = 0, dirs = [], units = []) {
  if (filter && !filter(sourceDir)) return { dirs, units };
  const stat = lstatSync(sourceDir);
  if (!stat.isDirectory()) {
    units.push({ src: sourceDir, dst: targetDir });
    return { dirs, units };
  }
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (depth >= NATIVE_COPY_EXPAND_DEPTH || !entries.some((entry) => entry.isDirectory())) {
    units.push({ src: sourceDir, dst: targetDir });
    return { dirs, units };
  }
  dirs.push(targetDir);
  for (const entry of entries) {
    const childSrc = path.join(sourceDir, entry.name);
    const childDst = path.join(targetDir, entry.name);
    if (filter && !filter(childSrc)) continue;
    if (entry.isDirectory()) planNativeCopy(childSrc, childDst, filter, depth + 1, dirs, units);
    else units.push({ src: childSrc, dst: childDst });
  }
  return { dirs, units };
}

/** Copy a directory tree using platform block-cloning (`cp`) on POSIX and falling back to
 *  Node's `fs.promises.cp` (fanned out across wide bucket directories with bounded progress
 *  heartbeats) on Windows or when external `cp` is unavailable. */
export async function copyTreeWithRunner(runText, sourceDir, targetDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const filter = options.filter;
  const label = options.progressLabel ?? path.basename(targetDir);
  if (platform !== "win32" && !filter && externalCpAvailable(platform)) {
    await withProgressHeartbeat(`cp ${label}`, () => runText("cp", [...copyTreeArgs(platform), sourceDir, targetDir]));
    return copyTreeMethod(platform);
  }
  const { dirs, units } = planNativeCopy(sourceDir, targetDir, filter);
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  let nextIndex = 0,
    completed = 0;
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    reportProgress(`copy ${label}: ${completed}/${units.length} units (${elapsedSec}s elapsed)`);
  }, PROGRESS_INTERVAL_MS);
  timer.unref?.();
  try {
    const workerCount = Math.max(1, Math.min(NATIVE_COPY_CONCURRENCY, units.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < units.length) {
          const unit = units[nextIndex++];
          await cp(unit.src, unit.dst, {
            recursive: true,
            verbatimSymlinks: true,
            ...(filter ? { filter } : {}),
          });
          completed += 1;
        }
      }),
    );
  } finally {
    clearInterval(timer);
  }
  return "node fs.cp recursive";
}

/** Copy individual files into an existing directory, preserving filenames. */
export async function copyFilesIntoDirectoryWithRunner(runText, sources, targetDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const label = options.progressLabel ?? path.basename(targetDir);
  if (platform !== "win32" && externalCpAvailable(platform)) {
    await withProgressHeartbeat(`cp ${label}`, () => runText("cp", [...copyTreeArgs(platform), ...sources, targetDir]));
    return copyTreeMethod(platform);
  }
  await withProgressHeartbeat(`copy ${label}`, () =>
    Promise.all(sources.map((src) => copyFile(src, path.join(targetDir, path.basename(src))))),
  );
  return "node fs.cp recursive";
}

function findWin32NpmEntry(environment, execPath) {
  const pathEnv = environment.PATH ?? environment.Path ?? "";
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    const cliJs = joinCrossPlatform(dir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(cliJs)) return { kind: "node-script", scriptPath: cliJs };
    const cmdShim = joinCrossPlatform(dir, "npm.cmd");
    if (existsSync(cmdShim)) return { kind: "cmd-shim", cmdPath: cmdShim };
  }
  if (execPath) {
    const execDir = dirnameCrossPlatform(execPath);
    const besideNodeJs = joinCrossPlatform(execDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(besideNodeJs)) return { kind: "node-script", scriptPath: besideNodeJs };
    const besideNodeCmd = joinCrossPlatform(execDir, "npm.cmd");
    if (existsSync(besideNodeCmd)) return { kind: "cmd-shim", cmdPath: besideNodeCmd };
  }
  return { kind: "cmd-shim", cmdPath: "npm.cmd" };
}

/** Resolve `npm` for the target platform: on Windows, prefer the co-located `npm-cli.js`
 *  entrypoint directly under `node.exe` (avoiding `.cmd` EINVAL and shell quoting entirely), or
 *  wrap an explicit `.cmd` shim with audited BatBadBut `cmd.exe` quoting. */
export function npmInvocation(
  args,
  platform = process.platform,
  environment = process.env,
  execPath = process.execPath,
) {
  if (platform !== "win32") return { command: "npm", args, windowsVerbatimArguments: false };
  const entry = findWin32NpmEntry(environment, execPath);
  if (entry.kind === "node-script") {
    return { command: execPath, args: [entry.scriptPath, ...args], windowsVerbatimArguments: false };
  }
  return cmdShellInvocation(entry.cmdPath, args, environment);
}

export async function resolveBuild(buildArg, tempRoot, sourceRoot) {
  if (!buildArg) return { root: sourceRoot, requested: "<invoking checkout>", sourceArchive: false };
  if (existsSync(buildArg)) return { root: path.resolve(buildArg), requested: buildArg, sourceArchive: false };
  const archived = materialize({
    rootDir: sourceRoot,
    revision: buildArg,
    out: path.join(tempRoot, "build-checkout"),
  });
  if (!archived.ok) throw new Error(archived.detail);
  return { root: archived.destination, requested: buildArg, resolvedSha: archived.commit, sourceArchive: true };
}

function readMarkerOrNull(markerPath) {
  if (!existsSync(markerPath)) return null;
  const value = readFileSync(markerPath, "utf8").trim();
  return value || null;
}

export function headCommitOrNull(buildRoot) {
  const result = spawnSync("git", ["-C", buildRoot, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  const value = result.status === 0 ? result.stdout.trim() : null;
  return value || null;
}

/** Pure decision half of dist provisioning, so the trust table is testable without a build:
 *  whenever the checkout names a commit, the daemon dist must be stamped with that same commit,
 *  and a dist left behind by an older HEAD — the normal state of a worktree after a rebase — is
 *  rebuilt, never trusted. */
export function planDaemonDistSteps({ nodeModules, distEntry, head, marker }) {
  const steps = [];
  if (!nodeModules) steps.push({ command: "npm", args: ["ci"] });
  if (!distEntry || (head !== null && marker !== head))
    steps.push({ command: "npm", args: ["run", "build", "--workspace", "@harness-anything/daemon"] });
  return steps;
}

function discoverWorkspacePackages(checkoutRoot) {
  const packagesDir = path.join(checkoutRoot, "packages");
  const map = new Map();
  if (!existsSync(packagesDir)) return map;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (typeof pkgJson?.name === "string" && pkgJson.name.length > 0) map.set(pkgJson.name, pkgDir);
  }
  return map;
}

/** True when `<checkoutRoot>/node_modules` has workspace links (`@harness-anything/*`) missing
 *  or resolving outside `checkoutRoot` — the exact shape Windows `.worktrees/<id>` produces when
 *  `mirrorNodeModules` copies absolute NTFS Junctions pointing at canonical `packages/*`. */
export function externalWorkspaceLinks(checkoutRoot) {
  const nodeModules = path.join(checkoutRoot, "node_modules");
  if (!existsSync(nodeModules)) return false;
  const realRoot = realpathSync(checkoutRoot);
  for (const [pkgName] of discoverWorkspacePackages(checkoutRoot)) {
    const linkPath = path.join(nodeModules, ...pkgName.split("/"));
    if (!existsSync(linkPath)) return true;
    const resolved = realpathSync(linkPath);
    if (!isInsideDir(realRoot, resolved)) return true;
  }
  return false;
}

/** Mirror third-party dependencies from `donorRoot/node_modules` into `targetRoot/node_modules`
 *  while pointing every workspace package (`@harness-anything/*`) at `targetRoot/packages/*`.
 *  Never mutates `donorRoot`. */
export function mirrorWorkspaceNodeModules(donorRoot, targetRoot) {
  const workspacePackages = discoverWorkspacePackages(targetRoot);
  const mirrorDir = (relative, scopePrefix = "") => {
    const srcDir = path.join(donorRoot, relative);
    const dstDir = path.join(targetRoot, relative);
    mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const relChild = path.join(relative, entry.name);
      const srcPath = path.join(donorRoot, relChild);
      const dstPath = path.join(targetRoot, relChild);
      if (entry.isDirectory() && entry.name.startsWith("@")) {
        mirrorDir(relChild, `${entry.name}/`);
        continue;
      }
      const pkgKey = relative === "node_modules" || scopePrefix ? `${scopePrefix}${entry.name}` : null;
      if (pkgKey && workspacePackages.has(pkgKey)) continue;
      if (!existsSync(srcPath)) continue;
      const resolved = entry.isSymbolicLink() ? realpathSync(srcPath) : srcPath;
      const isDir = statSync(resolved).isDirectory();
      if (!isDir && process.platform === "win32") {
        copyFileSync(resolved, dstPath);
      } else {
        symlinkSync(resolved, dstPath, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file");
      }
    }
  };
  mirrorDir("node_modules");
  for (const [pkgName, pkgDir] of workspacePackages) {
    const dstPath = path.join(targetRoot, "node_modules", ...pkgName.split("/"));
    mkdirSync(path.dirname(dstPath), { recursive: true });
    if (existsSync(dstPath)) continue;
    if (process.platform === "win32") symlinkSync(pkgDir, dstPath, "junction");
    else symlinkSync(path.relative(path.dirname(dstPath), pkgDir), dstPath, "dir");
  }
}

function includedBuildPackageEntry(packagesSrc, entryPath) {
  const rel = path.relative(packagesSrc, entryPath);
  if (!rel) return true;
  const segments = rel.split(path.sep);
  if (segments.some((seg) => EXCLUDED_BUILD_PACKAGE_DIRS.has(seg))) return false;
  if (segments[0] === "gui" && segments.length >= 2 && segments[1] !== "package.json") return false;
  if (rel.endsWith(".map") || rel.endsWith(".d.ts")) return false;
  return true;
}

async function stageBuildPackages(packagesSrc, packagesDst, { hardlinkDist = false } = {}) {
  const dirs = [];
  const files = [];
  const walk = (srcDir, dstDir, insideDist) => {
    dirs.push(dstDir);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const childSrc = path.join(srcDir, entry.name);
      if (!includedBuildPackageEntry(packagesSrc, childSrc)) continue;
      const childDst = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        walk(childSrc, childDst, insideDist || entry.name === "dist");
      } else if (entry.isFile()) {
        files.push({ src: childSrc, dst: childDst, copyOnly: insideDist && !hardlinkDist });
      }
    }
  };
  walk(packagesSrc, packagesDst, false);
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  let nextIndex = 0;
  let hardlinkDisabled = false;
  const workerCount = Math.max(1, Math.min(NATIVE_COPY_CONCURRENCY, files.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++];
        if (!file.copyOnly && !hardlinkDisabled) {
          try {
            await link(file.src, file.dst);
            continue;
          } catch (error) {
            if (["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EROFS"].includes(error?.code)) {
              hardlinkDisabled = true;
            }
          }
        }
        await copyFile(file.src, file.dst);
      }
    }),
  );
}

export async function prepareRunnableBuild(runText, build, tempRoot, donorRoot) {
  const head = build.resolvedSha ?? headCommitOrNull(build.root);
  const buildNodeModules = path.join(build.root, "node_modules");
  const donorNodeModules = path.join(donorRoot, "node_modules");
  if (!existsSync(buildNodeModules)) {
    const donorLock = path.join(donorRoot, "package-lock.json");
    const buildLock = path.join(build.root, "package-lock.json");
    if (
      existsSync(donorNodeModules) &&
      existsSync(donorLock) &&
      existsSync(buildLock) &&
      readFileSync(donorLock).equals(readFileSync(buildLock))
    ) {
      mirrorWorkspaceNodeModules(donorRoot, build.root);
      return { ...build, requestedRoot: build.root, root: build.root, head, isolatedMirror: true };
    }
    return { ...build, requestedRoot: build.root, root: build.root, head, isolatedMirror: false };
  }
  if (!externalWorkspaceLinks(build.root))
    return { ...build, requestedRoot: build.root, root: build.root, head, isolatedMirror: false };
  const isolatedRoot = path.join(tempRoot, "runnable-build");
  mkdirSync(isolatedRoot, { recursive: true });
  for (const rootFile of ["package.json", "package-lock.json", "tsconfig.json"]) {
    const src = path.join(build.root, rootFile);
    if (existsSync(src)) copyFileSync(src, path.join(isolatedRoot, rootFile));
  }
  const packagesSrc = path.join(build.root, "packages");
  const distAlreadyStamped =
    existsSync(path.join(build.root, "packages", "daemon", "dist", "index.js")) &&
    (head === null || readMarkerOrNull(path.join(build.root, "packages", "daemon", "dist", "build-id.txt")) === head);
  if (existsSync(packagesSrc)) {
    await withProgressHeartbeat("stage runnable-build/packages", () =>
      stageBuildPackages(packagesSrc, path.join(isolatedRoot, "packages"), { hardlinkDist: distAlreadyStamped }),
    );
  }
  mirrorWorkspaceNodeModules(build.root, isolatedRoot);
  return { ...build, requestedRoot: build.root, root: isolatedRoot, head, isolatedMirror: true };
}

export async function ensureDaemonDist(runText, buildRoot, head = headCommitOrNull(buildRoot)) {
  const plan = planDaemonDistSteps({
    nodeModules: existsSync(path.join(buildRoot, "node_modules")),
    distEntry: existsSync(path.join(buildRoot, "packages", "daemon", "dist", "index.js")),
    head,
    marker: readMarkerOrNull(path.join(buildRoot, "packages", "daemon", "dist", "build-id.txt")),
  });
  const stepEnv = head ? { ...process.env, HARNESS_BUILD_COMMIT: head } : process.env;
  for (const step of plan) {
    const inv = step.command === "npm" ? npmInvocation(step.args) : { ...step, windowsVerbatimArguments: false };
    await withProgressHeartbeat(`${step.command} ${step.args.join(" ")}`, () =>
      inv.windowsVerbatimArguments
        ? runText(process.execPath, ["-e", WIN32_VERBATIM_SPAWN, JSON.stringify(inv)], buildRoot, stepEnv)
        : runText(inv.command, inv.args, buildRoot, stepEnv),
    );
  }
  return { steps: plan.map((step) => [step.command, ...step.args].join(" ")), head };
}
