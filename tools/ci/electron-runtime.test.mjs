// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  electronArchivePath,
  electronArtifactName,
  electronCacheDirectory,
  electronDownloadUrl,
  ensureElectronArchive,
  resolveElectronVersion,
} from "./electron-runtime.mjs";

const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00]);

function temporaryRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), "electron-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function response(status, body = Buffer.alloc(0)) {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => body };
}

test("resolves the exact Electron version from the lockfile, not the manifest range", (t) => {
  const root = temporaryRoot(t);
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ packages: { "node_modules/electron": { version: "42.11.16" } } }),
  );
  assert.equal(resolveElectronVersion(root), "42.11.16");
});

test("builds the artifact name and URL Electron's installer itself requests", () => {
  assert.equal(
    electronArtifactName({ version: "42.11.16", platform: "linux", arch: "x64" }),
    "electron-v42.11.16-linux-x64.zip",
  );
  assert.equal(
    electronDownloadUrl({ version: "42.11.16", platform: "win32", arch: "x64" }),
    "https://github.com/electron/electron/releases/download/v42.11.16/electron-v42.11.16-win32-x64.zip",
  );
});

test("uses the @electron/get cache directory layout", () => {
  // The digest is sha256 of the download URL with its file name stripped. Pinned here so a
  // refactor cannot silently move the archive somewhere the installer never reads.
  const directory = electronCacheDirectory(
    "/cache/electron",
    "https://github.com/electron/electron/releases/download/v42.11.16/electron-v42.11.16-linux-x64.zip",
  );
  assert.equal(directory, "/cache/electron/8727adb5937759b4cb4b53decfacf4739c76695caebb1704f7dd1cafdb23b855");
});

test("a cached archive is a cache hit and performs no network request", async (t) => {
  const cacheRoot = temporaryRoot(t);
  const version = "42.11.16";
  const archivePath = electronArchivePath({ cacheRoot, version, platform: "linux", arch: "x64" });
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, zipBytes, { flag: "wx" });
  let calls = 0;
  const result = await ensureElectronArchive({
    cacheRoot,
    version,
    platform: "linux",
    arch: "x64",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("cache hit must not touch the network");
    },
    log: () => {},
  });
  assert.equal(result.cacheHit, true);
  assert.equal(calls, 0);
});

test("retries the idempotent download on a transient 504 and then caches it", async (t) => {
  const cacheRoot = temporaryRoot(t);
  const version = "42.11.16";
  const statuses = [504, 503, 200];
  const attempts = [];
  const result = await ensureElectronArchive({
    cacheRoot,
    version,
    platform: "linux",
    arch: "x64",
    fetchImpl: async () => {
      const status = statuses[attempts.length];
      attempts.push(status);
      return response(status, zipBytes);
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(attempts, [504, 503, 200]);
  assert.equal(result.cacheHit, false);
  assert.equal(result.attempts, 3);
  assert.deepEqual(readFileSync(result.archivePath), zipBytes);
});

test("does not retry a permanent 404", async (t) => {
  const cacheRoot = temporaryRoot(t);
  let calls = 0;
  await assert.rejects(
    ensureElectronArchive({
      cacheRoot,
      version: "42.11.16",
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => {
        calls += 1;
        return response(404);
      },
      sleep: async () => {},
      log: () => {},
    }),
    /HTTP 404/u,
  );
  assert.equal(calls, 1);
});

test("bounds retries at the configured attempt count", async (t) => {
  const cacheRoot = temporaryRoot(t);
  let calls = 0;
  await assert.rejects(
    ensureElectronArchive({
      cacheRoot,
      version: "42.11.16",
      platform: "linux",
      arch: "x64",
      attempts: 3,
      fetchImpl: async () => {
        calls += 1;
        return response(503);
      },
      sleep: async () => {},
      log: () => {},
    }),
    /HTTP 503/u,
  );
  assert.equal(calls, 3);
});

test("a non-archive cache entry is discarded and replaced by a fresh download", async (t) => {
  const cacheRoot = temporaryRoot(t);
  const version = "42.11.16";
  const archivePath = electronArchivePath({ cacheRoot, version, platform: "linux", arch: "x64" });
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, "proxy error page", { flag: "wx" });
  let calls = 0;
  const result = await ensureElectronArchive({
    cacheRoot,
    version,
    platform: "linux",
    arch: "x64",
    fetchImpl: async () => {
      calls += 1;
      return response(200, zipBytes);
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(readFileSync(archivePath), zipBytes);
});

test("a local cache write failure is not retried as a network download", async (t) => {
  const root = temporaryRoot(t);
  const cacheRoot = path.join(root, "cache-root-is-a-file");
  writeFileSync(cacheRoot, "not a directory");
  let calls = 0;
  let sleeps = 0;
  await assert.rejects(
    ensureElectronArchive({
      cacheRoot,
      version: "42.11.16",
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => {
        calls += 1;
        return response(200, zipBytes);
      },
      sleep: async () => {
        sleeps += 1;
      },
      log: () => {},
    }),
    /ENOTDIR/u,
  );
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});
