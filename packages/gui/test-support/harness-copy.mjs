import { execFileSync } from "node:child_process";
import {
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

export function copyHarnessLedgerWithCow(sourceRoot, destinationRoot) {
  const source = realpathSync(sourceRoot),
    requestedDestination = path.resolve(destinationRoot);
  if (!statSync(source).isDirectory()) throw new Error(`Harness ledger source is not a directory: ${source}`);
  if (process.platform !== "darwin") throw new Error("A branch daemon requires an APFS CoW clone on macOS.");

  mkdirSync(path.dirname(requestedDestination), { recursive: true });
  const destination = path.join(realpathSync(path.dirname(requestedDestination)), path.basename(requestedDestination)),
    relative = path.relative(source, destination);
  const destinationInsideSource =
    relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  if (destinationInsideSource) throw new Error("Harness ledger clone destination must be outside its source.");
  if (lstatSync(destination, { throwIfNoEntry: false }))
    throw new Error(`Harness ledger clone destination already exists: ${destination}`);

  try {
    // Match the repository's APFS copy-on-write path used by tools/old-data-copy-evidence.mjs.
    // `-c` forces clonefile and fails instead of silently falling back to a full byte copy.
    execFileSync("cp", ["-cR", source, destination], { stdio: "pipe" });
    const excludedExternalSymlinks = rebaseOrExcludeSymlinks(source, destination, source, destination);
    return { excludedExternalSymlinks };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Copy the live generation-three ledger as a coherent SQLite snapshot, then CoW-clone its
 *  immutable object tree. The authored harness clone alone has only the Git follower manifest;
 *  attach also requires this project-local generation store. */
export function copyHarnessRuntimeLedgerWithCow(sourceProjectRoot, destinationProjectRoot) {
  if (process.platform !== "darwin") throw new Error("A branch daemon requires an APFS CoW clone on macOS.");
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
  try {
    if (lstatSync(sourceCache, { throwIfNoEntry: false })) {
      mkdirSync(destinationCache, { recursive: true });
      for (const name of ["task.sqlite", "projections.sqlite"]) {
        const source = path.join(sourceCache, name),
          sources = [source, `${source}-wal`].filter((candidate) => lstatSync(candidate, { throwIfNoEntry: false }));
        if (sources.length === 0) continue;
        execFileSync("cp", ["-c", ...sources, destinationCache], { stdio: "ignore" });
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
    const sqlTarget = snapshot.replace(/'/gu, "''"),
      snapshotScript =
        'const { DatabaseSync } = require("node:sqlite"); ' +
        "const db = new DatabaseSync(process.argv[1], { readOnly: true }); " +
        `try { db.exec("VACUUM INTO '${sqlTarget}'"); } finally { db.close(); }`;
    execFileSync(process.execPath, ["-e", snapshotScript, sourceLedger], { stdio: "pipe" });
    execFileSync("cp", ["-cR", sourceGenerations, destinationGenerations], { stdio: "pipe" });
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
      statSync(clonedTarget);
      unlinkSync(destinationEntry);
      symlinkSync(path.relative(path.dirname(destinationEntry), clonedTarget), destinationEntry);
    } else if (entry.isDirectory()) {
      excluded += rebaseOrExcludeSymlinks(sourceRoot, destinationRoot, sourceEntry, destinationEntry);
    }
  }
  return excluded;
}

function isUnresolvableLink(error) {
  return typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ELOOP"].includes(error.code);
}
