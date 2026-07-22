import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, watch } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import {
  createHarnessRuntimeContext,
  resolveGitMaxBufferBytes,
  resolveHarnessLayout,
  resolveProjectionMaxChangedPaths,
  type HarnessLayoutOverrides,
  type ProjectionSourceFence,
  type ProjectionSourceFenceReader
} from "@harness-anything/kernel";

const gitMaxBuffer = resolveGitMaxBufferBytes();
const maxChangedPaths = resolveProjectionMaxChangedPaths();

export function makeLocalProjectionSourceFenceReader(options: {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly watchFactory?: typeof watch;
}): ProjectionSourceFenceReader {
  const runtimeContext = createHarnessRuntimeContext(options.rootDir, options.layoutOverrides);
  const resolvedAuthoredRoot = resolveExistingRoot(resolveHarnessLayout(runtimeContext).authoredRoot);
  if (resolvedAuthoredRoot === null) {
    return { capture: () => ({ kind: "unknown", reason: "git-unavailable" }) };
  }
  const authoredRoot: string = resolvedAuthoredRoot;
  const repoRoot = resolveGitRoot(authoredRoot);
  const listeners = new Set<() => void>();
  let closed = false;
  let watcherHealthy = true;
  let watchRevision = 0;
  let currentFence: ProjectionSourceFence | undefined;
  let refreshInFlight: Promise<ProjectionSourceFence> | undefined;
  const watchers: Array<ReturnType<typeof watch>> = [];
  const watchFactory = options.watchFactory ?? watch;
  addWatcher(authoredRoot, (filename) => !isGitMetadataPath(filename));
  for (const gitRoot of resolveGitWatchRoots(authoredRoot)) {
    addWatcher(gitRoot, isGenerationRelevantGitPath);
  }
  return {
    capture: () => watcherHealthy && currentFence?.kind === "stable" ? currentFence : refresh(),
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
      closed = true;
      currentFence = { kind: "unknown", reason: "git-unavailable" };
      listeners.clear();
    }
  };

  function addWatcher(inputPath: string, relevant: (filename: string | null) => boolean): void {
    try {
      const watcher = watchFactory(inputPath, { recursive: true }, (_eventType, filename) => {
        const normalized = normalizedWatchPath(filename);
        if (!relevant(normalized)) return;
        invalidateFromWatch();
      });
      watcher.on("error", () => {
        watcherHealthy = false;
        invalidateFromWatch("git-unavailable");
      });
      watcher.unref();
      watchers.push(watcher);
    } catch {
      watcherHealthy = false;
    }
  }

  function invalidateFromWatch(reason: "unstable" | "git-unavailable" = "unstable"): void {
    watchRevision += 1;
    currentFence = { kind: "unknown", reason };
    for (const listener of listeners) listener();
  }

  function refresh(): Promise<ProjectionSourceFence> {
    if (closed) return Promise.resolve({ kind: "unknown", reason: "git-unavailable" });
    if (refreshInFlight) return refreshInFlight;
    const startedRevision = watchRevision;
    const pending = captureStableProjectionSourceFence(authoredRoot, repoRoot).then((captured) => {
      if (watchRevision !== startedRevision) {
        currentFence = { kind: "unknown", reason: "unstable" };
        return currentFence;
      }
      currentFence = captured;
      return captured;
    });
    refreshInFlight = pending;
    void pending.finally(() => {
      if (refreshInFlight === pending) refreshInFlight = undefined;
    }).catch(() => undefined);
    return pending;
  }
}

function normalizedWatchPath(filename: string | Buffer | null): string | null {
  return filename === null ? null : String(filename).split(path.sep).join("/");
}

function isGitMetadataPath(filename: string | null): boolean {
  return filename === ".git" || filename?.startsWith(".git/") === true;
}

function isGenerationRelevantGitPath(filename: string | null): boolean {
  if (filename === null) return true;
  return filename === "HEAD" || filename === "index" || filename === "packed-refs" || filename.startsWith("refs/heads/");
}

function resolveExistingRoot(inputPath: string): string | null {
  try {
    return realpathSync.native(inputPath);
  } catch {
    return null;
  }
}

async function captureStableProjectionSourceFence(
  authoredRoot: string,
  repoRoot: string | null
): Promise<ProjectionSourceFence> {
  if (!repoRoot) return { kind: "unknown", reason: "git-unavailable" };
  // The reader rejects watcher activity during this capture; the generation manager
  // independently requires matching authoritative captures before and after materialization.
  return captureProjectionSourceFence(authoredRoot, repoRoot);
}

async function captureProjectionSourceFence(authoredRoot: string, repoRoot: string): Promise<ProjectionSourceFence> {
  let status: string;
  try {
    const authoredPathspec = repoRelativePath(repoRoot, authoredRoot);
    const [statusOutput, trackedFiles] = await Promise.all([
      runGit(repoRoot, [
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--no-ahead-behind",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--",
        authoredPathspec
      ]),
      runGit(repoRoot, ["ls-files", "-v", "-z", "--", authoredPathspec])
    ]);
    status = statusOutput;
    if (hasUnsafeTrackedFileFlags(trackedFiles)) return { kind: "unknown", reason: "unsupported-source" };
  } catch {
    return { kind: "unknown", reason: "git-unavailable" };
  }

  const parsed = parseProjectionStatus(status, repoRoot, authoredRoot);
  if (parsed.kind === "unknown") return parsed;
  const digest = createHash("sha256");
  digest.update("projection-source-fence/v1\0");
  digest.update(status);
  for (const changedPath of parsed.changedPaths) {
    digest.update("\0path\0");
    digest.update(repoRelativePath(repoRoot, changedPath));
    const content = await hashWorkingTreePath(changedPath);
    if (content === null) return { kind: "unknown", reason: "unsupported-source" };
    digest.update("\0content\0");
    digest.update(content);
  }
  return {
    kind: "stable",
    identity: `sha256:${digest.digest("hex")}`,
    headOid: parsed.headOid,
    dirty: parsed.changedPaths.length > 0,
    changedPaths: parsed.changedPaths
  };
}

function parseProjectionStatus(
  status: string,
  repoRoot: string,
  authoredRoot: string
): ProjectionSourceFence | { readonly kind: "parsed"; readonly headOid: string; readonly changedPaths: ReadonlyArray<string> } {
  const records = status.split("\0").filter((record) => record.length > 0);
  const headRecord = records.find((record) => record.startsWith("# branch.oid "));
  const headOid = headRecord?.slice("# branch.oid ".length).trim();
  if (!headOid || headOid === "(initial)") return { kind: "unknown", reason: "unborn-head" };
  const changedPaths = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# ")) continue;
    if (record.startsWith("u ")) return { kind: "unknown", reason: "unmerged" };
    let relativePaths: ReadonlyArray<string>;
    if (record.startsWith("1 ")) {
      relativePaths = [fieldAfterSpaces(record, 8)];
    } else if (record.startsWith("2 ")) {
      const originalPath = records[index + 1];
      if (!originalPath) return { kind: "unknown", reason: "unsafe-path" };
      relativePaths = [fieldAfterSpaces(record, 9), originalPath];
      index += 1;
    } else if (record.startsWith("? ") || record.startsWith("! ")) {
      relativePaths = [record.slice(2)];
    } else {
      return { kind: "unknown", reason: "unsafe-path" };
    }
    for (const relativePath of relativePaths) {
      const absolutePath = safeAuthoredPath(repoRoot, authoredRoot, relativePath);
      if (!absolutePath) return { kind: "unknown", reason: "unsafe-path" };
      changedPaths.add(absolutePath);
      if (changedPaths.size > maxChangedPaths) return { kind: "unknown", reason: "dirty-unbounded" };
    }
  }
  return {
    kind: "parsed",
    headOid,
    changedPaths: [...changedPaths].sort((left, right) => left.localeCompare(right))
  };
}

function resolveGitRoot(authoredRoot: string): string | null {
  try {
    return realpathSync.native(execFileSync("git", ["-C", authoredRoot, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }).trim());
  } catch {
    return null;
  }
}

function resolveGitWatchRoots(authoredRoot: string): ReadonlyArray<string> {
  const roots = new Set<string>();
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    try {
      const value = execFileSync("git", ["-C", authoredRoot, "rev-parse", flag], {
        encoding: "utf8",
        maxBuffer: gitMaxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }).trim();
      roots.add(realpathSync.native(path.isAbsolute(value) ? value : path.resolve(authoredRoot, value)));
    } catch {
      // The authored watcher plus authoritative refresh remain available.
    }
  }
  return [...roots];
}

function runGit(repoRoot: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function hasUnsafeTrackedFileFlags(output: string): boolean {
  return output.split("\0").some((record) => record.length > 0 && record[0] !== "H");
}

function repoRelativePath(repoRoot: string, inputPath: string): string {
  const relativePath = path.relative(repoRoot, inputPath).split(path.sep).join("/");
  return relativePath.length > 0 ? relativePath : ".";
}

function safeAuthoredPath(repoRoot: string, authoredRoot: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const absolutePath = path.resolve(repoRoot, relativePath);
  const relativeToAuthored = path.relative(authoredRoot, absolutePath);
  if (relativeToAuthored === ".." || relativeToAuthored.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToAuthored)) return null;
  return absolutePath;
}

function fieldAfterSpaces(record: string, count: number): string {
  let offset = 0;
  for (let field = 0; field < count; field += 1) {
    offset = record.indexOf(" ", offset);
    if (offset < 0) return "";
    offset += 1;
  }
  return record.slice(offset);
}

async function hashWorkingTreePath(inputPath: string): Promise<string | null> {
  try {
    const stat = await lstat(inputPath);
    if (stat.isSymbolicLink()) {
      return `symlink:${createHash("sha256").update(await readlink(inputPath)).digest("hex")}`;
    }
    if (!stat.isFile()) return null;
    return `file:${createHash("sha256").update(await readFile(inputPath)).digest("hex")}`;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT") {
      return "absent";
    }
    return null;
  }
}
