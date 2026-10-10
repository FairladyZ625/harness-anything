#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const cacheLimitBytes = 2 * 1024 ** 3;

// This digest selects installation inputs; it is not a read-back integrity check.
export function dependencyInputs(root, runtime, configuration) {
  const lock = readFileSync(path.join(root, "package-lock.json"));
  const workspaces = Object.keys(JSON.parse(lock).packages).filter(
    (name) => name !== "" && !name.split("/").includes("node_modules"),
  );
  const hash = createHash("sha256")
    .update(JSON.stringify([runtime, configuration]))
    .update(lock);
  for (const name of ["", ...workspaces].sort()) {
    hash.update(name).update(readFileSync(path.join(root, name, "package.json")));
  }
  return { key: hash.digest("hex"), workspaces };
}

export function treeBytes(root) {
  const stat = lstatSync(root);
  return stat.isDirectory()
    ? readdirSync(root).reduce((sum, name) => sum + treeBytes(path.join(root, name)), 0)
    : stat.size;
}

// Independent file copies, never hard links. Rebase Windows workspace junctions
// as well as absolute links so every restored workspace owns its dependencies.
export function copyDependencyTree(source, destination, sourceRoot, destinationRoot) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(source);
    const relative = path.relative(sourceRoot, link);
    const target =
      path.isAbsolute(link) && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? path.join(destinationRoot, relative)
        : link;
    symlinkSync(target, destination, process.platform === "win32" ? "junction" : undefined);
  } else if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source))
      copyDependencyTree(path.join(source, name), path.join(destination, name), sourceRoot, destinationRoot);
  } else {
    cpSync(source, destination);
  }
}

function npm(root, args) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

export function prepareDependencies(
  root,
  cacheRoot = path.join(homedir(), ".cache", "harness-test-dependencies"),
  install = npm,
) {
  const started = Date.now();
  const runtime = [
    process.platform,
    process.arch,
    process.version,
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    }).trim(),
  ];
  const configuration = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["config", "list", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  // npm includes cwd/prefix in its effective config; they are run identity,
  // not dependency inputs. Registry, omit, script policy etc. remain in the key.
  const config = JSON.parse(configuration);
  delete config.prefix;
  const { key, workspaces } = dependencyInputs(root, runtime, config);
  mkdirSync(cacheRoot, { recursive: true });
  const lock = new DatabaseSync(path.join(cacheRoot, "owner.sqlite"), { timeout: 300000 });
  const current = path.join(cacheRoot, "current");
  let hit;
  try {
    // A native cross-platform writer lock owns create, restore and eviction.
    // Process death releases it; the next owner discards unpublished staging.
    lock.exec("BEGIN IMMEDIATE");
    const staging = path.join(cacheRoot, "pending");
    rmSync(staging, { recursive: true, force: true });
    hit = existsSync(current) && readFileSync(path.join(current, "key"), "utf8") === key;
    if (hit) {
      const roots = JSON.parse(readFileSync(path.join(current, "roots.json"), "utf8"));
      for (const name of roots) {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        copyDependencyTree(path.join(current, name), path.join(root, name), current, root);
      }
    } else {
      install(root, ["ci", "--no-audit", "--no-fund"]);
      const roots = ["", ...workspaces]
        .map((name) => path.join(name, "node_modules"))
        .filter((name) => existsSync(path.join(root, name)));
      const bytes = roots.reduce((sum, name) => sum + treeBytes(path.join(root, name)), 0);
      if (bytes > cacheLimitBytes) throw new Error(`dependency cache exceeds ${cacheLimitBytes} bytes: ${bytes}`);
      // Keep one generation. Eviction precedes copying so the retained cache
      // never exceeds the limit; active runs already have independent copies.
      rmSync(current, { recursive: true, force: true });
      mkdirSync(staging);
      for (const name of roots) {
        mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
        copyDependencyTree(path.join(root, name), path.join(staging, name), root, current);
      }
      writeFileSync(path.join(staging, "key"), key);
      writeFileSync(path.join(staging, "roots.json"), JSON.stringify(roots));
      renameSync(staging, current);
    }
    lock.exec("COMMIT");
  } finally {
    lock.close();
  }
  // Generated workspace outputs are never cached. Rebuild local packages
  // against this snapshot, without rebuilding installed third-party packages.
  if (hit) {
    for (const name of workspaces) {
      const manifest = JSON.parse(readFileSync(path.join(root, name, "package.json")));
      for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
        if (manifest.scripts?.[hook]) install(root, ["run", hook, "--workspace", name, "--ignore-scripts"]);
      }
    }
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json")));
    for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]) {
      if (manifest.scripts?.[hook]) install(root, ["run", hook, "--ignore-scripts"]);
    }
  }
  console.log(
    `[test-isolation-dependencies] cache=${hit ? "hit" : "miss"} key=${key} duration_ms=${Date.now() - started}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  prepareDependencies(process.cwd());
