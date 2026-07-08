#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { chmod, cp, mkdir, rename, rm } from "node:fs/promises";
import https from "node:https";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const nodeVersion = process.env.HARNESS_GUI_NODE_VERSION ?? process.versions.node;
const guiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(guiRoot, "../..");
const platform = process.platform;
const arch = process.arch;
const runtimeId = `${platform}-${arch}`;
const supportedRuntimeIds = new Set(["darwin-arm64", "win32-x64", "linux-x64"]);
const nodeDistPlatform = platform === "win32" ? "win" : platform;
const nodeArchiveExt = platform === "win32" ? ".zip" : platform === "linux" ? ".tar.xz" : ".tar.gz";
const nodeArchiveBase = `node-v${nodeVersion}-${nodeDistPlatform}-${arch}`;
const nodeArchiveName = `${nodeArchiveBase}${nodeArchiveExt}`;
const nodeArchiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`;
const nodeExecutableName = platform === "win32" ? "node.exe" : "node";
const npmExecutableName = platform === "win32" ? "npm.cmd" : "npm";
const cacheDir = join(guiRoot, ".runtime-cache");
const archivePath = join(cacheDir, nodeArchiveName);
const nodeRuntimeDir = join(guiRoot, "build-resources/node", runtimeId);
const appNodeModulesDir = join(guiRoot, "build-resources/app-node_modules");

if (!supportedRuntimeIds.has(runtimeId)) {
  throw new Error(`GUI packaging supports darwin-arm64, win32-x64, and linux-x64; got ${runtimeId}.`);
}

await prepareNodeRuntime();
await prepareDaemonNodeModules();
invalidateGuiTypecheckCache();

console.log(`[prepare-desktop-runtime] Node ${nodeVersion} prepared at ${relative(repoRoot, nodeRuntimeDir)}`);
console.log(`[prepare-desktop-runtime] daemon node_modules prepared at ${relative(repoRoot, appNodeModulesDir)}`);

function invalidateGuiTypecheckCache() {
  // Vite rebuilds packages/gui/dist for packaging; the composite tsbuildinfo
  // must not claim the overwritten declaration outputs are still current.
  rmSync(join(guiRoot, "tsconfig.tsbuildinfo"), { force: true });
}

async function prepareNodeRuntime() {
  await mkdir(cacheDir, { recursive: true });
  if (!existsSync(archivePath)) {
    console.log(`[prepare-desktop-runtime] downloading ${nodeArchiveUrl}`);
    await download(nodeArchiveUrl, archivePath);
  }

  const extractDir = join(cacheDir, `${nodeArchiveBase}-extract`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  extractNodeArchive(extractDir);

  const unpackedRoot = join(extractDir, nodeArchiveBase);
  await rm(nodeRuntimeDir, { recursive: true, force: true });
  await mkdir(nodeRuntimeDir, { recursive: true });
  const sourceNodePath = platform === "win32" ? join(unpackedRoot, nodeExecutableName) : join(unpackedRoot, "bin", nodeExecutableName);
  await cp(sourceNodePath, join(nodeRuntimeDir, nodeExecutableName));
  await cp(join(unpackedRoot, "LICENSE"), join(nodeRuntimeDir, "LICENSE"));
  await cp(join(unpackedRoot, "README.md"), join(nodeRuntimeDir, "README.md"));
  if (platform !== "win32") {
    await chmod(join(nodeRuntimeDir, nodeExecutableName), 0o755);
  }
}

function extractNodeArchive(extractDir) {
  if (platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Expand-Archive -LiteralPath $env:NODE_ARCHIVE_PATH -DestinationPath $env:NODE_EXTRACT_DIR -Force"
    ], {
      env: { ...process.env, NODE_ARCHIVE_PATH: archivePath, NODE_EXTRACT_DIR: extractDir },
      stdio: "inherit"
    });
    return;
  }

  const extractFlag = nodeArchiveExt === ".tar.xz" ? "-xJf" : "-xzf";
  execFileSync("tar", [extractFlag, archivePath, "-C", extractDir], { stdio: "inherit" });
}

async function prepareDaemonNodeModules() {
  rmSync(appNodeModulesDir, { recursive: true, force: true });
  mkdirSync(appNodeModulesDir, { recursive: true });

  const dependencyPaths = execFileSync(npmExecutableName, ["ls", "--workspace", "@harness-anything/cli", "--omit=dev", "--parseable", "--all"], {
    cwd: repoRoot,
    encoding: "utf8"
  }).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);

  const nodeModulesRoot = join(repoRoot, "node_modules");
  for (const dependencyPath of dependencyPaths) {
    if (!dependencyPath.startsWith(nodeModulesRoot)) continue;
    const packageName = relative(nodeModulesRoot, dependencyPath);
    if (!packageName || packageName === "@harness-anything/cli") continue;
    const target = join(appNodeModulesDir, packageName);
    await mkdir(dirname(target), { recursive: true });
    await cp(dependencyPath, target, {
      recursive: true,
      dereference: true,
      force: true,
      filter: (source) => !source.includes(`${basename(dependencyPath)}/.git`)
    });
  }
}

async function download(url, destination) {
  const tmpPath = `${destination}.tmp`;
  await rm(tmpPath, { force: true });
  await new Promise((resolveDownload, rejectDownload) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        rejectDownload(new Error(`download failed with HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const file = createWriteStream(tmpPath);
      response.pipe(file);
      file.on("finish", () => file.close(resolveDownload));
      file.on("error", rejectDownload);
    });
    request.setTimeout(120_000, () => {
      request.destroy(new Error(`download timed out after 120s: ${url}`));
    });
    request.on("error", rejectDownload);
  });
  await rename(tmpPath, destination);
}
