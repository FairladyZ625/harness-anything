import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const ignoredDirectories = new Set(["node_modules", "dist", "coverage", ".git"]);
const productRoots = ["packages", "tools", ".github"];

export function collectProductFileHashes(rootDir) {
  return Object.fromEntries(productRoots
    .flatMap((relativeRoot) => walkFiles(rootDir, relativeRoot))
    .sort()
    .map((relativePath) => [relativePath, sha256(readFileSync(path.join(rootDir, relativePath))) ]));
}

export function diffFileHashes(current, previous) {
  const previousHashes = previous ?? {};
  const added = Object.keys(current).filter((file) => previousHashes[file] === undefined).sort();
  const changed = Object.keys(current).filter((file) => previousHashes[file] !== undefined && previousHashes[file] !== current[file]).sort();
  const deleted = Object.keys(previousHashes).filter((file) => current[file] === undefined).sort();
  return { added, changed, deleted };
}

export function selectPriorSnapshot(tasksRoot, currentTaskId) {
  const warnings = [];
  if (!existsSync(tasksRoot)) return { snapshot: null, sourcePath: null, warnings };
  const candidates = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const snapshotPath = path.join(tasksRoot, entry.name, "artifacts", "arch-rot.snapshot.json");
    if (!existsSync(snapshotPath)) continue;
    try {
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      if (snapshot.schema !== "architecture-rot-snapshot/v1") throw new Error("unexpected schema");
      if (typeof snapshot.coordinationTaskId !== "string" || !snapshot.coordinationTaskId) throw new Error("missing task id");
      if (snapshot.coordinationTaskId === currentTaskId || entry.name.startsWith(`${currentTaskId}-`) || entry.name === currentTaskId) continue;
      const generatedAt = Date.parse(snapshot.generatedAt);
      if (!Number.isFinite(generatedAt)) throw new Error("invalid generatedAt");
      candidates.push({ snapshot, snapshotPath, generatedAt, taskId: snapshot.coordinationTaskId });
    } catch (error) {
      warnings.push(`Ignored invalid architecture rot snapshot ${toSlash(snapshotPath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  candidates.sort((left, right) => right.generatedAt - left.generatedAt || right.taskId.localeCompare(left.taskId));
  const selected = candidates[0];
  return selected ? {
    snapshot: selected.snapshot,
    sourcePath: selected.snapshotPath,
    warnings
  } : { snapshot: null, sourcePath: null, warnings };
}

export function readGitHead(rootDir) {
  try {
    const dotGit = path.join(rootDir, ".git");
    const gitDir = lstatSync(dotGit).isDirectory()
      ? dotGit
      : resolveGitDir(rootDir, readFileSync(dotGit, "utf8"));
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/u.test(head)) return { sourceHead: head, headVerification: "verified" };
    const ref = /^ref:\s+(.+)$/u.exec(head)?.[1];
    if (!ref) return { sourceHead: "unverified", headVerification: "unverified" };
    const looseRef = path.join(gitDir, ref);
    if (existsSync(looseRef)) {
      const sourceHead = readFileSync(looseRef, "utf8").trim();
      if (/^[0-9a-f]{40}$/u.test(sourceHead)) return { sourceHead, headVerification: "verified" };
    }
    const commonDir = resolveCommonDir(gitDir);
    const commonRef = path.join(commonDir, ref);
    if (existsSync(commonRef)) {
      const sourceHead = readFileSync(commonRef, "utf8").trim();
      if (/^[0-9a-f]{40}$/u.test(sourceHead)) return { sourceHead, headVerification: "verified" };
    }
    const sourceHead = readPackedRef(path.join(commonDir, "packed-refs"), ref);
    return sourceHead
      ? { sourceHead, headVerification: "verified" }
      : { sourceHead: "unverified", headVerification: "unverified" };
  } catch {
    return { sourceHead: "unverified", headVerification: "unverified" };
  }
}

export function canonicalRoot(rootDir) {
  try {
    return realpathSync(rootDir);
  } catch {
    return path.resolve(rootDir);
  }
}

function walkFiles(rootDir, relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  return walkDirectory(rootDir, absoluteRoot);
}

function walkDirectory(rootDir, directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : walkDirectory(rootDir, entryPath);
    return entry.isFile() ? [toSlash(path.relative(rootDir, entryPath))] : [];
  });
}

function resolveGitDir(rootDir, body) {
  const value = /^gitdir:\s*(.+)$/u.exec(body.trim())?.[1];
  if (!value) throw new Error("invalid .git file");
  return path.resolve(rootDir, value);
}

function resolveCommonDir(gitDir) {
  const commonDirPath = path.join(gitDir, "commondir");
  return existsSync(commonDirPath)
    ? path.resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
    : gitDir;
}

function readPackedRef(packedRefsPath, ref) {
  if (!existsSync(packedRefsPath)) return null;
  for (const line of readFileSync(packedRefsPath, "utf8").split(/\r?\n/u)) {
    const match = /^([0-9a-f]{40})\s+(.+)$/u.exec(line);
    if (match?.[2] === ref) return match[1];
  }
  return null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
