// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearRefsVolumeProbeCache,
  cloneFileWithHardlinkPreferenceSync,
  cloneImmutableTree,
  cloneTreeSync,
  createSyncCloneSessionState,
  createWindowsRefsMutableCloner,
  isImmutableCasObjectPath,
  isMutableFilePath,
  probeRefsVolume,
  tryCloneMutableFile,
} from "../src/immutable-tree-clone.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function writeCasObject(objectsRoot: string, body: string): { readonly sha: string; readonly filePath: string } {
  const sha = sha256Hex(body);
  const bucket = path.join(objectsRoot, sha.slice(0, 2));
  mkdirSync(bucket, { recursive: true });
  const filePath = path.join(bucket, sha.slice(2));
  writeFileSync(filePath, body, "utf8");
  return { sha, filePath };
}

test("isImmutableCasObjectPath enforces strict SHA-256 CAS layout and rejects mutable paths", () => {
  const validSha = sha256Hex("immutable-cas-payload");
  const prefix = validSha.slice(0, 2);
  const rest = validSha.slice(2);

  assert.equal(isImmutableCasObjectPath(`objects/sha256/${prefix}/${rest}`), true);
  assert.equal(isImmutableCasObjectPath(`3/objects/sha256/${prefix}/${rest}`), true);
  assert.equal(isImmutableCasObjectPath(`store\\generations\\3\\objects\\sha256\\${prefix}\\${rest}`), true);
  assert.equal(isMutableFilePath(`objects/sha256/${prefix}/${rest}`), false);

  const rejected = [
    "",
    "ledger.sqlite",
    "store/generations/3/ledger.sqlite",
    "store/generations/3/ledger.sqlite-wal",
    "store/generations/3/ledger.sqlite-shm",
    "store/generations/3/ledger.sqlite.activation.json",
    "cache/task.sqlite",
    "cache/projections.sqlite-wal",
    `objects/sha256/${prefix}/blob`,
    `objects/sha256/${prefix}/${rest.toUpperCase()}`,
    `objects/sha256/${prefix}/${rest}.sqlite`,
    `objects/sha256/${prefix}/${rest}.json`,
    `objects/sha256/${prefix}/${rest}.lock`,
    `objects/sha256/../${prefix}/${rest}`,
    `objects/sha256/${prefix}/${rest.slice(0, 61)}`,
  ];
  for (const candidate of rejected) {
    assert.equal(isImmutableCasObjectPath(candidate), false, `must reject ${candidate}`);
    assert.equal(isMutableFilePath(candidate), true, `must classify as mutable: ${candidate}`);
  }
});

test("cloneImmutableTree hard-links immutable CAS objects on same volume and survives either side deletion", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-immutable-clone-cas-"));
  t.after(() => removeTempRepository(parent));

  const srcObjects = path.join(parent, "src", "store", "generations", "3", "objects", "sha256");
  const dstObjects = path.join(parent, "dst", "store", "generations", "3", "objects", "sha256");
  const objA = writeCasObject(srcObjects, "immutable blob alpha\n");
  const objB = writeCasObject(srcObjects, "immutable blob beta\n");
  const objC = writeCasObject(srcObjects, "immutable blob gamma\n");

  const stats = await cloneImmutableTree(srcObjects, dstObjects);
  assert.equal(stats.hardlinkedFiles, 3);
  assert.equal(stats.copiedFiles, 0);
  assert.equal(stats.clonedFiles, 0);
  assert.equal(stats.fallbackReason, null);

  for (const obj of [objA, objB, objC]) {
    const dstPath = path.join(dstObjects, obj.sha.slice(0, 2), obj.sha.slice(2));
    const srcStat = statSync(obj.filePath);
    const dstStat = statSync(dstPath);
    assert.equal(dstStat.ino, srcStat.ino, "CAS object must share inode / file ID");
    assert.ok(dstStat.nlink >= 2, `expected nlink >= 2, got ${dstStat.nlink}`);
    assert.equal(readFileSync(dstPath, "utf8"), readFileSync(obj.filePath, "utf8"));
  }

  // Deleting source file leaves destination intact; deleting destination leaves source intact.
  const dstA = path.join(dstObjects, objA.sha.slice(0, 2), objA.sha.slice(2));
  const dstB = path.join(dstObjects, objB.sha.slice(0, 2), objB.sha.slice(2));
  rmSync(objA.filePath);
  assert.equal(readFileSync(dstA, "utf8"), "immutable blob alpha\n");
  rmSync(dstB);
  assert.equal(readFileSync(objB.filePath, "utf8"), "immutable blob beta\n");
});

test("negative control: mutable SQLite/WAL/SHM/JSON and stray files inside mixed tree NEVER share inode", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-immutable-clone-mixed-"));
  t.after(() => removeTempRepository(parent));

  const srcRoot = path.join(parent, "src");
  const dstRoot = path.join(parent, "dst");
  const srcGen3 = path.join(srcRoot, "3");
  const srcObjects = path.join(srcGen3, "objects", "sha256");
  const casObj = writeCasObject(srcObjects, "immutable cas object bytes\n");

  const mutableEntries: readonly { readonly rel: string; readonly content: string }[] = [
    { rel: "3/ledger.sqlite", content: "sqlite-ledger-original" },
    { rel: "3/ledger.sqlite-wal", content: "sqlite-wal-original" },
    { rel: "3/ledger.sqlite-shm", content: "sqlite-shm-original" },
    { rel: "3/ledger.sqlite.activation.json", content: '{"repoId":"canonical"}\n' },
    { rel: "cache/task.sqlite", content: "task-projection-original" },
    { rel: "cache/task.sqlite-wal", content: "task-wal-original" },
    { rel: "3/objects/sha256/00/stray.sqlite", content: "stray-sqlite-inside-cas" },
    { rel: "3/objects/sha256/00/not-a-sha", content: "non-hex-file" },
  ];

  const sourceDigests = new Map<string, string>();
  for (const entry of mutableEntries) {
    const srcPath = path.join(srcRoot, ...entry.rel.split("/"));
    mkdirSync(path.dirname(srcPath), { recursive: true });
    writeFileSync(srcPath, entry.content, "utf8");
    sourceDigests.set(entry.rel, sha256Hex(entry.content));
  }

  const stats = await cloneImmutableTree(srcRoot, dstRoot);
  assert.equal(stats.hardlinkedFiles, 1, "only the valid 64-hex CAS object is hard-linked");
  assert.equal(stats.clonedFiles + stats.copiedFiles, mutableEntries.length);

  // Positive control: CAS object shares inode.
  const dstCas = path.join(dstRoot, "3", "objects", "sha256", casObj.sha.slice(0, 2), casObj.sha.slice(2));
  assert.equal(statSync(dstCas).ino, statSync(casObj.filePath).ino);
  assert.ok(statSync(dstCas).nlink >= 2);

  // Negative control: every mutable file has a distinct inode, nlink === 1, and writing copy never mutates source.
  for (const entry of mutableEntries) {
    const srcPath = path.join(srcRoot, ...entry.rel.split("/"));
    const dstPath = path.join(dstRoot, ...entry.rel.split("/"));
    const srcStat = statSync(srcPath);
    const dstStat = statSync(dstPath);
    assert.notEqual(dstStat.ino, srcStat.ino, `mutable file ${entry.rel} must NOT share inode`);
    assert.equal(dstStat.nlink, 1, `mutable file ${entry.rel} must have nlink === 1`);
    writeFileSync(dstPath, `mutated-${entry.rel}`, "utf8");
    assert.equal(
      sha256Hex(readFileSync(srcPath)),
      sourceDigests.get(entry.rel),
      `mutating copied ${entry.rel} must never modify source`,
    );
  }
});

test("simulated EXDEV short-circuits volume hard-linking and falls back cleanly to copy (async & sync)", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-immutable-clone-exdev-"));
  t.after(() => removeTempRepository(parent));

  const srcObjects = path.join(parent, "src", "objects", "sha256");
  const objects = Array.from({ length: 12 }, (_, idx) => writeCasObject(srcObjects, `payload-${idx}\n`));

  // Async EXDEV short-circuit test (concurrency=1 proves exact 1 link attempt across 12 files).
  let asyncLinkAttempts = 0;
  const dstAsync = path.join(parent, "dst-async", "objects", "sha256");
  const asyncStats = await cloneImmutableTree(srcObjects, dstAsync, {
    concurrency: 1,
    fs: {
      link: async () => {
        asyncLinkAttempts += 1;
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      },
    },
  });
  assert.equal(asyncLinkAttempts, 1, "EXDEV must short-circuit hardlink attempts for the rest of the volume");
  assert.equal(asyncStats.hardlinkedFiles, 0);
  assert.equal(asyncStats.clonedFiles + asyncStats.copiedFiles, objects.length);
  assert.equal(asyncStats.fallbackReason, "EXDEV");
  for (const obj of objects) {
    const dstPath = path.join(dstAsync, obj.sha.slice(0, 2), obj.sha.slice(2));
    assert.equal(readFileSync(dstPath, "utf8"), readFileSync(obj.filePath, "utf8"));
    assert.notEqual(statSync(dstPath).ino, statSync(obj.filePath).ino);
  }

  // Async EMLINK per-file fallback (does not short-circuit other files; falls back cleanly).
  let emlinkCalls = 0;
  const dstEmlink = path.join(parent, "dst-emlink", "objects", "sha256");
  const emlinkStats = await cloneImmutableTree(srcObjects, dstEmlink, {
    concurrency: 1,
    fs: {
      link: async () => {
        emlinkCalls += 1;
        throw Object.assign(new Error("EMLINK: too many links"), { code: "EMLINK" });
      },
    },
  });
  assert.equal(emlinkCalls, objects.length, "EMLINK is per-inode and falls back per file");
  assert.equal(emlinkStats.fallbackReason, "EMLINK");
  assert.equal(emlinkStats.clonedFiles + emlinkStats.copiedFiles, objects.length);

  // Sync EXDEV short-circuit test.
  let syncLinkAttempts = 0;
  const dstSync = path.join(parent, "dst-sync", "objects", "sha256");
  const syncStats = cloneTreeSync(srcObjects, dstSync, {
    fs: {
      linkSync: () => {
        syncLinkAttempts += 1;
        throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      },
    },
  });
  assert.equal(syncLinkAttempts, 1, "sync EXDEV must short-circuit on the first failure");
  assert.equal(syncStats.hardlinkedFiles, 0);
  assert.equal(syncStats.fallbackReason, "EXDEV");
  assert.equal(syncStats.clonedFiles + syncStats.copiedFiles, objects.length);
});

test("EEXIST unlinks before replacing (never mutates prior hardlink) and supports skip-if-same-size", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-immutable-clone-eexist-"));
  t.after(() => removeTempRepository(parent));

  const srcObjects = path.join(parent, "src", "objects", "sha256");
  const dstObjects = path.join(parent, "dst", "objects", "sha256");
  const obj = writeCasObject(srcObjects, "canonical content v1\n");
  const dstPath = path.join(dstObjects, obj.sha.slice(0, 2), obj.sha.slice(2));
  mkdirSync(path.dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, "stale preexisting bytes", "utf8");
  const staleIno = statSync(dstPath).ino;

  // unlink-and-replace replaces stale target with hard link to source.
  const replaceStats = await cloneImmutableTree(srcObjects, dstObjects, { onExisting: "unlink-and-replace" });
  assert.equal(replaceStats.hardlinkedFiles, 1);
  assert.equal(statSync(dstPath).ino, statSync(obj.filePath).ino);
  assert.notEqual(statSync(dstPath).ino, staleIno);
  assert.equal(readFileSync(dstPath, "utf8"), "canonical content v1\n");

  // skip-if-same-size skips already-present matching file cleanly.
  const skipStats = await cloneImmutableTree(srcObjects, dstObjects, { onExisting: "skip-if-same-size" });
  assert.equal(skipStats.skippedExistingFiles, 1);
  assert.equal(skipStats.hardlinkedFiles, 0);

  // Sync mutable replacement unlinks before copying, never mutating a preexisting hardlink.
  const mutableSrc = path.join(parent, "mutable-src.sqlite");
  const mutableDst = path.join(parent, "mutable-dst.sqlite");
  const witness = path.join(parent, "witness.sqlite");
  writeFileSync(mutableSrc, "new-sqlite-content", "utf8");
  writeFileSync(witness, "original-witness", "utf8");
  cloneFileWithHardlinkPreferenceSync(
    witness,
    mutableDst,
    "objects/sha256/" + obj.sha.slice(0, 2) + "/" + obj.sha.slice(2),
  );
  assert.equal(statSync(mutableDst).ino, statSync(witness).ino);
  const res = cloneFileWithHardlinkPreferenceSync(mutableSrc, mutableDst, "3/ledger.sqlite", {
    session: createSyncCloneSessionState(),
  });
  assert.notEqual(res.method, "hardlink");
  assert.equal(readFileSync(mutableDst, "utf8"), "new-sqlite-content");
  assert.equal(readFileSync(witness, "utf8"), "original-witness", "unlinked before copy so prior link is untouched");
});

test("optional Windows ReFS probe and mutable cloner fall back cleanly when unavailable or failing", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-immutable-clone-refs-"));
  t.after(() => {
    clearRefsVolumeProbeCache();
    removeTempRepository(parent);
  });

  // Non-win32 platforms immediately report unsupported without spawning subprocesses.
  const linuxProbe = await probeRefsVolume(parent, { platform: "linux" });
  assert.equal(linuxProbe.supported, false);
  assert.equal(linuxProbe.reason, "non-win32");

  // Simulated Windows ReFS volume detection.
  const refsProbe = await probeRefsVolume("H:\\ha-temp", {
    platform: "win32",
    execFsutil: async () => "Volume Name : DevDrive\r\nFile System Name : ReFS\r\n",
  });
  assert.equal(refsProbe.supported, true);
  assert.equal(refsProbe.fileSystem, "ReFS");

  // Simulated localized Chinese NTFS volume reports unsupported cleanly.
  const ntfsProbe = await probeRefsVolume("D:\\harness-edge", {
    platform: "win32",
    execFsutil: async () => "卷名 : 软件\r\n文件系统名 : NTFS\r\n",
  });
  assert.equal(ntfsProbe.supported, false);
  assert.equal(ntfsProbe.fileSystem, "NTFS");

  // Simulated fsutil access-denied error degrades cleanly without throwing.
  const failedProbe = await probeRefsVolume("D:\\harness-edge", {
    platform: "win32",
    execFsutil: async () => {
      throw Object.assign(new Error("Error 5: Access is denied."), { code: "EACCES" });
    },
  });
  assert.equal(failedProbe.supported, false);
  assert.equal(failedProbe.reason, "probe-failed:EACCES");

  const srcFile = path.join(parent, "task.sqlite");
  const dstOk = path.join(parent, "task-refs-ok.sqlite");
  const dstFallback = path.join(parent, "task-refs-fallback.sqlite");
  writeFileSync(srcFile, "mutable-sqlite-payload-bytes", "utf8");

  // Injected ReFS cloner succeeds on simulated same-volume ReFS.
  const workingRefsCloner = createWindowsRefsMutableCloner({
    platform: "win32",
    probe: async () => ({ supported: true, fileSystem: "ReFS", volumeRoot: "C:\\", reason: "refs-volume-detected" }),
    duplicateExtents: async (src, dst) => {
      writeFileSync(dst, readFileSync(src));
      return true;
    },
  });
  const okRes = await tryCloneMutableFile(srcFile, dstOk, { mutableFileCloner: workingRefsCloner });
  assert.equal(okRes.method, "refs-cow");
  assert.equal(readFileSync(dstOk, "utf8"), "mutable-sqlite-payload-bytes");

  // Injected ReFS cloner throwing FSCTL error falls back cleanly to standard copy with identical bytes.
  const failingRefsCloner = createWindowsRefsMutableCloner({
    platform: "win32",
    probe: async () => ({ supported: true, fileSystem: "ReFS", volumeRoot: "C:\\", reason: "refs-volume-detected" }),
    duplicateExtents: async () => {
      throw Object.assign(new Error("FSCTL_DUPLICATE_EXTENTS_TO_FILE unsupported"), { code: "ENOTSUP" });
    },
  });
  const fallbackRes = await tryCloneMutableFile(srcFile, dstFallback, { mutableFileCloner: failingRefsCloner });
  assert.ok(fallbackRes.method === "ficlone" || fallbackRes.method === "copy");
  assert.equal(fallbackRes.fallbackReason, "ENOTSUP");
  assert.equal(readFileSync(dstFallback, "utf8"), "mutable-sqlite-payload-bytes");
  assert.notEqual(statSync(dstFallback).ino, statSync(srcFile).ino);
});
