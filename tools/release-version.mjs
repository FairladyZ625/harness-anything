#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.env.RELEASE_ROOT ?? new URL("..", import.meta.url).pathname);
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  console.error("Usage: node tools/release-version.mjs <semver> (for example 0.1.0-rc.1)");
  process.exit(2);
}

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workspacePaths = [
  "package.json",
  ...rootPackage.workspaces.flatMap((pattern) => {
    if (pattern !== "packages/*") return [];
    return [
      "packages/application/package.json",
      "packages/cli/package.json",
      "packages/daemon/package.json",
      "packages/gui/package.json",
      "packages/kernel/package.json",
      "packages/preset/package.json",
    ];
  }),
];
for (const relative of workspacePaths) {
  const file = join(root, relative);
  const source = readFileSync(file, "utf8");
  const pkg = JSON.parse(source);
  pkg.version = version;
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, value] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith("@harness-anything/")) pkg[section][name] = value === "*" ? value : version;
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
const lockPath = join(root, "package-lock.json");
try {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || path.startsWith("packages/") || path.startsWith("node_modules/@harness-anything/"))
      entry.version = version;
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, value] of Object.entries(entry[section] ?? {}))
        if (name.startsWith("@harness-anything/")) entry[section][name] = value === "*" ? value : version;
    }
  }
  lock.version = lock.lockfileVersion;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`Updated ${workspacePaths.length} package manifests and lockfile to ${version}.`);
