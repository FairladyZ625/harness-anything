import { execFile } from "node:child_process";
import path from "node:path";
import { localImmutableCloneFileSystem } from "./durable-file.ts";

/**
 * Strict whitelist for content-addressed immutable objects (`objects/sha256/<2-hex>/<62-hex>`).
 * Files at these paths are named by their SHA-256 content digest and are never mutated in place.
 */
export const IMMUTABLE_CAS_OBJECT_PATH_PATTERN = /^(?:.*\/)?objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}$/u;

/**
 * Explicit denylist for mutable storage files (SQLite databases, WAL/SHM sidecars, JSON metadata,
 * lockfiles). Even if a caller passes a mixed directory or mislabeled path, these files MUST NEVER
 * be hard-linked.
 */
const MUTABLE_FILE_DENYLIST_PATTERN =
  /(?:^|\/)(?:[^/]+\.(?:sqlite|sqlite-wal|sqlite-shm|sqlite-journal|db|db-wal|db-shm|json|lock))$/iu;

const OBJECTS_SHA256_ROOT_SUFFIX = /(?:^|\/)objects\/sha256$/u;
const DEFAULT_CLONE_WORKERS = 24;
const MAX_CLONE_WORKERS = 64;
const REFS_PROBE_WAIT_MS = 3_000;

const HARDLINK_FALLBACK_CODES = new Set([
  "EXDEV",
  "EMLINK",
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EINVAL",
  "EROFS",
]);

const HARDLINK_VOLUME_SHORT_CIRCUIT_CODES = new Set(["EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EROFS"]);

const FICLONE_FALLBACK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL", "EPERM", "EACCES"]);

export type ImmutableCloneFileSystem = typeof localImmutableCloneFileSystem;

export interface SyncCloneSessionState {
  hardlinkUnavailableOnVolume: boolean;
  ficloneUnavailableOnVolume: boolean;
  fallbackReason: string | null;
}

export interface CloneTreeStats {
  readonly hardlinkedFiles: number;
  readonly clonedFiles: number;
  readonly copiedFiles: number;
  readonly symlinkedFiles: number;
  readonly skippedExistingFiles: number;
  readonly totalFiles: number;
  readonly elapsedMs: number;
  readonly fallbackReason: string | null;
  readonly mutableCloneMethod: "refs-cow" | "ficlone" | "copy" | "none";
}

export interface RefsVolumeProbeResult {
  readonly supported: boolean;
  readonly fileSystem: string | null;
  readonly volumeRoot: string | null;
  readonly reason: string;
}

export interface MutableFileCloner {
  readonly name: string;
  cloneFile(sourcePath: string, destinationPath: string): Promise<boolean>;
}

export interface TryCloneMutableFileResult {
  readonly method: "refs-cow" | "ficlone" | "copy";
  readonly fallbackReason: string | null;
}

export interface TryCloneMutableFileOptions {
  readonly mutableFileCloner?: MutableFileCloner;
  readonly overwriteExisting?: boolean;
  readonly fs?: Partial<ImmutableCloneFileSystem>;
  readonly ficloneState?: { ficloneUnavailableOnVolume: boolean };
}

export interface CloneImmutableTreeOptions {
  readonly concurrency?: number;
  readonly onExisting?: "unlink-and-replace" | "skip-if-same-size";
  readonly mutableFileCloner?: MutableFileCloner;
  readonly fs?: Partial<ImmutableCloneFileSystem>;
  readonly exclude?: (sourcePath: string, relativePath: string, isDirectory: boolean) => boolean;
  readonly onProgress?: (progress: {
    readonly completed: number;
    readonly total: number;
    readonly hardlinkedFiles: number;
    readonly copiedFiles: number;
  }) => void;
}

export interface CloneFileSyncOptions {
  readonly session?: SyncCloneSessionState;
  readonly onExisting?: "unlink-and-replace" | "error";
  readonly linkSync?: (sourcePath: string, destinationPath: string) => void;
  readonly unlinkSync?: (targetPath: string) => void;
  readonly copyFileSync?: (sourcePath: string, destinationPath: string, mode?: number) => void;
  readonly ficloneMode?: number;
}

export interface CloneFileSyncResult {
  readonly method: "hardlink" | "ficlone" | "copy";
  readonly fallbackReason: string | null;
}

export interface CloneTreeSyncOptions {
  readonly session?: SyncCloneSessionState;
  readonly onExisting?: "unlink-and-replace" | "error";
  readonly fs?: Partial<ImmutableCloneFileSystem>;
  readonly exclude?: (sourcePath: string, relativePath: string, isDirectory: boolean) => boolean;
}

export interface ProbeRefsVolumeOptions {
  readonly platform?: NodeJS.Platform;
  readonly execFsutil?: (volumeRoot: string) => Promise<string>;
  readonly bypassCache?: boolean;
}

export interface WindowsRefsMutableClonerOptions {
  readonly platform?: NodeJS.Platform;
  readonly probe?: (dirPath: string) => Promise<RefsVolumeProbeResult>;
  /**
   * Optional host-provided `FSCTL_DUPLICATE_EXTENTS_TO_FILE` implementation for Windows ReFS
   * mutable files. Must return `true` only when the destination file has been completely populated.
   * When omitted or returning `false`, callers fall back cleanly to `COPYFILE_FICLONE` / byte copy.
   */
  readonly duplicateExtents?: (sourcePath: string, destinationPath: string) => Promise<boolean>;
}

type AttemptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string | null; readonly error: unknown };

const refsProbeCache = new Map<string, RefsVolumeProbeResult>();

function normalizeRelativePath(inputPath: string): string {
  return inputPath
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/u, "")
    .replace(/^\/+/u, "");
}

function errnoCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
    return error.code;
  return null;
}

function hasPathTraversal(normalizedPath: string): boolean {
  return normalizedPath.split("/").some((segment) => segment === "..");
}

function attemptSync<T>(operation: () => T): AttemptResult<T> {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    const code = errnoCode(error);
    return { ok: false, code, error };
  }
}

async function attemptAsync<T>(operation: () => Promise<T>): Promise<AttemptResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const code = errnoCode(error);
    return { ok: false, code, error };
  }
}

function detachIfPresentSync(detachFn: (targetPath: string) => void, targetPath: string): void {
  const result = attemptSync(() => detachFn(targetPath));
  if (!result.ok && result.code !== "ENOENT") throw result.error;
}

async function detachIfPresentAsync(
  detachFn: (targetPath: string) => Promise<void>,
  targetPath: string,
): Promise<void> {
  const result = await attemptAsync(() => detachFn(targetPath));
  if (!result.ok && result.code !== "ENOENT") throw result.error;
}

/**
 * Returns true if the path matches an explicitly mutable storage artifact (SQLite DB, WAL/SHM,
 * JSON metadata, lockfile) that must never be hard-linked.
 */
export function isMutableFilePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return MUTABLE_FILE_DENYLIST_PATTERN.test(normalized) || !isImmutableCasObjectPath(normalized);
}

/**
 * Fail-closed check for immutable content-addressed object paths (`objects/sha256/<2>/<62>`).
 * Rejects mutable extensions, path traversal, and any non-SHA-256 layout.
 */
export function isImmutableCasObjectPath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return (
    normalized.length > 0 &&
    !hasPathTraversal(normalized) &&
    !MUTABLE_FILE_DENYLIST_PATTERN.test(normalized) &&
    IMMUTABLE_CAS_OBJECT_PATH_PATTERN.test(normalized)
  );
}

function casCandidatePath(sourceRoot: string, relativePath: string): string {
  const normalizedRoot = sourceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedRel = normalizeRelativePath(relativePath);
  if (OBJECTS_SHA256_ROOT_SUFFIX.test(normalizedRoot)) return `objects/sha256/${normalizedRel}`;
  return normalizedRel;
}

export function createSyncCloneSessionState(): SyncCloneSessionState {
  return {
    hardlinkUnavailableOnVolume: false,
    ficloneUnavailableOnVolume: false,
    fallbackReason: null,
  };
}

function resolveFs(overrides?: Partial<ImmutableCloneFileSystem>): ImmutableCloneFileSystem {
  return overrides
    ? ({ ...localImmutableCloneFileSystem, ...overrides } as ImmutableCloneFileSystem)
    : localImmutableCloneFileSystem;
}

/**
 * Copy a single mutable file synchronously with `COPYFILE_FICLONE` preference and byte-copy fallback.
 * Never creates a hard link.
 */
export function copyFileWithFicloneFallbackSync(
  sourcePath: string,
  destinationPath: string,
  options: {
    readonly session?: SyncCloneSessionState;
    readonly copyFileSync?: (sourcePath: string, destinationPath: string, mode?: number) => void;
    readonly ficloneMode?: number;
  } = {},
): { readonly method: "ficlone" | "copy"; readonly fallbackReason: string | null } {
  const copyFn = options.copyFileSync ?? localImmutableCloneFileSystem.copyFileSync;
  const ficloneMode = options.ficloneMode ?? localImmutableCloneFileSystem.constants.COPYFILE_FICLONE;
  const session = options.session;

  if (!session?.ficloneUnavailableOnVolume) {
    const attempt = attemptSync(() => copyFn(sourcePath, destinationPath, ficloneMode));
    if (attempt.ok) return { method: "ficlone", fallbackReason: null };
    if (attempt.code === null || !FICLONE_FALLBACK_CODES.has(attempt.code)) throw attempt.error;
    if (session) session.ficloneUnavailableOnVolume = true;
    copyFn(sourcePath, destinationPath);
    return { method: "copy", fallbackReason: attempt.code };
  }
  copyFn(sourcePath, destinationPath);
  return { method: "copy", fallbackReason: session.fallbackReason };
}

/**
 * Synchronously clone a single file:
 * - Immutable CAS objects (`objects/sha256/<2>/<62>`) prefer `linkSync` (zero-byte hard link) with
 *   clean fallback to `COPYFILE_FICLONE` -> plain copy on `EXDEV`/`EMLINK`/`EPERM`/`ENOTSUP`.
 * - All mutable files NEVER call `linkSync`; they always produce an independent copy.
 */
export function cloneFileWithHardlinkPreferenceSync(
  sourcePath: string,
  destinationPath: string,
  candidatePath: string,
  options: CloneFileSyncOptions = {},
): CloneFileSyncResult {
  const session = options.session ?? createSyncCloneSessionState();
  const linkFn = options.linkSync ?? localImmutableCloneFileSystem.linkSync;
  const detachFn = options.unlinkSync ?? localImmutableCloneFileSystem.unlinkSync;
  const copyFn = options.copyFileSync ?? localImmutableCloneFileSystem.copyFileSync;
  const onExisting = options.onExisting ?? "unlink-and-replace";

  if (isImmutableCasObjectPath(candidatePath) && !session.hardlinkUnavailableOnVolume) {
    const first = attemptSync(() => linkFn(sourcePath, destinationPath));
    if (first.ok) return { method: "hardlink", fallbackReason: null };
    if (first.code === "EEXIST" && onExisting === "unlink-and-replace") {
      detachFn(destinationPath);
      const second = attemptSync(() => linkFn(sourcePath, destinationPath));
      if (second.ok) return { method: "hardlink", fallbackReason: null };
      if (second.code === null || !HARDLINK_FALLBACK_CODES.has(second.code)) throw second.error;
      session.fallbackReason ??= second.code;
      if (HARDLINK_VOLUME_SHORT_CIRCUIT_CODES.has(second.code)) session.hardlinkUnavailableOnVolume = true;
    } else if (first.code !== null && HARDLINK_FALLBACK_CODES.has(first.code)) {
      session.fallbackReason ??= first.code;
      if (HARDLINK_VOLUME_SHORT_CIRCUIT_CODES.has(first.code)) session.hardlinkUnavailableOnVolume = true;
    } else {
      throw first.error;
    }
  }

  // Mutable file or hardlink fallback: detach existing target first so we never write through
  // a preexisting hard link, unless caller explicitly requested error-on-exist.
  if (onExisting === "unlink-and-replace") detachIfPresentSync(detachFn, destinationPath);
  const copied = copyFileWithFicloneFallbackSync(sourcePath, destinationPath, {
    session,
    copyFileSync: copyFn,
    ficloneMode: options.ficloneMode,
  });
  return {
    method: copied.method,
    fallbackReason: session.fallbackReason ?? copied.fallbackReason,
  };
}

/**
 * Synchronously clone a directory tree, hard-linking immutable CAS objects (`objects/sha256/<2>/<62>`)
 * and copying all other (mutable) files independently.
 */
export function cloneTreeSync(
  sourceDir: string,
  destinationDir: string,
  options: CloneTreeSyncOptions = {},
): CloneTreeStats {
  const startedAt = Date.now();
  const fs = resolveFs(options.fs);
  const detachFn = fs.unlinkSync;
  const session = options.session ?? createSyncCloneSessionState();
  const onExisting = options.onExisting ?? "unlink-and-replace";
  let hardlinkedFiles = 0;
  let clonedFiles = 0;
  let copiedFiles = 0;
  let symlinkedFiles = 0;

  const walk = (srcCurrent: string, dstCurrent: string, relPrefix: string): void => {
    fs.mkdirSync(dstCurrent, { recursive: true });
    const entries = fs.readdirSync(srcCurrent, { withFileTypes: true });
    for (const entry of entries) {
      const childSrc = path.join(srcCurrent, entry.name);
      const childDst = path.join(dstCurrent, entry.name);
      const childRel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
      const isDir = entry.isDirectory();
      if (options.exclude?.(childSrc, childRel, isDir)) continue;
      if (isDir) {
        walk(childSrc, childDst, childRel);
      } else if (entry.isSymbolicLink()) {
        if (onExisting === "unlink-and-replace") detachIfPresentSync(detachFn, childDst);
        fs.symlinkSync(fs.readlinkSync(childSrc), childDst);
        symlinkedFiles += 1;
      } else if (entry.isFile()) {
        const result = cloneFileWithHardlinkPreferenceSync(childSrc, childDst, casCandidatePath(sourceDir, childRel), {
          session,
          onExisting,
          linkSync: fs.linkSync,
          unlinkSync: detachFn,
          copyFileSync: fs.copyFileSync,
          ficloneMode: fs.constants.COPYFILE_FICLONE,
        });
        if (result.method === "hardlink") hardlinkedFiles += 1;
        else if (result.method === "ficlone") clonedFiles += 1;
        else copiedFiles += 1;
      }
    }
  };

  walk(sourceDir, destinationDir, "");

  return {
    hardlinkedFiles,
    clonedFiles,
    copiedFiles,
    symlinkedFiles,
    skippedExistingFiles: 0,
    totalFiles: hardlinkedFiles + clonedFiles + copiedFiles + symlinkedFiles,
    elapsedMs: Date.now() - startedAt,
    fallbackReason: session.fallbackReason,
    mutableCloneMethod: clonedFiles > 0 ? "ficlone" : copiedFiles > 0 ? "copy" : "none",
  };
}

/**
 * Probe whether `dirPath` resides on a Windows ReFS volume (optional acceleration probe).
 * - Non-blocking (async `fsutil` with `windowsHide: true` and 3s wait cap, cached per drive root).
 * - Immediately returns `{ supported: false, reason: "non-win32" }` on macOS/Linux.
 * - Never throws; any probe failure cleanly reports `supported: false`.
 */
export async function probeRefsVolume(
  dirPath: string,
  options: ProbeRefsVolumeOptions = {},
): Promise<RefsVolumeProbeResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { supported: false, fileSystem: null, volumeRoot: null, reason: "non-win32" };
  }
  const volumeRoot = path.win32.parse(path.win32.resolve(dirPath)).root;
  if (!volumeRoot) {
    return { supported: false, fileSystem: null, volumeRoot: null, reason: "no-volume-root" };
  }
  const cacheKey = volumeRoot.toUpperCase();
  if (!options.bypassCache && !options.execFsutil) {
    const cached = refsProbeCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const execFsutil = options.execFsutil ?? runFsutilVolumeInfo;
  const attempt = await attemptAsync(() => execFsutil(volumeRoot));
  let result: RefsVolumeProbeResult;
  if (attempt.ok) {
    const parsedFs = parseFsutilFileSystemName(attempt.value);
    if (parsedFs !== null && parsedFs.toUpperCase() === "REFS") {
      result = { supported: true, fileSystem: parsedFs, volumeRoot, reason: "refs-volume-detected" };
    } else {
      result = {
        supported: false,
        fileSystem: parsedFs,
        volumeRoot,
        reason: parsedFs ? `unsupported-fs:${parsedFs}` : "filesystem-name-not-found",
      };
    }
  } else {
    result = {
      supported: false,
      fileSystem: null,
      volumeRoot,
      reason: attempt.code ? `probe-failed:${attempt.code}` : "probe-failed",
    };
  }
  if (!options.bypassCache && !options.execFsutil) refsProbeCache.set(cacheKey, result);
  return result;
}

export function clearRefsVolumeProbeCache(): void {
  refsProbeCache.clear();
}

function parseFsutilFileSystemName(output: string): string | null {
  const english = /File System Name\s*:\s*([^\r\n]+)/iu.exec(output);
  if (english?.[1]) return english[1].trim();
  const known = /:\s*(ReFS|NTFS|FAT32|exFAT)\b/iu.exec(output);
  if (known?.[1]) return known[1].trim();
  return null;
}

function runFsutilVolumeInfo(volumeRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "fsutil",
      ["fsinfo", "volumeinfo", volumeRoot],
      { windowsHide: true, timeout: REFS_PROBE_WAIT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Build an optional pluggable `MutableFileCloner` for Windows ReFS (`FSCTL_DUPLICATE_EXTENTS_TO_FILE`).
 * ReFS CoW is strictly an optional accelerator for large mutable files — never a hard dependency
 * and never a replacement for cross-platform hard-linking of immutable CAS objects.
 */
export function createWindowsRefsMutableCloner(options: WindowsRefsMutableClonerOptions = {}): MutableFileCloner {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? ((dirPath: string) => probeRefsVolume(dirPath, { platform }));
  const duplicateExtents = options.duplicateExtents;
  return {
    name: "windows-refs-duplicate-extents",
    async cloneFile(sourcePath: string, destinationPath: string): Promise<boolean> {
      if (platform !== "win32" || !duplicateExtents) return false;
      const srcRoot = path.win32.parse(path.win32.resolve(sourcePath)).root.toUpperCase();
      const dstRoot = path.win32.parse(path.win32.resolve(destinationPath)).root.toUpperCase();
      if (!srcRoot || srcRoot !== dstRoot) return false;
      const probeResult = await probe(path.win32.dirname(destinationPath));
      if (!probeResult.supported) return false;
      return await duplicateExtents(sourcePath, destinationPath);
    },
  };
}

/**
 * Clone a mutable file safely without EVER creating a hard link:
 * 1. Detach any preexisting destination first so a prior hard link is never mutated in place.
 * 2. Optionally attempt a pluggable `MutableFileCloner` (e.g., Windows ReFS block clone).
 * 3. Attempt `copyFile(..., COPYFILE_FICLONE)` (APFS / Btrfs / XFS).
 * 4. Fall back cleanly to plain `copyFile(...)`.
 */
export async function tryCloneMutableFile(
  sourcePath: string,
  destinationPath: string,
  options: TryCloneMutableFileOptions = {},
): Promise<TryCloneMutableFileResult> {
  const fs = resolveFs(options.fs);
  const detachFn = fs.unlink;
  const overwriteExisting = options.overwriteExisting ?? true;
  let fallbackReason: string | null = null;

  if (overwriteExisting) await detachIfPresentAsync(detachFn, destinationPath);

  if (options.mutableFileCloner) {
    const cloner = options.mutableFileCloner;
    const refsAttempt = await attemptAsync(() => cloner.cloneFile(sourcePath, destinationPath));
    if (refsAttempt.ok && refsAttempt.value) return { method: "refs-cow", fallbackReason: null };
    if (!refsAttempt.ok) {
      fallbackReason = refsAttempt.code ?? "refs-cow-failed";
      await detachIfPresentAsync(detachFn, destinationPath);
    }
  }

  const ficloneState = options.ficloneState;
  if (!ficloneState?.ficloneUnavailableOnVolume) {
    const ficloneAttempt = await attemptAsync(() =>
      fs.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_FICLONE),
    );
    if (ficloneAttempt.ok) return { method: "ficlone", fallbackReason };
    if (ficloneAttempt.code === null || !FICLONE_FALLBACK_CODES.has(ficloneAttempt.code)) throw ficloneAttempt.error;
    if (ficloneState) ficloneState.ficloneUnavailableOnVolume = true;
    fallbackReason ??= ficloneAttempt.code;
  }

  await fs.copyFile(sourcePath, destinationPath);
  return { method: "copy", fallbackReason };
}

interface TreeEntry {
  readonly src: string;
  readonly dst: string;
  readonly rel: string;
  readonly kind: "immutable-cas" | "mutable-file" | "symlink";
}

async function runBounded<T>(
  items: readonly T[],
  workerCap: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(workerCap, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const current = items[nextIndex++];
        if (current !== undefined) await worker(current);
      }
    }),
  );
}

/**
 * Clone a directory tree asynchronously with cross-platform zero-byte hard-linking for immutable
 * CAS files (`objects/sha256/<2>/<62>`) and safe independent copy/CoW for all mutable files.
 */
export async function cloneImmutableTree(
  sourceDir: string,
  destinationDir: string,
  options: CloneImmutableTreeOptions = {},
): Promise<CloneTreeStats> {
  const startedAt = Date.now();
  const fs = resolveFs(options.fs);
  const detachFn = fs.unlink;
  const workerCap = Math.max(1, Math.min(MAX_CLONE_WORKERS, Math.trunc(options.concurrency ?? DEFAULT_CLONE_WORKERS)));
  const onExisting = options.onExisting ?? "unlink-and-replace";

  const dirsToCreate: string[] = [destinationDir];
  const entries: TreeEntry[] = [];

  const collect = async (srcCurrent: string, dstCurrent: string, relPrefix: string): Promise<void> => {
    const dirEntries = await fs.readdir(srcCurrent, { withFileTypes: true });
    const subdirs: { readonly src: string; readonly dst: string; readonly rel: string }[] = [];
    for (const entry of dirEntries) {
      const childSrc = path.join(srcCurrent, entry.name);
      const childDst = path.join(dstCurrent, entry.name);
      const childRel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
      const isDir = entry.isDirectory();
      if (options.exclude?.(childSrc, childRel, isDir)) continue;
      if (isDir) {
        dirsToCreate.push(childDst);
        subdirs.push({ src: childSrc, dst: childDst, rel: childRel });
      } else if (entry.isSymbolicLink()) {
        entries.push({ src: childSrc, dst: childDst, rel: childRel, kind: "symlink" });
      } else if (entry.isFile()) {
        const candidate = casCandidatePath(sourceDir, childRel);
        entries.push({
          src: childSrc,
          dst: childDst,
          rel: childRel,
          kind: isImmutableCasObjectPath(candidate) ? "immutable-cas" : "mutable-file",
        });
      }
    }
    await runBounded(subdirs, workerCap, (sub) => collect(sub.src, sub.dst, sub.rel));
  };

  await collect(sourceDir, destinationDir, "");

  // Create root first, then fan out bucket/subdirectory creation concurrently.
  await fs.mkdir(destinationDir, { recursive: true });
  await runBounded(dirsToCreate.slice(1), workerCap, async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  });

  let hardlinkUnavailableOnVolume = false;
  const ficloneState = { ficloneUnavailableOnVolume: false };
  let fallbackReason: string | null = null;
  let hardlinkedFiles = 0;
  let clonedFiles = 0;
  let copiedFiles = 0;
  let symlinkedFiles = 0;
  let skippedExistingFiles = 0;
  let completed = 0;
  let observedRefsCow = false;

  const tryHardlinkImmutable = async (src: string, dst: string): Promise<"hardlinked" | "skipped" | "fallback"> => {
    if (hardlinkUnavailableOnVolume) return "fallback";
    const first = await attemptAsync(() => fs.link(src, dst));
    if (first.ok) return "hardlinked";
    if (first.code === "EEXIST") {
      if (onExisting === "skip-if-same-size") {
        const [srcStat, dstStat] = await Promise.all([fs.lstat(src), fs.lstat(dst)]);
        if (dstStat.isFile() && srcStat.isFile() && dstStat.size === srcStat.size) return "skipped";
      }
      await detachFn(dst);
      const second = await attemptAsync(() => fs.link(src, dst));
      if (second.ok) return "hardlinked";
      if (second.code === null || !HARDLINK_FALLBACK_CODES.has(second.code)) throw second.error;
      fallbackReason ??= second.code;
      if (HARDLINK_VOLUME_SHORT_CIRCUIT_CODES.has(second.code)) hardlinkUnavailableOnVolume = true;
      return "fallback";
    }
    if (first.code !== null && HARDLINK_FALLBACK_CODES.has(first.code)) {
      fallbackReason ??= first.code;
      if (HARDLINK_VOLUME_SHORT_CIRCUIT_CODES.has(first.code)) hardlinkUnavailableOnVolume = true;
      return "fallback";
    }
    throw first.error;
  };

  await runBounded(entries, workerCap, async (item) => {
    if (item.kind === "symlink") {
      await detachIfPresentAsync(detachFn, item.dst);
      await fs.symlink(await fs.readlink(item.src), item.dst);
      symlinkedFiles += 1;
    } else if (item.kind === "immutable-cas") {
      const outcome = await tryHardlinkImmutable(item.src, item.dst);
      if (outcome === "hardlinked") {
        hardlinkedFiles += 1;
      } else if (outcome === "skipped") {
        skippedExistingFiles += 1;
      } else {
        // Fallback for immutable CAS when hardlinking is unavailable (e.g. EXDEV / EMLINK).
        const copied = await tryCloneMutableFile(item.src, item.dst, {
          overwriteExisting: true,
          fs,
          ficloneState,
        });
        if (copied.method === "ficlone") clonedFiles += 1;
        else copiedFiles += 1;
      }
    } else {
      // Mutable file: NEVER hard-linked.
      const copied = await tryCloneMutableFile(item.src, item.dst, {
        mutableFileCloner: options.mutableFileCloner,
        overwriteExisting: true,
        fs,
        ficloneState,
      });
      if (copied.method === "refs-cow") {
        observedRefsCow = true;
        clonedFiles += 1;
      } else if (copied.method === "ficlone") {
        clonedFiles += 1;
      } else {
        copiedFiles += 1;
      }
    }
    completed += 1;
    if (options.onProgress && (completed === entries.length || completed % 2048 === 0)) {
      options.onProgress({
        completed,
        total: entries.length,
        hardlinkedFiles,
        copiedFiles: clonedFiles + copiedFiles,
      });
    }
  });

  const mutableCloneMethod: CloneTreeStats["mutableCloneMethod"] = observedRefsCow
    ? "refs-cow"
    : clonedFiles > 0
      ? "ficlone"
      : copiedFiles > 0
        ? "copy"
        : "none";

  return {
    hardlinkedFiles,
    clonedFiles,
    copiedFiles,
    symlinkedFiles,
    skippedExistingFiles,
    totalFiles: entries.length,
    elapsedMs: Date.now() - startedAt,
    fallbackReason,
    mutableCloneMethod,
  };
}
