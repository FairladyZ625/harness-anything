#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Read every npm workspace manifest from the root package.json globs. This is the
 * single source for publish-set questions: a workspace is public when its own
 * manifest does not set `private: true`.
 */
export function readWorkspacePackages(root = process.cwd()) {
  const rootManifest = readJson(path.join(root, "package.json"));
  const patterns = Array.isArray(rootManifest.workspaces) ? rootManifest.workspaces : rootManifest.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0)
    throw new Error("root package.json must declare npm workspaces");

  const packages = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const packageDirectory = path.posix.join(parent, entry.name);
        const packagePath = path.join(root, packageDirectory, "package.json");
        if (!existsSync(packagePath)) continue;
        packages.push(workspacePackage(packageDirectory, readJson(packagePath)));
      }
      continue;
    }
    const packagePath = path.join(root, pattern, "package.json");
    if (existsSync(packagePath)) packages.push(workspacePackage(toPosix(pattern), readJson(packagePath)));
  }

  const names = new Set();
  for (const entry of packages) {
    if (typeof entry.manifest.name !== "string" || entry.manifest.name.length === 0)
      throw new Error(`${entry.packagePath} must declare a package name`);
    if (names.has(entry.manifest.name)) throw new Error(`duplicate workspace package ${entry.manifest.name}`);
    names.add(entry.manifest.name);
  }
  return packages;
}

export function publicWorkspacePackages(root = process.cwd()) {
  return readWorkspacePackages(root).filter((entry) => entry.manifest.private !== true);
}

/**
 * A public package must not declare a runtime dependency on a private workspace:
 * installing it from the registry would 404. Fail with the exact edge instead of
 * publishing a broken closure.
 */
export function assertPublicDependencyClosure(root = process.cwd()) {
  const packages = readWorkspacePackages(root);
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  for (const entry of packages) {
    if (entry.manifest.private === true) continue;
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependencyName of Object.keys(entry.manifest[section] ?? {}).sort()) {
        const dependency = byName.get(dependencyName);
        if (!dependency || dependency.manifest.private !== true) continue;
        throw new Error(
          `public workspace ${entry.manifest.name} declares ${section}.${dependencyName} but ${dependencyName} is private; ` +
            "publish the dependency or remove the dependency edge",
        );
      }
    }
  }
}

/**
 * Public workspace names in dependency order (dependencies before dependents).
 * Sorted roots keep the output deterministic; a cycle is reported with its path.
 */
export function publicWorkspaceNamesTopologically(root = process.cwd()) {
  assertPublicDependencyClosure(root);
  const packages = publicWorkspacePackages(root);
  const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();

  const visit = (name, trail) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`workspace dependency cycle: ${[...trail, name].join(" -> ")}`);
    visiting.add(name);
    const manifest = byName.get(name).manifest;
    const dependencyNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const dependencyName of [...dependencyNames].filter((candidate) => byName.has(candidate)).sort())
      visit(dependencyName, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  };

  for (const name of [...byName.keys()].sort()) visit(name, []);
  return ordered;
}

function workspacePackage(directory, manifest) {
  return { directory, packagePath: `${directory}/package.json`, manifest };
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  for (const name of publicWorkspaceNamesTopologically()) console.log(name);
}
