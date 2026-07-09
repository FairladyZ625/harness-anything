import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveHarnessLayout,
  sha256Text,
  type HarnessLayoutInput,
  type HarnessLayoutOverrides
} from "../../../kernel/src/index.ts";
import {
  classifyStaticZones,
  classifyTouchedZones,
  forbiddenTouchesForZones,
  frontmatterBlock,
  mediaType,
  type AppliedChangePlan,
  type DirtyEntry,
  type DocSyncConflictV1,
  type DocSyncForbiddenTouchV1,
  type DocSyncSubmitRequestV1,
  type DocSyncSubmitResultV1,
  type DocSyncValidationResult,
  type RegistryRow,
  type TouchedZone
} from "../../../application/src/doc-sync.ts";

interface GitCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface DocSyncServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly commitAuthor?: GitCommitAuthor;
  readonly afterApplyBeforePostCheck?: () => void | Promise<void>;
}

export function makeDocSyncService(options: DocSyncServiceOptions): { readonly submit: (request: DocSyncSubmitRequestV1) => Promise<DocSyncSubmitResultV1> } {
  return {
    submit: async (request) => submitDocSyncRequest(options, request)
  };
}

export function buildDocSyncReport(rootInput: HarnessLayoutInput) {
  const layout = resolveHarnessLayout(rootInput);
  const authoredRoot = path.relative(layout.rootDir, layout.authoredRoot).split(path.sep).join("/") || ".";
  const registry = loadRegistry(layout.rootDir);
  const dirtyFiles = gitDirtyEntries(layout.authoredRoot);
  const files = dirtyFiles.map((entry) => inspectDirtyFile(layout.rootDir, layout.authoredRoot, entry, registry.rows));
  const candidateBlobs = files.filter((entry) => entry.docSyncCandidate && entry.newBlobSha256);
  const forbiddenTouches = files.flatMap((entry) => entry.forbiddenTouches);
  const unresolvedTouches = files.flatMap((entry) => entry.unresolvedTouches);
  const deletions = files.filter((entry) => entry.status === "deleted");
  return {
    schema: "doc-sync-status/v1",
    registry: { path: "tools/write-road-registry.json", sha256: registry.sha256 },
    authoredRoot,
    baseLedgerSha: gitText(layout.authoredRoot, ["rev-parse", "HEAD"]),
    dirtyFiles: files,
    forbiddenTouches,
    unresolvedTouches,
    deletions,
    candidateBlobs,
    readyToSubmitPreview: forbiddenTouches.length === 0 && unresolvedTouches.length === 0 && deletions.length === 0,
    deletionPolicy: "undefined-pending-phase-2",
    writeIntentPreview: {
      schema: "daemon.doc-sync-submit-request/v1-preview",
      submitImplemented: true,
      changes: candidateBlobs.map((entry) => ({
        path: entry.path,
        baseBlobSha256: entry.baseBlobSha256,
        newBlobSha256: entry.newBlobSha256,
        mediaType: entry.mediaType,
        size: entry.size,
        declaredBearing: "task-document",
        declaredZoneClass: "task-authored-prose-or-stage",
        declaredPathClass: entry.pathClass
      }))
    }
  };
}

export function validateDocSyncSubmitRequest(input: { readonly rootInput: HarnessLayoutInput; readonly request: DocSyncSubmitRequestV1 }): DocSyncValidationResult {
  const layout = resolveHarnessLayout(input.rootInput);
  const registry = loadRegistry(layout.rootDir);
  const currentLedgerSha = gitText(layout.authoredRoot, ["rev-parse", "HEAD"]) ?? "no-git-head";
  const conflicts: DocSyncConflictV1[] = [];
  const acceptedChanges: AppliedChangePlan[] = [];
  const forbiddenTouches: DocSyncForbiddenTouchV1[] = [];
  const unresolvedTouches: Array<{ readonly path: string; readonly reason: string; readonly bearing?: string; readonly zoneClass?: string }> = [];

  for (const change of input.request.payload.changes) {
    const target = resolveChangePath(layout.authoredRoot, change.path);
    if (!target.ok) {
      unresolvedTouches.push({ path: change.path, reason: target.reason });
      continue;
    }
    if (change.content.kind !== "inline" || !("body" in change.content) || typeof change.content.body !== "string") {
      unresolvedTouches.push({ path: change.path, reason: "doc sync submit currently requires inline content" });
      continue;
    }
    const body = change.content.body;
    const computedNewSha = sha256Text(body);
    if (computedNewSha !== change.newBlobSha256) {
      conflicts.push(conflict(change.path, "content_hash_mismatch", input.request.payload.baseLedgerSha, currentLedgerSha, change.baseBlobSha256, currentBlobSha(target.path), change.newBlobSha256, "Submitted content does not match newBlobSha256."));
      continue;
    }
    const currentHeadBody = headBlobBody(layout.authoredRoot, change.path);
    const currentSha = currentHeadBody === null ? null : sha256Text(currentHeadBody);
    if (currentSha !== change.baseBlobSha256) {
      conflicts.push(conflict(change.path, "base_blob_changed", input.request.payload.baseLedgerSha, currentLedgerSha, change.baseBlobSha256, currentSha, change.newBlobSha256, "Center file changed since the submitted base; no automatic merge was performed."));
      continue;
    }
    const baseBody = currentHeadBody;
    const zones = classifyTouchedZones(change.path, currentSha === null ? "added" : "modified", baseBody, body, registry.rows);
    const okZones = zones.filter((zone): zone is Extract<TouchedZone, { readonly ok: true }> => zone.ok);
    unresolvedTouches.push(...zones.flatMap((zone) => zone.ok ? [] : [{ path: change.path, reason: zone.reason, bearing: zone.bearing, zoneClass: zone.zoneClass }]));
    forbiddenTouches.push(...forbiddenTouchesForZones(change.path, okZones));
    if (zones.some((zone) => !zone.ok) || okZones.some((zone) => zone.row.channel.pathClass === "rpc-only")) continue;
    acceptedChanges.push({
      path: change.path,
      absolutePath: target.path,
      baseBlobSha256: change.baseBlobSha256,
      newBlobSha256: computedNewSha,
      body,
      zoneClassesTouched: [...new Set(okZones.map((zone) => zone.zoneClass))]
    });
  }

  return {
    ok: conflicts.length === 0 && forbiddenTouches.length === 0 && unresolvedTouches.length === 0,
    acceptedChanges,
    forbiddenTouches,
    unresolvedTouches,
    conflicts,
    currentLedgerSha
  };
}

async function submitDocSyncRequest(options: DocSyncServiceOptions, request: DocSyncSubmitRequestV1): Promise<DocSyncSubmitResultV1> {
  let validation: DocSyncValidationResult;
  try {
    validation = validateDocSyncSubmitRequest({ rootInput: rootInput(options), request });
  } catch (error) {
    return reject(request, "doc_sync_invalid_payload", error instanceof Error ? error.message : String(error), false);
  }
  if (validation.conflicts.length > 0) {
    const first = validation.conflicts[0]!;
    if (first.code === "content_hash_mismatch") {
      return reject(request, "doc_sync_conflict", first.message, false, { conflicts: validation.conflicts });
    }
    return reject(request, "cas_watermark_mismatch", first.message, true, {
      _tag: "WriteRejected",
      currentWatermark: validation.currentLedgerSha,
      expectedWatermark: request.payload.baseLedgerSha,
      conflicts: validation.conflicts
    });
  }
  if (validation.forbiddenTouches.length > 0 || validation.unresolvedTouches.length > 0) {
    return reject(request, "doc_sync_forbidden_touch", "Doc sync submit touched rpc-only or unresolved zones.", false, {
      forbiddenTouches: validation.forbiddenTouches,
      unresolvedTouches: validation.unresolvedTouches
    });
  }

  const layout = resolveHarnessLayout(rootInput(options));
  const beforeFiles = snapshotFiles(layout.authoredRoot);
  const beforeRpcOnly = snapshotRpcOnlyZones(layout.rootDir, layout.authoredRoot);
  try {
    for (const change of validation.acceptedChanges) {
      mkdirSync(path.dirname(change.absolutePath), { recursive: true });
      writeFileSync(change.absolutePath, change.body, "utf8");
    }
    await options.afterApplyBeforePostCheck?.();
    const postApplyViolations = changedRpcOnlyZones(layout.rootDir, layout.authoredRoot, beforeRpcOnly);
    if (postApplyViolations.length > 0) {
      restoreFiles(layout.authoredRoot, beforeFiles);
      return reject(request, "doc_sync_post_apply_bearing_changed", "Post-apply checker detected rpc-only zone changes; restored backups.", false, { postApplyViolations });
    }
    const touchedPaths = validation.acceptedChanges.map((change) => change.absolutePath);
    const appliedLedgerSha = commitDocSyncPaths(layout.authoredRoot, touchedPaths, `doc sync ${request.payload.intentId}`, options.commitAuthor ?? { name: "Harness Daemon", email: "daemon@harness.local" });
    return {
      ok: true,
      schema: "daemon.doc-sync-submit-result/v1",
      status: "accepted",
      intentId: request.payload.intentId,
      baseLedgerSha: request.payload.baseLedgerSha,
      appliedLedgerSha,
      ...(validation.currentLedgerSha !== request.payload.baseLedgerSha ? { rebasedFromLedgerSha: request.payload.baseLedgerSha } : {}),
      appliedChanges: validation.acceptedChanges.map((change) => ({
        path: change.path,
        baseBlobSha256: change.baseBlobSha256,
        newBlobSha256: change.newBlobSha256,
        zoneClassesTouched: change.zoneClassesTouched
      }))
    };
  } catch (error) {
    restoreFiles(layout.authoredRoot, beforeFiles);
    return reject(request, "doc_sync_invalid_payload", error instanceof Error ? error.message : String(error), false);
  }
}

function inspectDirtyFile(rootDir: string, authoredRoot: string, entry: DirtyEntry, rows: ReadonlyArray<RegistryRow>) {
  const absolutePath = path.join(authoredRoot, entry.path);
  const currentBody = existsSync(absolutePath) && entry.status !== "deleted" ? readFileSync(absolutePath, "utf8") : null;
  const baseBody = gitBlobText(authoredRoot, ["show", `HEAD:${entry.path}`]);
  const zones = classifyTouchedZones(entry.path, entry.status, baseBody, currentBody, rows);
  const okZones = zones.filter((zone): zone is Extract<TouchedZone, { readonly ok: true }> => zone.ok);
  const forbiddenTouches = forbiddenTouchesForZones(entry.path, okZones);
  const unresolvedTouches = zones.flatMap((zone) => zone.ok ? [] : [{ path: entry.path, reason: zone.reason, bearing: zone.bearing, zoneClass: zone.zoneClass }]);
  const docSyncCandidate = entry.status !== "deleted"
    && unresolvedTouches.length === 0
    && okZones.length > 0
    && okZones.every((zone) => zone.row.channel.pathClass.startsWith("doc-sync-allowed"));
  return {
    path: entry.path,
    rootPath: path.relative(rootDir, absolutePath).split(path.sep).join("/"),
    status: entry.status,
    baseBlobSha256: baseBody === null ? null : sha256Text(baseBody),
    newBlobSha256: currentBody === null ? null : sha256Text(currentBody),
    size: currentBody === null ? 0 : Buffer.byteLength(currentBody),
    mediaType: mediaType(entry.path),
    pathClass: okZones[0]?.row.channel.pathClass ?? null,
    zoneClassesTouched: [...new Set(okZones.map((zone) => zone.zoneClass))],
    docSyncCandidate,
    forbiddenTouches,
    unresolvedTouches
  };
}

function snapshotRpcOnlyZones(rootDir: string, authoredRoot: string): ReadonlyMap<string, string> {
  const registry = loadRegistry(rootDir);
  const snapshots = new Map<string, string>();
  for (const [relativePath, body] of snapshotFiles(authoredRoot)) {
    const zones = classifyStaticZones(relativePath, registry.rows)
      .filter((zone): zone is Extract<TouchedZone, { readonly ok: true }> => zone.ok)
      .filter((zone) => zone.row.channel.pathClass === "rpc-only");
    if (zones.length === 0) continue;
    snapshots.set(relativePath, rpcOnlySignature(relativePath, body, zones));
  }
  return snapshots;
}

function changedRpcOnlyZones(rootDir: string, authoredRoot: string, before: ReadonlyMap<string, string>): ReadonlyArray<DocSyncForbiddenTouchV1> {
  const after = snapshotRpcOnlyZones(rootDir, authoredRoot);
  const changed: DocSyncForbiddenTouchV1[] = [];
  for (const [filePath, signature] of before) {
    if (after.get(filePath) === signature) continue;
    const registry = loadRegistry(rootDir);
    const zones = classifyStaticZones(filePath, registry.rows)
      .filter((zone): zone is Extract<TouchedZone, { readonly ok: true }> => zone.ok)
      .filter((zone) => zone.row.channel.pathClass === "rpc-only");
    changed.push(...forbiddenTouchesForZones(filePath, zones));
  }
  return changed;
}

function rpcOnlySignature(filePath: string, body: string, zones: ReadonlyArray<Extract<TouchedZone, { readonly ok: true }>>): string {
  const normalized = filePath.split(path.sep).join("/");
  const material = normalized.endsWith("/INDEX.md") ? frontmatterBlock(body) : body;
  return sha256Text(`${zones.map((zone) => `${zone.bearing}/${zone.zoneClass}/${zone.row.id}`).join("|")}\n${material}`);
}

function snapshotFiles(authoredRoot: string): Map<string, string> {
  const files = new Map<string, string>();
  visit(authoredRoot);
  return files;

  function visit(current: string): void {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      const absolute = path.join(current, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        if (entry === ".git") continue;
        visit(absolute);
        continue;
      }
      if (stat.isFile()) files.set(path.relative(authoredRoot, absolute).split(path.sep).join("/"), readFileSync(absolute, "utf8"));
    }
  }
}

function restoreFiles(authoredRoot: string, before: ReadonlyMap<string, string>): void {
  const after = snapshotFiles(authoredRoot);
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relativePath of paths) {
    const absolute = path.join(authoredRoot, relativePath);
    if (!before.has(relativePath)) {
      rmSync(absolute, { force: true });
      continue;
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, before.get(relativePath)!, "utf8");
  }
}

function commitDocSyncPaths(authoredRoot: string, absolutePaths: ReadonlyArray<string>, message: string, author: GitCommitAuthor): string {
  const relativePaths = absolutePaths.map((absolutePath) => path.relative(authoredRoot, absolutePath).split(path.sep).join("/"));
  if (relativePaths.length === 0) return gitText(authoredRoot, ["rev-parse", "HEAD"]) ?? "no-git-head";
  execFileSync("git", ["-C", authoredRoot, "add", "--", ...relativePaths], { stdio: "ignore" });
  const staged = gitText(authoredRoot, ["diff", "--cached", "--name-only", "--", ...relativePaths]) ?? "";
  if (staged.trim().length === 0) return gitText(authoredRoot, ["rev-parse", "HEAD"]) ?? "no-git-head";
  execFileSync("git", ["-C", authoredRoot, "commit", "-m", message], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
    }
  });
  return gitText(authoredRoot, ["rev-parse", "HEAD"]) ?? "no-git-head";
}

function loadRegistry(rootDir: string): { readonly sha256: string; readonly rows: ReadonlyArray<RegistryRow> } {
  const body = readFileSync(registryPath(rootDir), "utf8");
  const parsed = JSON.parse(body) as { readonly schema?: string; readonly rows?: ReadonlyArray<RegistryRow> };
  if (parsed.schema !== "harness-anything/write-road-registry/v1" || !Array.isArray(parsed.rows)) {
    throw new Error("invalid write-road registry");
  }
  return { sha256: sha256Text(body), rows: parsed.rows };
}

function registryPath(rootDir: string): string {
  const candidates = [
    path.join(rootDir, "tools", "write-road-registry.json"),
    path.join(process.cwd(), "tools", "write-road-registry.json"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../tools/write-road-registry.json")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function gitDirtyEntries(authoredRoot: string): ReadonlyArray<DirtyEntry> {
  const output = gitText(authoredRoot, ["status", "--porcelain", "--untracked-files=all", "--", "."]) ?? "";
  return output.split(/\r?\n/u).filter(Boolean).map(parsePorcelainLine);
}

function parsePorcelainLine(line: string): DirtyEntry {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
  const status = code === "??" || code.includes("A")
    ? "added"
    : code.includes("D") ? "deleted" : code.includes("R") ? "renamed" : "modified";
  return { status, path: renamedPath };
}

function headBlobBody(authoredRoot: string, relativePath: string): string | null {
  return gitBlobText(authoredRoot, ["show", `HEAD:${relativePath}`]);
}

function currentBlobSha(absolutePath: string): string | null {
  if (!existsSync(absolutePath)) return null;
  return sha256Text(readFileSync(absolutePath, "utf8"));
}

function conflict(pathInput: string, code: DocSyncConflictV1["code"], baseLedgerSha: string, currentLedgerSha: string, baseBlobSha256: string | null, currentBlobSha256: string | null, submittedNewBlobSha256: string, message: string): DocSyncConflictV1 {
  return {
    path: pathInput,
    code,
    baseLedgerSha,
    currentLedgerSha,
    baseBlobSha256,
    currentBlobSha256,
    submittedNewBlobSha256,
    retryable: true,
    action: code === "content_hash_mismatch" ? "resolve-local-conflict" : "refresh-base-and-resubmit",
    message
  };
}

function reject(request: DocSyncSubmitRequestV1, code: Extract<DocSyncSubmitResultV1, { readonly ok: false }>["code"], reason: string, retryable: boolean, extra: Partial<Extract<DocSyncSubmitResultV1, { readonly ok: false }>> = {}): DocSyncSubmitResultV1 {
  return {
    ok: false,
    schema: "daemon.doc-sync-submit-result/v1",
    status: "rejected",
    intentId: request.payload.intentId,
    code,
    reason,
    retryable,
    ...extra
  };
}

function resolveChangePath(authoredRoot: string, pathInput: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  if (path.isAbsolute(pathInput)) return { ok: false, reason: "doc sync path must be authored-root relative" };
  const normalized = pathInput.split(/[\\/]+/u).filter(Boolean).join("/");
  if (normalized.includes("..")) return { ok: false, reason: "doc sync path traversal is forbidden" };
  const absolute = path.resolve(authoredRoot, normalized);
  const relative = path.relative(authoredRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: "doc sync path is outside authored root" };
  }
  return { ok: true, path: absolute };
}

function gitText(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
  } catch {
    return null;
  }
}

function gitBlobText(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function rootInput(options: DocSyncServiceOptions): HarnessLayoutInput {
  return options.layoutOverrides ? { rootDir: options.rootDir, layoutOverrides: options.layoutOverrides } : options.rootDir;
}
