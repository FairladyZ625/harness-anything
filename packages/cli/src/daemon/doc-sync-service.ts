import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  resolveHarnessLayout,
  sha256Text,
  type EntityId,
  type HarnessLayoutInput,
  type HarnessLayoutOverrides,
  type WriteCoordinator
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

export interface DocSyncServiceOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly coordinator?: WriteCoordinator;
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
  // No registry ⇒ doc-sync enforcement is inactive for this repo (a consumer install):
  // skip the authored-tree scan so we don't manufacture "resolution failed" unresolved
  // touches for every dirty file, and so the warning layer stays silent. See issue #644.
  const dirtyFiles = registry.present ? gitDirtyEntries(layout.authoredRoot) : [];
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

export function buildDocSyncSubmitRequest(
  rootInput: HarnessLayoutInput,
  repoId: string,
  selectedPaths: ReadonlyArray<string> = [],
  executor?: { readonly kind: "agent"; readonly id: string } | null
): DocSyncSubmitRequestV1 {
  const report = buildDocSyncReport(rootInput);
  const selected = new Set(selectedPaths);
  const files = selected.size > 0
    ? report.dirtyFiles.filter((entry) => selected.has(entry.path))
    : report.dirtyFiles;
  const missingSelections = [...selected].filter((selectedPath) => !files.some((entry) => entry.path === selectedPath));
  if (missingSelections.length > 0) {
    throw new Error(`Doc sync selected path is not dirty or is unknown: ${missingSelections.join(", ")}. Run 'ha doc status'.`);
  }
  const filePaths = new Set(files.map((entry) => entry.path));
  const forbiddenTouches = report.forbiddenTouches.filter((entry) => filePaths.has(entry.path));
  const unresolvedTouches = report.unresolvedTouches.filter((entry) => filePaths.has(entry.path));
  const deletions = report.deletions.filter((entry) => filePaths.has(entry.path));
  if (forbiddenTouches.length > 0 || unresolvedTouches.length > 0 || deletions.length > 0) {
    throw new Error(
      `Doc sync preview is not ready: ${forbiddenTouches.length} forbidden touch(es), ` +
      `${unresolvedTouches.length} unresolved touch(es), ${deletions.length} deletion(s). Run 'ha doc status'.`
    );
  }
  if (!report.baseLedgerSha) throw new Error("Doc sync submit requires an initialized authored Git repository.");
  const layout = resolveHarnessLayout(rootInput);
  const changes = report.candidateBlobs.filter((entry) => filePaths.has(entry.path)).map((entry) => {
    const body = readFileSync(path.join(layout.authoredRoot, entry.path), "utf8");
    return {
      path: entry.path,
      baseBlobSha256: entry.baseBlobSha256,
      newBlobSha256: entry.newBlobSha256!,
      mediaType: entry.mediaType,
      size: entry.size,
      declaredBearing: "task-document",
      declaredZoneClass: "task-authored-prose-or-stage",
      declaredPathClass: entry.pathClass ?? undefined,
      content: { kind: "inline" as const, body }
    };
  });
  const intentMaterial = JSON.stringify({
    baseLedgerSha: report.baseLedgerSha,
    changes: changes.map(({ path: changePath, baseBlobSha256, newBlobSha256 }) => ({ path: changePath, baseBlobSha256, newBlobSha256 }))
  });
  return {
    repo: { repoId },
    ...(executor !== undefined ? { executor } : {}),
    payload: {
      baseLedgerSha: report.baseLedgerSha,
      intentId: `intent_${sha256Text(intentMaterial).slice(0, 24)}`,
      declaredIntent: "prose-edit",
      changes
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
  let coordinatorStarted = false;
  try {
    await options.afterApplyBeforePostCheck?.();
    const postApplyViolations = changedRpcOnlyZones(layout.rootDir, layout.authoredRoot, beforeRpcOnly);
    if (postApplyViolations.length > 0) {
      restoreFiles(layout.authoredRoot, beforeFiles);
      return reject(request, "doc_sync_post_apply_bearing_changed", "Post-apply checker detected rpc-only zone changes; restored backups.", false, { postApplyViolations });
    }
    if (options.afterApplyBeforePostCheck) restoreFiles(layout.authoredRoot, beforeFiles);
    if (validation.acceptedChanges.length > 0 && !options.coordinator) {
      return reject(request, "doc_sync_invalid_payload", "Doc sync submit requires a trusted authenticated person principal.", false, {
        _tag: "WriteRejected"
      });
    }
    if (validation.acceptedChanges.length > 0) {
      coordinatorStarted = true;
      await Effect.runPromise(options.coordinator!.enqueue({
        opId: request.payload.intentId,
        entityId: docSyncEntityId(request.payload.intentId),
        kind: "doc_sync_submit",
        payload: {
          baseLedgerSha: request.payload.baseLedgerSha,
          writes: validation.acceptedChanges.map((change) => ({
            path: change.path,
            body: change.body,
            baseBlobSha256: change.baseBlobSha256
          }))
        }
      }));
      await Effect.runPromise(options.coordinator!.flush("explicit"));
    }
    const appliedLedgerSha = gitText(layout.authoredRoot, ["rev-parse", "HEAD"]) ?? "no-git-head";
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
    if (!coordinatorStarted) restoreFiles(layout.authoredRoot, beforeFiles);
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
  if (!existsSync(authoredRoot)) return files;
  const frames: Array<{ readonly current: string; readonly entries: ReadonlyArray<string>; index: number }> = [{
    current: authoredRoot,
    entries: readdirSync(authoredRoot),
    index: 0
  }];
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    const entry = frame.entries[frame.index];
    if (entry === undefined) {
      frames.pop();
      continue;
    }
    frame.index += 1;
    const absolute = path.join(frame.current, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (entry === ".git") continue;
      frames.push({ current: absolute, entries: readdirSync(absolute), index: 0 });
      continue;
    }
    if (stat.isFile()) files.set(path.relative(authoredRoot, absolute).split(path.sep).join("/"), readFileSync(absolute, "utf8"));
  }
  return files;
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

function docSyncEntityId(intentId: string): EntityId {
  return `entity/doc-sync/${sha256Text(intentId).slice(0, 32)}`;
}

function loadRegistry(rootDir: string): { readonly present: boolean; readonly sha256: string; readonly rows: ReadonlyArray<RegistryRow> } {
  const absolutePath = registryPath(rootDir);
  // The write-road registry is a dogfood-internal file that is not shipped in the
  // published package and does not exist in consumer repos. A missing registry means
  // the doc-sync layer has no rules to enforce — treat it as absent (inert) rather than
  // crashing the whole decision write path. See issue #644 (same dogfood-assumption
  // class as #269's hardcoded trunk).
  if (!existsSync(absolutePath)) {
    return { present: false, sha256: sha256Text(""), rows: [] };
  }
  const body = readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(body) as { readonly schema?: string; readonly rows?: ReadonlyArray<RegistryRow> };
  if (parsed.schema !== "harness-anything/write-road-registry/v1" || !Array.isArray(parsed.rows)) {
    throw new Error("invalid write-road registry");
  }
  return { present: true, sha256: sha256Text(body), rows: parsed.rows };
}

function registryPath(rootDir: string): string {
  return path.join(rootDir, "tools", "write-road-registry.json");
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
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trimEnd();
  } catch {
    return null;
  }
}

function gitBlobText(cwd: string, args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch {
    return null;
  }
}

function rootInput(options: DocSyncServiceOptions): HarnessLayoutInput {
  return options.layoutOverrides ? { rootDir: options.rootDir, layoutOverrides: options.layoutOverrides } : options.rootDir;
}
