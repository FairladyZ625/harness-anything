#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { publicWorkspaceNamesTopologically, readWorkspacePackages } from "./public-workspaces.mjs";

const root = resolve(process.env.RELEASE_ROOT ?? new URL("..", import.meta.url).pathname);
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  console.error("Usage: node tools/release-version.mjs <semver> (for example 0.1.0-rc.1)");
  process.exit(2);
}

const packages = readWorkspacePackages(root);
const publicNames = new Set(publicWorkspaceNamesTopologically(root));
const internalSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function alignInternalDependencies(manifest) {
  for (const section of internalSections) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      if (publicNames.has(name) && value !== "*") manifest[section][name] = version;
    }
  }
}

const rootManifest = readJson(join(root, "package.json"));
rootManifest.version = version;
alignInternalDependencies(rootManifest);
writeJson(join(root, "package.json"), rootManifest);

let updated = 0;
for (const entry of packages) {
  const file = join(root, entry.packagePath);
  const manifest = readJson(file);
  if (publicNames.has(manifest.name)) {
    manifest.version = version;
    updated += 1;
  }
  alignInternalDependencies(manifest);
  writeJson(file, manifest);
}

const lockPath = join(root, "package-lock.json");
try {
  const lock = readJson(lockPath);
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (packagePath === "" || packagePath === "package.json") {
      entry.version = version;
    } else if (packagePath.startsWith("packages/")) {
      const workspace = packages.find((candidate) => candidate.packagePath === `${packagePath}/package.json`);
      if (workspace && publicNames.has(workspace.manifest.name)) entry.version = version;
    } else if (packagePath.startsWith("node_modules/@harness-anything/")) {
      const packageName = packagePath.slice("node_modules/".length);
      if (publicNames.has(packageName)) entry.version = version;
    }
    alignInternalDependencies(entry);
  }
  lock.version = lock.lockfileVersion;
  writeJson(lockPath, lock);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`Updated root and ${updated} public workspace manifests (plus internal deps and lockfile) to ${version}.`);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
