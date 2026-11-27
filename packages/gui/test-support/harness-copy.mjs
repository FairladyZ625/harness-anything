import { execFileSync } from "node:child_process";
import {
  constants,
  cpSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
import {
  cloneTreeSync,
  copyFileWithFicloneFallbackSync,
  createSyncCloneSessionState,
} from "../../storage/src/immutable-tree-clone.ts";

function copyTreeMutableCrossPlatform(source, destination) {
  if (process.platform === "darwin") {
    try {
      // Prefer APFS copy-on-write on macOS; fall back gracefully on non-APFS volumes.
      execFileSync("cp", ["-cR", source, destination], { stdio: "pipe" });
      return;
    } catch {
      rmSync(destination, { recursive: true, force: true });
    }
  } else if (process.platform === "linux") {
    try {
      execFileSync("cp", ["-a", "--reflink=auto", source, destination], { stdio: "pipe" });
      return;
    } catch {
      rmSync(destination, { recursive: true, force: true });
    }
  }
  try {
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  } catch {
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
  }
}

function copyMutableFileCrossPlatform(source, destination, session) {
  if (process.platform === "darwin") {
    try {
      execFileSync("cp", ["-c", source, destination], { stdio: "ignore" });
      return;
    } catch {
      rmSync(destination, { force: true });
    }
  }
  copyFileWithFicloneFallbackSync(source, destination, { session });
}

export function copyHarnessLedgerWithCow(sourceRoot, destinationRoot) {
  const source = realpathSync(sourceRoot),
    requestedDestination = path.resolve(destinationRoot);
  if (!statSync(source).isDirectory()) throw new Error(`Harness ledger source is not a directory: ${source}`);

  mkdirSync(path.dirname(requestedDestination), { recursive: true });
  const destination = path.join(realpathSync(path.dirname(requestedDestination)), path.basename(requestedDestination)),
    relative = path.relative(source, destination);
  const destinationInsideSource =
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (destinationInsideSource) throw new Error("Harness ledger clone destination must be outside its source.");
  if (lstatSync(destination, { throwIfNoEntry: false }))
    throw new Error(`Harness ledger clone destination already exists: ${destination}`);

  try {
    copyTreeMutableCrossPlatform(source, destination);
    const excludedExternalSymlinks = rebaseOrExcludeSymlinks(source, destination, source, destination);
    return { excludedExternalSymlinks };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Copy the live generation-three ledger as a coherent SQLite snapshot, then hardlink-clone its
 *  immutable CAS object tree (`objects/sha256/<2>/<62>`) and independently copy mutable files.
 *  Works natively on macOS, Linux, and Windows. */
export function copyHarnessRuntimeLedgerWithCow(sourceProjectRoot, destinationProjectRoot) {
  const sourceLayout = resolveHarnessLayout(sourceProjectRoot),
    destinationLayout = resolveHarnessLayout(destinationProjectRoot),
    sourceGenerations = path.join(sourceLayout.localRoot, "store", "generations"),
    destinationGenerations = path.join(destinationLayout.localRoot, "store", "generations"),
    sourceCache = path.join(sourceLayout.localRoot, "cache"),
    destinationCache = path.join(destinationLayout.localRoot, "cache"),
    sourceLedger = path.join(sourceGenerations, "3", "ledger.sqlite"),
    snapshot = path.join(destinationLayout.rootDir, ".gui-capture-ledger.sqlite");
  if (!lstatSync(sourceLedger, { throwIfNoEntry: false }))
    throw new Error(`Canonical generation-three ledger is missing: ${sourceLedger}`);
  if (lstatSync(destinationGenerations, { throwIfNoEntry: false }))
    throw new Error(`Branch ledger destination already exists: ${destinationGenerations}`);

  mkdirSync(path.dirname(destinationGenerations), { recursive: true });
  const cloneSession = createSyncCloneSessionState();
  try {
    if (lstatSync(sourceCache, { throwIfNoEntry: false })) {
      mkdirSync(destinationCache, { recursive: true });
      for (const name of ["task.sqlite", "projections.sqlite"]) {
        const source = path.join(sourceCache, name),
          sources = [source, `${source}-wal`].filter((candidate) => lstatSync(candidate, { throwIfNoEntry: false }));
        if (sources.length === 0) continue;
        for (const file of sources) {
          copyMutableFileCrossPlatform(file, path.join(destinationCache, path.basename(file)), cloneSession);
        }
        const cached = path.join(destinationCache, name),
          checkpointScript =
            'const { DatabaseSync } = require("node:sqlite"); ' +
            "const db = new DatabaseSync(process.argv[1]); " +
            'try { db.exec("PRAGMA busy_timeout = 10000; PRAGMA wal_checkpoint(TRUNCATE)"); ' +
            'const check = db.prepare("PRAGMA quick_check").get(); ' +
            'if (String(check?.quick_check ?? "") !== "ok") process.exitCode = 1; } finally { db.close(); }';
        try {
          execFileSync(process.execPath, ["-e", checkpointScript, cached], { stdio: "pipe" });
        } catch {
          rmSync(cached, { force: true });
          rmSync(`${cached}-wal`, { force: true });
          rmSync(`${cached}-shm`, { force: true });
        }
      }
    }
    const snapshotScript =
      'const { DatabaseSync } = require("node:sqlite"); ' +
      "const db = new DatabaseSync(process.argv[1], { readOnly: true }); " +
      "const sqlTarget = process.argv[2].replace(/'/gu, \"''\"); " +
      "try { db.exec(`VACUUM INTO '${sqlTarget}'`); } finally { db.close(); }";
    execFileSync(process.execPath, ["-e", snapshotScript, sourceLedger, snapshot], { stdio: "pipe" });
    cloneTreeSync(sourceGenerations, destinationGenerations, {
      session: cloneSession,
      exclude: (_src, rel) =>
        rel === "3/ledger.sqlite" || rel === "3/ledger.sqlite-wal" || rel === "3/ledger.sqlite-shm",
    });
    const excludedExternalSymlinks = rebaseOrExcludeSymlinks(
      sourceGenerations,
      destinationGenerations,
      sourceGenerations,
      destinationGenerations,
    );
    const destinationLedger = path.join(destinationGenerations, "3", "ledger.sqlite");
    rmSync(destinationLedger, { force: true });
    rmSync(`${destinationLedger}-wal`, { force: true });
    rmSync(`${destinationLedger}-shm`, { force: true });
    mkdirSync(path.dirname(destinationLedger), { recursive: true });
    renameSync(snapshot, destinationLedger);
    return { generation: 3, excludedExternalSymlinks };
  } catch (error) {
    rmSync(snapshot, { force: true });
    rmSync(destinationCache, { recursive: true, force: true });
    rmSync(destinationGenerations, { recursive: true, force: true });
    throw error;
  }
}

function rebaseOrExcludeSymlinks(sourceRoot, destinationRoot, sourceDirectory, destinationDirectory) {
  let excluded = 0;
  for (const name of readdirSync(sourceDirectory)) {
    const sourceEntry = path.join(sourceDirectory, name),
      destinationEntry = path.join(destinationDirectory, name),
      entry = lstatSync(sourceEntry);
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(sourceEntry);
      } catch (error) {
        if (isUnresolvableLink(error)) {
          unlinkSync(destinationEntry);
          excluded += 1;
          continue;
        }
        throw error;
      }
      const targetRelative = path.relative(sourceRoot, target),
        escapesSource =
          targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative);
      if (escapesSource) {
        unlinkSync(destinationEntry);
        excluded += 1;
        continue;
      }
      const clonedTarget = path.join(destinationRoot, targetRelative);
      // A cloned internal link must resolve inside this throwaway tree, never back to canonical.
      const clonedStat = statSync(clonedTarget);
      unlinkSync(destinationEntry);
      const linkTarget = path.relative(path.dirname(destinationEntry), clonedTarget);
      if (process.platform === "win32" && clonedStat.isDirectory()) {
        try {
          symlinkSync(linkTarget, destinationEntry, "dir");
        } catch {
          symlinkSync(clonedTarget, destinationEntry, "junction");
        }
      } else {
        symlinkSync(linkTarget, destinationEntry);
      }
    } else if (entry.isDirectory() && lstatSync(destinationEntry, { throwIfNoEntry: false })?.isDirectory()) {
      excluded += rebaseOrExcludeSymlinks(sourceRoot, destinationRoot, sourceEntry, destinationEntry);
    }
  }
  return excluded;
}

function isUnresolvableLink(error) {
  return typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ELOOP"].includes(error.code);
}
