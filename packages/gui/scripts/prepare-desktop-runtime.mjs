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
const nodeDistPlatform = platform === "darwin" ? "darwin" : platform;
const nodeArchiveBase = `node-v${nodeVersion}-${nodeDistPlatform}-${arch}`;
const nodeArchiveName = `${nodeArchiveBase}.tar.gz`;
const nodeArchiveUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`;
const cacheDir = join(guiRoot, ".runtime-cache");
const archivePath = join(cacheDir, nodeArchiveName);
const nodeRuntimeDir = join(guiRoot, "build-resources/node", runtimeId);
const appNodeModulesDir = join(guiRoot, "build-resources/app-node_modules");

if (platform !== "darwin" || arch !== "arm64") {
  throw new Error(`W1 local GUI packaging supports only darwin-arm64; got ${platform}-${arch}.`);
}

await prepareNodeRuntime();
await prepareDaemonNodeModules();

console.log(`[prepare-desktop-runtime] Node ${nodeVersion} prepared at ${relative(repoRoot, nodeRuntimeDir)}`);
console.log(`[prepare-desktop-runtime] daemon node_modules prepared at ${relative(repoRoot, appNodeModulesDir)}`);

async function prepareNodeRuntime() {
  await mkdir(cacheDir, { recursive: true });
  if (!existsSync(archivePath)) {
    console.log(`[prepare-desktop-runtime] downloading ${nodeArchiveUrl}`);
    await download(nodeArchiveUrl, archivePath);
  }

  const extractDir = join(cacheDir, `${nodeArchiveBase}-extract`);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "inherit" });

  const unpackedRoot = join(extractDir, nodeArchiveBase);
  await rm(nodeRuntimeDir, { recursive: true, force: true });
  await mkdir(nodeRuntimeDir, { recursive: true });
  await cp(join(unpackedRoot, "bin/node"), join(nodeRuntimeDir, "node"));
  await cp(join(unpackedRoot, "LICENSE"), join(nodeRuntimeDir, "LICENSE"));
  await cp(join(unpackedRoot, "README.md"), join(nodeRuntimeDir, "README.md"));
  await chmod(join(nodeRuntimeDir, "node"), 0o755);
}

async function prepareDaemonNodeModules() {
  rmSync(appNodeModulesDir, { recursive: true, force: true });
  mkdirSync(appNodeModulesDir, { recursive: true });

  const dependencyPaths = execFileSync("npm", ["ls", "--workspace", "@harness-anything/cli", "--omit=dev", "--parseable", "--all"], {
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
    request.on("error", rejectDownload);
  });
  await rename(tmpPath, destination);
}
