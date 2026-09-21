#!/usr/bin/env node
import { constants, copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const backupName = ".package.json.pack-backup";
export const ownerName = ".package.json.pack-owner";

export function preparePackageExports(packageRoot, ownerPid = process.ppid) {
  const paths = lifecyclePaths(packageRoot);
  recoverInterruptedPack(paths);

  copyFileSync(paths.manifest, paths.backup, constants.COPYFILE_EXCL);
  writeFileSync(paths.owner, `${ownerPid}\n`, { flag: "wx" });

  const packageJson = readJson(paths.manifest);
  if (packageJson.publishConfig?.exports === undefined) {
    restorePackageExports(packageRoot);
    throw new Error(`${paths.manifest} must define publishConfig.exports before packing`);
  }
  packageJson.exports = packageJson.publishConfig.exports;
  writeJsonAtomically(paths.manifest, packageJson);
}

export function restorePackageExports(packageRoot) {
  const paths = lifecyclePaths(packageRoot);
  if (!existsSync(paths.backup)) {
    throw new Error(`cannot restore package exports without ${paths.backup}`);
  }
  renameSync(paths.backup, paths.manifest);
  if (existsSync(paths.owner)) unlinkSync(paths.owner);
}

function recoverInterruptedPack(paths) {
  if (!existsSync(paths.backup) && !existsSync(paths.owner)) return;
  if (!existsSync(paths.backup) || !existsSync(paths.owner)) {
    throw new Error(`incomplete package exports lifecycle state beside ${paths.manifest}`);
  }

  const ownerPid = Number.parseInt(readFileSync(paths.owner, "utf8").trim(), 10);
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) {
    throw new Error(`package exports are already being prepared by process ${ownerPid}`);
  }

  renameSync(paths.backup, paths.manifest);
  unlinkSync(paths.owner);
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

function lifecyclePaths(packageRoot) {
  return {
    manifest: path.join(packageRoot, "package.json"),
    backup: path.join(packageRoot, backupName),
    owner: path.join(packageRoot, ownerName),
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.pack-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, file);
}

function main() {
  const [action] = process.argv.slice(2);
  if (action === "prepare") preparePackageExports(process.cwd());
  else if (action === "restore") restorePackageExports(process.cwd());
  else throw new Error("usage: package-exports-lifecycle.mjs <prepare|restore>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
