#!/usr/bin/env node
/**
 * Prime the Electron download cache before any job runs `npm ci`.
 *
 * Electron's own postinstall (`node_modules/electron/install.js`) downloads
 * `electron-v<version>-<platform>-<arch>.zip` from github.com/electron/electron/releases
 * and caches it under the @electron/get cache root. A releases 504 therefore fails every
 * job that happens to install dependencies in that window, even when the job has nothing
 * to do with the GUI. This command puts the archive in that same cache first, with a
 * bounded retry on the one idempotent operation that can flake; `npm ci` then finds a
 * cache hit and never touches the releases endpoint.
 *
 * The cache path is @electron/get's layout verbatim: sha256 of the download URL with the
 * file name stripped, under the configured cache root. `electron_config_cache` is the
 * environment variable Electron 42's installer reads (`install.js` passes it as
 * `cacheRoot`), so the workflow points it at `~/.cache/electron` on every platform.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ELECTRON_RELEASE_BASE = "https://github.com/electron/electron/releases/download";
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 120_000;
const CACHE_HIT_ATTEMPTS = 0;

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export function resolveElectronVersion(root = repoRoot) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const version = lock.packages?.["node_modules/electron"]?.version;
  if (typeof version !== "string" || version.length === 0)
    throw new Error("package-lock.json does not pin node_modules/electron to a version");
  return version;
}

export function electronArtifactName({ version, platform = process.platform, arch = process.arch }) {
  return `electron-v${version}-${platform}-${arch}.zip`;
}

export function electronDownloadUrl({ version, platform = process.platform, arch = process.arch }) {
  return `${ELECTRON_RELEASE_BASE}/v${version}/${electronArtifactName({ version, platform, arch })}`;
}

export function electronCacheDirectory(cacheRoot, downloadUrl) {
  const parsed = new URL(downloadUrl);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = path.posix.dirname(parsed.pathname);
  return path.join(cacheRoot, createHash("sha256").update(parsed.toString()).digest("hex"));
}

export function defaultCacheRoot(env = process.env) {
  const configured = env.electron_config_cache?.trim();
  return configured && configured.length > 0 ? configured : path.join(homedir(), ".cache", "electron");
}

export function electronArchivePath({
  cacheRoot = defaultCacheRoot(),
  version,
  platform = process.platform,
  arch = process.arch,
}) {
  const downloadUrl = electronDownloadUrl({ version, platform, arch });
  return path.join(electronCacheDirectory(cacheRoot, downloadUrl), electronArtifactName({ version, platform, arch }));
}

function hasZipMagic(file) {
  let descriptor;
  try {
    descriptor = openSync(file, "r");
    const header = Buffer.alloc(4);
    const read = readSync(descriptor, header, 0, header.length, 0);
    return (
      read === 4 &&
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      ((header[2] === 0x03 && header[3] === 0x04) || (header[2] === 0x05 && header[3] === 0x06))
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function isCachedArchive(file) {
  return existsSync(file) && statSync(file).isFile() && hasZipMagic(file);
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

function retryableTransportError(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  if (typeof error?.status === "number") return retryableStatus(error.status);
  // fetch() rejects with TypeError for DNS/TLS/reset failures and AbortSignal.timeout with a
  // TimeoutError; both are transient transport failures this retry is for. A malformed
  // archive is marked non-retryable at the write boundary and never reaches this branch.
  if (error instanceof TypeError) return true;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  return (
    typeof error?.code === "string" && (TRANSIENT_NETWORK_CODES.has(error.code) || error.code.startsWith("UND_ERR_"))
  );
}

export function downloadAttemptDelayMs(attempt) {
  return Math.min(1_000 * 2 ** (attempt - 1), 8_000);
}

async function fetchArchiveWithRetry({ url, attempts, fetchImpl, sleep, timeoutMs, log }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const error = new Error(`GET ${url} returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
        const error = new Error(`GET ${url} returned ${archive.length} bytes that are not a ZIP archive`);
        error.retryable = false;
        throw error;
      }
      return { archive, attempt };
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryableTransportError(error)) break;
      const delay = downloadAttemptDelayMs(attempt);
      log(`electron-runtime: attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function downloadArchive({ url, destination, attempts, fetchImpl, sleep, timeoutMs, log }) {
  // Only the transport phase is retried. Cache-directory and file-write failures are local
  // configuration/disk errors: re-running the download cannot fix them and would turn a
  // fail-closed error into repeated network traffic.
  const { archive, attempt } = await fetchArchiveWithRetry({
    url,
    attempts,
    fetchImpl,
    sleep,
    timeoutMs,
    log,
  });
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, archive);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  log(`electron-runtime: downloaded ${url} on attempt ${attempt}/${attempts}`);
  return attempt;
}

/**
 * Ensure the exact Electron archive for this platform is in the @electron/get cache.
 * Returns `cacheHit: true` without any network access when the archive is already there.
 */
export async function ensureElectronArchive({
  cacheRoot = defaultCacheRoot(),
  version = resolveElectronVersion(),
  platform = process.platform,
  arch = process.arch,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  log = console.log,
} = {}) {
  const url = electronDownloadUrl({ version, platform, arch });
  const archivePath = electronArchivePath({ cacheRoot, version, platform, arch });
  if (isCachedArchive(archivePath)) {
    log(`electron-runtime: cache hit at ${archivePath}`);
    return { cacheHit: true, archivePath, url, attempts: CACHE_HIT_ATTEMPTS };
  }
  if (existsSync(archivePath)) {
    // A cached file that is not a ZIP is a failed download that was written through a proxy
    // or interrupted mid-stream. Remove it at the write boundary instead of letting the
    // installer read it back and start a second, unbounded download.
    log(`electron-runtime: ignoring non-archive cache entry at ${archivePath}`);
    rmSync(archivePath, { force: true });
  }
  const usedAttempts = await downloadArchive({
    url,
    destination: archivePath,
    attempts,
    fetchImpl,
    sleep,
    timeoutMs,
    log,
  });
  return { cacheHit: false, archivePath, url, attempts: usedAttempts };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  if (argv.includes("--version")) {
    console.log(resolveElectronVersion());
    return 0;
  }
  const result = await ensureElectronArchive(overrides);
  console.log(`electron-runtime: ${result.cacheHit ? "cache hit" : "archive ready"} for ${result.url}`);
  // A check-run annotation is public evidence that this job did not need the releases
  // endpoint. Job logs need repository credentials; the annotation is readable from the PR.
  if (process.env.GITHUB_ACTIONS === "true") {
    const outcome = result.cacheHit
      ? "cache hit; no releases request"
      : `cache miss; downloaded on attempt ${result.attempts}`;
    console.log(`::notice title=electron-runtime-cache::${outcome} for ${result.url}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`electron-runtime: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
