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
const dependencyCacheFormat = "runtime-downloads-v4";

// This digest selects installation inputs; it is not a read-back integrity check.
export function dependencyInputs(root, runtime, configuration) {
  const lock = readFileSync(path.join(root, "package-lock.json"));
  const workspaces = Object.keys(JSON.parse(lock).packages).filter(
    (name) => name !== "" && !name.split("/").includes("node_modules"),
  );
  const hash = createHash("sha256")
    .update(JSON.stringify([dependencyCacheFormat, runtime, configuration]))
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
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    rebaseWorkspaceLinks(destination, sourceRoot, destinationRoot);
  } else {
    cpSync(source, destination);
  }
}

function rebaseWorkspaceLinks(root, sourceRoot, destinationRoot) {
  for (const name of readdirSync(root)) {
    const entry = path.join(root, name);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(entry);
      if (path.isAbsolute(link)) {
        const relative = path.relative(sourceRoot, link);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
          rmSync(entry);
          symlinkSync(
            path.join(destinationRoot, relative),
            entry,
            process.platform === "win32" ? "junction" : undefined,
          );
        }
      }
    } else if (stat.isDirectory()) rebaseWorkspaceLinks(entry, sourceRoot, destinationRoot);
  }
}

function npm(root, args) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function installRuntimeDownloads(root, runtimeRoot) {
  const electronInstaller = path.join(root, "node_modules/electron/install.js");
  if (existsSync(electronInstaller)) {
    execFileSync(process.execPath, [electronInstaller], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ELECTRON_CACHE: path.join(runtimeRoot, "electron") },
    });
  }
  const playwrightCli = path.join(root, "node_modules/playwright-core/cli.js");
  if (existsSync(playwrightCli)) {
    execFileSync(process.execPath, [playwrightCli, "install", "chromium"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeRoot, "playwright") },
    });
  }
}

function restoreWorkspaceLinks(root, workspaces) {
  for (const name of workspaces) {
    const manifest = JSON.parse(readFileSync(path.join(root, name, "package.json")));
    const destination = path.join(root, "node_modules", manifest.name);
    if (lstatSync(destination, { throwIfNoEntry: false })) rmSync(destination, { recursive: true, force: true });
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(path.join(root, name), destination, process.platform === "win32" ? "junction" : "dir");
  }
}

function rebuildWorkspaces(root, workspaces, install) {
  const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json")));
  if (rootManifest.scripts?.typecheck) install(root, ["run", "typecheck", "--ignore-scripts"]);
  for (const name of workspaces) {
    const manifest = JSON.parse(readFileSync(path.join(root, name, "package.json")));
    for (const hook of ["preinstall", "install", "postinstall", "prepare"])
      if (manifest.scripts?.[hook]) install(root, ["run", hook, "--workspace", name, "--ignore-scripts"]);
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"])
    if (rootManifest.scripts?.[hook]) install(root, ["run", hook, "--ignore-scripts"]);
}

function publishedGenerationKey(current) {
  const key = path.join(current, "key");
  return existsSync(key) ? readFileSync(key, "utf8") : undefined;
}

function copyGenerationEntry(current, root, name) {
  const destination = name === "runtime" ? ".test-runtime" : name;
  mkdirSync(path.dirname(path.join(root, destination)), { recursive: true });
  copyDependencyTree(path.join(current, name), path.join(root, destination), current, root);
}

function prepareWorkspaceBuild(root, cacheRoot, dependencyKey, workspaces, install, lock, dependencyHit) {
  // Git lists the snapshot inputs; hash their actual bytes, including unstaged edits.
  // This key replaces compilation, not installation or read-back validation.
  if (!existsSync(path.join(root, ".git"))) {
    if (dependencyHit) rebuildWorkspaces(root, workspaces, install);
    return;
  }
  const hash = createHash("sha256").update(dependencyKey);
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean).sort();
  for (const file of files) {
    hash.update(file);
    if (existsSync(path.join(root, file))) hash.update(readFileSync(path.join(root, file)));
    else hash.update("deleted");
  }
  const key = hash.digest("hex");
  const current = path.join(cacheRoot, "build");
  const staging = path.join(cacheRoot, "build-pending");
  // A hit can be copied while holding the lock. Misses rebuild per workspace
  // with no lock, so one workspace's build never blocks another preparation.
  lock.exec("BEGIN IMMEDIATE");
  const hit = publishedGenerationKey(current) === key;
  if (hit) {
    for (const name of JSON.parse(readFileSync(path.join(current, "roots.json"), "utf8")))
      copyDependencyTree(path.join(current, name), path.join(root, name), current, root);
    lock.exec("COMMIT");
    console.log(`[test-isolation-build] cache=hit key=${key}`);
    return;
  }
  lock.exec("COMMIT");
  rebuildWorkspaces(root, workspaces, install);

  lock.exec("BEGIN IMMEDIATE");
  try {
    rmSync(staging, { recursive: true, force: true });
    if (publishedGenerationKey(current) === key) {
      console.log(`[test-isolation-build] cache=hit key=${key}`);
      return;
    }
    const roots = ["dist", ...workspaces.map((name) => path.join(name, "dist"))].filter((name) =>
      existsSync(path.join(root, name)),
    );
    const bytes =
      treeBytes(path.join(cacheRoot, "current")) +
      roots.reduce((sum, name) => sum + treeBytes(path.join(root, name)), 0);
    if (bytes > cacheLimitBytes) throw new Error(`dependency cache exceeds ${cacheLimitBytes} bytes: ${bytes}`);
    rmSync(current, { recursive: true, force: true });
    mkdirSync(staging);
    for (const name of roots) copyDependencyTree(path.join(root, name), path.join(staging, name), root, current);
    writeFileSync(path.join(staging, "key"), key);
    writeFileSync(path.join(staging, "roots.json"), JSON.stringify(roots));
    renameSync(staging, current);
    console.log(`[test-isolation-build] cache=miss key=${key}`);
  } finally {
    lock.exec("COMMIT");
  }
}

export function prepareDependencies(
  root,
  cacheRoot = process.env.HARNESS_TEST_DEPENDENCY_CACHE || path.join(homedir(), ".cache", "harness-test-dependencies"),
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
  const pending = path.join(cacheRoot, "pending");
  let hit;
  try {
    // The writer lock covers only the shared generation: restore, seed,
    // publish and evict. Installation and workspace rebuilds are per
    // workspace and run without it — they take minutes on a fresh branch, and
    // holding the transaction through them starves concurrent preparations
    // into the `database is locked` busy timeout.
    lock.exec("BEGIN IMMEDIATE");
    hit = publishedGenerationKey(current) === key;
    if (hit) {
      const roots = JSON.parse(readFileSync(path.join(current, "roots.json"), "utf8"));
      for (const name of roots) copyGenerationEntry(current, root, name);
    } else if (existsSync(path.join(current, "runtime"))) {
      // Seed this run's downloads with the retained runtime so unchanged
      // browsers are not downloaded again.
      copyGenerationEntry(current, root, "runtime");
    }
    lock.exec("COMMIT");
    if (!hit) {
      install(root, ["ci", "--no-audit", "--no-fund"]);
      installRuntimeDownloads(root, path.join(root, ".test-runtime"));
    }
    lock.exec("BEGIN IMMEDIATE");
    // Process death releases the lock; the next owner discards unpublished staging.
    rmSync(pending, { recursive: true, force: true });
    if (publishedGenerationKey(current) === key) {
      // A concurrent owner published this generation while we installed; the
      // workspace already holds the same content.
      hit = true;
    } else {
      mkdirSync(pending, { recursive: true });
      // The workspace contains the cache seed plus any downloads completed by
      // this run. Copy that final tree once; copying both sources into the same
      // destination makes cpSync fail on overlapping runtime directories.
      mkdirSync(path.join(pending, "runtime"), { recursive: true });
      if (existsSync(path.join(root, ".test-runtime")))
        copyDependencyTree(path.join(root, ".test-runtime"), path.join(pending, "runtime"), root, current);
      else if (existsSync(path.join(current, "runtime")))
        copyDependencyTree(path.join(current, "runtime"), path.join(pending, "runtime"), current, pending);
      const npmRoots = ["", ...workspaces]
        .map((name) => path.join(name, "node_modules"))
        .filter((name) => existsSync(path.join(root, name)));
      const bytes =
        npmRoots.reduce((sum, name) => sum + treeBytes(path.join(root, name)), 0) +
        treeBytes(path.join(pending, "runtime"));
      if (bytes > cacheLimitBytes) throw new Error(`dependency cache exceeds ${cacheLimitBytes} bytes: ${bytes}`);
      // Keep one generation. Eviction precedes copying so the retained cache
      // never exceeds the limit; active runs already have independent copies.
      rmSync(current, { recursive: true, force: true });
      for (const name of npmRoots) {
        mkdirSync(path.dirname(path.join(pending, name)), { recursive: true });
        copyDependencyTree(path.join(root, name), path.join(pending, name), root, current);
      }
      writeFileSync(path.join(pending, "key"), key);
      writeFileSync(path.join(pending, "roots.json"), JSON.stringify([...npmRoots, "runtime"]));
      renameSync(pending, current);
    }
    lock.exec("COMMIT");
    restoreWorkspaceLinks(root, workspaces);
    prepareWorkspaceBuild(root, cacheRoot, key, workspaces, install, lock, hit);
  } finally {
    lock.close();
  }
  console.log(
    `[test-isolation-dependencies] cache=${hit ? "hit" : "miss"} key=${key} duration_ms=${Date.now() - started}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  prepareDependencies(process.cwd());
