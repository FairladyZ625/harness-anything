import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-006 */
  execFileSync,
} from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  artifactSubtreePath,
  classifyDocCandidate,
  classifyTextualArtifactPath,
  decideDocWriteCriteria,
  DOC_SYNC_INLINE_MAX_BYTES,
  DOC_POLICY_ID,
  documentPath,
  parseDocWriteIntent,
  RAW_ARTIFACT_MAX_BYTES,
  RAW_ARTIFACT_POLICY_ID,
  resolveDocRoute,
  resolveHarnessLayout,
  resolveLedgerGitLayout,
  resolveTaskBoundRuntimeBinding,
  runtimeSessionIdFromActor,
  isSameExecution,
  isTaskBoundRuntimeWriter,
  localGitWorktreeSettlement,
  sameWriteSource,
  sha256Bytes,
  stableStringify,
  taskIsDescendantOf,
  type ActorIdentity,
  type CanonicalEventStore,
  type DocWriteIntent,
  type LedgerCutIdentity,
  type TaskProjection,
  type WriteSource,
} from "@harness-anything/kernel";
import { blockedCandidateNextAction } from "./doc-sync-details.ts";
import { docSyncError } from "./doc-sync-files.ts";

export type DocCandidateState = "clean" | "eligible" | "inapplicable" | "blocked" | "deletion" | "conflict";
export interface DocCandidateRow {
  readonly path: string;
  readonly state: DocCandidateState;
  readonly reason: string | null;
  readonly baseBlobSha256: string | null;
  readonly candidateBlobSha256: string | null;
  readonly size: number | null;
  readonly mediaType: string | null;
  readonly conflicts: readonly string[];
}
export interface ScannedDocCandidate extends DocCandidateRow {
  readonly bytes: Uint8Array | null;
  readonly rejectionCode: string | null;
  readonly requiredRoute: string | null;
  readonly regionId: string | null;
}
export interface DocCandidateScan {
  readonly baseLedgerSha: LedgerCutIdentity;
  readonly executionId: string | null;
  readonly executionCandidates: readonly string[];
  readonly lease: ReturnType<TaskProjection["currentLeaseForExecution"]>;
  // Tasks owning the scanned paths whose current cut is past submit (submitted or in_review):
  // the package is frozen there, so a lease_conflict recovery must name the before-submit
  // order instead of a lease the submitter can no longer acquire.
  readonly frozenTaskIds: readonly string[];
  readonly rows: readonly ScannedDocCandidate[];
}

export interface AuthoredCandidateInventoryV1 {
  readonly schema: "harness-authored-candidate-inventory/v1";
  readonly baseLedgerSha: LedgerCutIdentity;
  readonly rows: readonly {
    readonly path: string;
    readonly safe: boolean;
    readonly size: number | null;
    readonly bytes: Uint8Array | null;
    readonly conflicts: readonly string[];
  }[];
}

export function scanDocCandidates(input: {
  readonly rootDir: string;
  readonly workspaceId: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly now: string;
  readonly selection?: readonly string[];
  readonly taskId?: string;
  readonly executionId?: string;
  readonly inventory?: AuthoredCandidateInventoryV1;
}): DocCandidateScan {
  const layout = resolveHarnessLayout(input.rootDir),
    ledger = resolveLedgerGitLayout(input.rootDir),
    task = input.taskId === undefined ? null : input.projection.read(input.taskId),
    taskPrefix =
      input.taskId === undefined
        ? null
        : task?.snapshot.task && task.packagePath
          ? `${task.packagePath}/`
          : (() => {
              throw docSyncError("task_not_found", `Task ${input.taskId} has no projected package path.`);
            })(),
    // `--task` scopes enumeration to that one package. Without it the scope is
    // the whole authored tree (empty prefix) — stray `tasks/<seg>/` paths stay
    // enumerated on purpose so scanOne blocks them with an actionable reason
    // instead of the submit silently dropping them.
    enumerationScope = taskPrefix ?? "",
    selected = input.selection?.map((value) => documentPath(normalizeSelectedDocPath(input.rootDir, value))),
    inventoryByPath = new Map(input.inventory?.rows.map((row) => [row.path, row] as const) ?? []),
    conflictsByPath = localDocConflictsByPath(layout),
    candidates = selected?.length
      ? [...new Set(selected)]
      : [
          ...new Set([
            ...dirtyPaths(ledger.rootDir, ledger.authoredPrefix, conflictsByPath.keys(), taskPrefix ?? ""),
            ...(input.inventory?.rows.map((row) => row.path) ?? []),
          ]),
        ].filter((value) => value.startsWith(enumerationScope)),
    paths = candidates.sort(),
    baseLedgerSha = input.inventory?.baseLedgerSha ?? input.store.currentCut(),
    readCandidate = candidateByteReader(input.store, baseLedgerSha, layout.authoredRoot),
    execution = resolveDocExecutionBinding(
      paths,
      input.executionId,
      input.projection,
      input.actor,
      input.source,
      input.now,
      input.taskId,
    ),
    runtimeSessionId = runtimeSessionIdFromActor(input.actor),
    runtimeSession = runtimeSessionId === null ? null : input.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding =
      execution.lease === null
        ? null
        : resolveTaskBoundRuntimeBinding(runtimeSession, execution.lease.taskId, execution.lease.executionId),
    frozenTaskIds = frozenTaskIdsFor(paths),
    rows = paths.map((logical) => scanOne(logical));
  return {
    baseLedgerSha,
    executionId: execution.id,
    executionCandidates: execution.candidates,
    lease: execution.lease,
    frozenTaskIds,
    rows,
  };
  function frozenTaskIdsFor(scanned: readonly string[]): readonly string[] {
    const ids = [...new Set(scanned.flatMap((value) => input.projection.taskIdForDocumentPath(value) ?? []))];
    if (ids.length === 0) return [];
    const statuses = input.projection.readTaskStatuses(ids).rows;
    return ids.filter((id) => {
      const status = statuses.find((row) => row.taskId === id)?.status;
      return status === "submitted" || status === "in_review";
    });
  }
  function scanOne(logical: string): ScannedDocCandidate {
    const inventoried = inventoryByPath.get(logical),
      document = documentPath(logical),
      // The `tasks/<package>/` namespace is admitted by projection, not by path
      // shape: this is the one layer of the scanner that holds the projection,
      // so an unregistered package directory must be refused here. Scoped to
      // the repo-prose channel (no `--task`) — the task-scoped channel keeps
      // its own prefix filter and lease adjudication verbatim. The kernel path
      // functions stay shape-based on purpose — `ha doc retire` relies on them
      // to reach already-committed ghost documents for retirement.
      taskDirectory = /^tasks\/([^/]+)\//u.exec(document)?.[1] ?? null,
      claimingTaskId = taskDirectory === null ? null : input.projection.taskIdForDocumentPath(document),
      route = resolveDocRoute(document),
      target = path.join(layout.authoredRoot, ...logical.split("/")),
      projected = input.projection.readDocument(document),
      conflicts = inventoried?.conflicts ?? conflictsByPath.get(logical) ?? [],
      safe = inventoried?.safe ?? directFile(layout.authoredRoot, logical),
      fileSize = inventoried ? inventoried.size : safe && existsSync(target) ? lstatSync(target).size : null,
      // Artifacts-subtree content rides the <=50,000,000 byte blob content contract
      // (dec_776B4D61DF711D9F31126D375D CH4), not the inline prose channel: the scanner reads it
      // whole so a system-published dispatch report or binary image past the inline cap still scans,
      // compares, and submits like any other candidate instead of wedging completion. Prose keeps the
      // descriptor-frame cap the doc-sync channel is sized for.
      readCap = artifactSubtreePath(logical) ? RAW_ARTIFACT_MAX_BYTES : DOC_SYNC_INLINE_MAX_BYTES,
      rawBytes = inventoried
        ? inventoried.bytes
        : fileSize !== null && fileSize <= readCap && safe && existsSync(target)
          ? readCandidate(target)
          : null,
      classified = classifyDocCandidate(logical, rawBytes),
      // A path that already holds a text document keeps that policy: undecodable bytes there are a
      // rejected edit (decideDocWrite answers with the typed-binary route), not a new artifact at the
      // same name. Updating an existing raw artifact stays a raw candidate.
      effective =
        classified?.kind === "raw-artifact" &&
        projected.document !== null &&
        projected.document.policyId !== RAW_ARTIFACT_POLICY_ID
          ? classifyTextualArtifactPath(logical)
          : classified,
      bytes = rawBytes === null ? null : canonicalProseBytes(rawBytes, effective?.policyId),
      base = projected.document?.blobSha256 ?? null,
      candidate = bytes === null ? null : sha256Bytes(bytes);
    if (!route.allowed) {
      if (safe && candidate !== null && candidate === base)
        return scannedCandidateRow("clean", null, bytes, base, candidate, effective?.mediaType ?? null);
      // A route-owned document is a pure projection of its owning event route: local bytes are
      // never an input to this channel (the Git-less edge already drops them), so drift is
      // repaired by rebuilding the worktree copy from the canonical projection instead of
      // blocking every doc command until a human restores the file by hand. harness.yaml is the
      // exception: it is the authored settings declaration surface — settings-update parses its
      // worktree bytes (--gates-from-document) and absorbs equal-value drift — so this channel
      // keeps reporting that drift to the workspace-config route instead of discarding it.
      if (
        safe &&
        route.requiredRoute !== "workspace-config" &&
        projected.document !== null &&
        projected.watermark === projected.sourceRevision
      ) {
        const rebuilt = Buffer.from(projected.document.body, "utf8");
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, rebuilt);
        return scannedCandidateRow(
          "clean",
          `rebuilt from the canonical document; local edits are not a write path (route ${route.requiredRoute})`,
          rebuilt,
          base,
          base,
          effective?.mediaType ?? null,
        );
      }
      return scannedCandidateRow(
        "blocked",
        safe ? `path is owned by ${route.requiredRoute}` : "path contains a symbolic link or is not a regular file",
        bytes,
        base,
        candidate,
        null,
        null,
        route.requiredRoute,
      );
    }
    if (input.taskId === undefined && taskDirectory !== null && claimingTaskId === null)
      return scannedCandidateRow(
        "blocked",
        `tasks/${taskDirectory} is not the package path of any projected task; move the file into its owning ` +
          "task's artifacts/ subtree and submit it there — no command publishes a package the projection does not own",
        bytes,
        base,
        candidate,
        effective?.mediaType ?? null,
        "task_package_unregistered",
        "doc-sync",
      );
    if (effective === null && candidate !== null && candidate === base)
      return scannedCandidateRow("clean", null, bytes, base, candidate, null);
    // A non-textual type with no canonical document at the path is not doc-sync
    // business at all — inapplicable, not blocked: blocked stays the "a human must
    // resolve this" signal. A canonical document that IS projected here keeps
    // blocked, because diverging from it is a real resolution.
    if (effective === null)
      return projected.document === null
        ? scannedCandidateRow(
            "inapplicable",
            "path is not a supported textual document",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            fileSize,
          )
        : scannedCandidateRow(
            "blocked",
            "path is not a supported textual document",
            null,
            projected.document.blobSha256,
            null,
            null,
            null,
            null,
            null,
            fileSize,
          );
    if (projected.watermark !== projected.sourceRevision)
      return scannedCandidateRow(
        "blocked",
        "canonical projection is pending",
        null,
        projected.document?.blobSha256 ?? null,
        null,
      );
    if (!safe)
      return scannedCandidateRow(
        "blocked",
        "path contains a symbolic link or is not a regular file",
        null,
        projected.document?.blobSha256 ?? null,
        null,
      );
    if (fileSize !== null && fileSize > readCap)
      return scannedCandidateRow(
        "blocked",
        artifactSubtreePath(logical)
          ? `${logical} is ${fileSize} bytes; task artifacts accept at most ${RAW_ARTIFACT_MAX_BYTES} bytes ` +
              "through the content object contract"
          : `${logical} is ${fileSize} bytes; doc sync accepts at most ${DOC_SYNC_INLINE_MAX_BYTES} bytes of ` +
              "inline prose; split the document or move the bulk under a task package's artifacts/ subtree",
        null,
        projected.document?.blobSha256 ?? null,
        null,
        effective.mediaType,
        "doc_candidate_too_large",
        artifactSubtreePath(logical) ? "blob-content" : null,
        null,
        fileSize,
      );
    if (bytes === null)
      return scannedCandidateRow(
        projected.document ? "deletion" : "clean",
        projected.document ? "canonical document is missing from the worktree" : null,
        null,
        base,
        null,
        null,
        projected.document ? "deletion_forbidden" : null,
        projected.document ? "deletion_forbidden" : null,
      );
    const { mediaType, policyId } = effective;
    if (candidate === base)
      return scannedCandidateRow(
        conflicts.length ? "conflict" : "clean",
        conflicts.length ? "local conflict scratch requires resolution" : null,
        bytes,
        base,
        candidate,
        mediaType,
      );
    const intent = parseDocWriteIntent(
        {
          schema: "doc-write-intent/v1",
          executionId: execution.id,
          baseLedgerSha,
          changes: [
            {
              path: logical,
              baseBlobSha256: base,
              policyId,
              candidate: {
                ref: `doc-sync-claims/${candidate}`,
                sha256: candidate,
                size: bytes.byteLength,
                mediaType,
              },
            },
          ],
        },
        input.workspaceId,
      ),
      decision = decideDocWriteCriteria({
        intent,
        opId: "scan",
        eventId: "scan",
        workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
        actor: input.actor,
        source: input.source,
        occurredAt: input.now,
        currentLedgerSha: baseLedgerSha,
        lease: execution.lease,
        authorizationDecision: null,
        documents: [projected.document],
        claims: [bytes],
        resolvedTaskIds: [input.projection.taskIdForDocumentPath(logical)],
        ...(runtimeBinding ? { runtimeBinding } : {}),
        ...(execution.runtimeDelegatedTaskId ? { runtimeDelegatedTaskId: execution.runtimeDelegatedTaskId } : {}),
      });
    if (decision.accepted) return scannedCandidateRow("eligible", null, bytes, base, candidate, mediaType);
    const unresolved = decision.detail.unresolvedTouches;
    return scannedCandidateRow(
      decision.code === "deletion_forbidden" ? "deletion" : "blocked",
      unresolved[0]?.reason ?? decision.code,
      bytes,
      base,
      candidate,
      mediaType,
      decision.code,
      unresolved[0]?.requiredRoute ?? null,
      unresolved[0]?.regionId ?? null,
    );
    function scannedCandidateRow(
      state: DocCandidateState,
      reason: string | null,
      body: Uint8Array | null,
      baseHash: string | null,
      candidateHash: string | null,
      media: DocCandidateRow["mediaType"] = null,
      rejectionCode: string | null = null,
      requiredRoute: string | null = null,
      regionId: string | null = null,
      reportedSize: number | null = null,
    ): ScannedDocCandidate {
      return {
        path: logical,
        state,
        reason,
        baseBlobSha256: baseHash,
        candidateBlobSha256: candidateHash,
        size: reportedSize ?? body?.byteLength ?? null,
        mediaType: media,
        conflicts,
        bytes: body,
        rejectionCode,
        requiredRoute,
        regionId,
      };
    }
  }
}

export function validateSelectedDocPaths(selected: readonly string[], scan: DocCandidateScan): void {
  if (selected.length === 0) return;
  const missing = scan.rows
    .filter((row) => row.state === "clean" && row.baseBlobSha256 === null && row.candidateBlobSha256 === null)
    .map((row) => ({
      ...row,
      reason: "selected doc-sync path does not match an authored candidate",
    }));
  if (missing[0]) throw docSyncError("document_not_found", blockedCandidateNextAction(missing[0]));
}

// The single spelling rule for doc-selection paths, shared by doc status/sync selections and
// ha doc retire: both the ledger Git prefix and the product-visible authored-root prefix are
// accepted — the authored root is its own Git repository in the nested layout, so the ledger
// prefix is empty there while users still spell selection paths relative to the product root.
export function normalizeSelectedDocPath(rootDir: string, value: string): string {
  const layout = resolveHarnessLayout(rootDir);
  return normalizeSelectedPath(
    resolveLedgerGitLayout(rootDir).authoredPrefix,
    relative(rootDir, layout.authoredRoot),
    value,
  );
}

function normalizeSelectedPath(authoredPrefix: string, sourcePrefix: string, value: string): string {
  for (const prefix of [authoredPrefix, sourcePrefix])
    if (prefix && value.startsWith(`${prefix}/`)) return value.slice(prefix.length + 1);
  return value;
}

export function intentFromScan(
  scan: DocCandidateScan,
  workspaceId: string,
): { readonly intent: DocWriteIntent; readonly claims: readonly Uint8Array[] } {
  const eligible = scan.rows.filter((row) => row.state === "eligible");
  return {
    intent: parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: scan.executionId,
        baseLedgerSha: scan.baseLedgerSha,
        changes: eligible.map((row) => {
          const classification = classifyDocCandidate(row.path, row.bytes);
          if (classification === null || row.candidateBlobSha256 === null || row.size === null)
            throw new Error(`eligible scan row is not a supported artifact: ${row.path}`);
          return {
            path: row.path,
            baseBlobSha256: row.baseBlobSha256,
            policyId: classification.policyId,
            candidate: {
              ref: `doc-sync-claims/${row.candidateBlobSha256}`,
              sha256: row.candidateBlobSha256,
              size: row.size,
              mediaType: classification.mediaType,
            },
          };
        }),
      },
      workspaceId,
    ),
    claims: eligible.map((row) => row.bytes!),
  };
}
export function publicScan(scan: DocCandidateScan): {
  readonly baseLedgerSha: LedgerCutIdentity;
  readonly rows: readonly DocCandidateRow[];
} {
  return {
    baseLedgerSha: scan.baseLedgerSha,
    rows: scan.rows.map(
      ({ bytes: _bytes, rejectionCode: _rejectionCode, requiredRoute: _requiredRoute, regionId: _regionId, ...row }) =>
        row,
    ),
  };
}

export function resolveDocExecutionBinding(
  paths: readonly string[],
  explicit: string | undefined,
  projection: TaskProjection,
  actor: ActorIdentity,
  source: WriteSource,
  now: string,
  taskId: string | undefined,
) {
  if (explicit)
    return {
      id: explicit,
      candidates: [],
      lease: projection.currentLeaseForExecution(explicit, now),
      runtimeDelegatedTaskId: null,
    };
  const tasks = new Set(paths.flatMap((value) => projection.taskIdForDocumentPath(value) ?? [])),
    runtimeSessionId = runtimeSessionIdFromActor(actor);
  if (runtimeSessionId !== null) {
    const session = projection.readRuntimeSession(runtimeSessionId),
      exactMatches =
        session?.taskBindings.flatMap((binding) => {
          if (!tasks.has(binding.taskId)) return [];
          const lease = projection.currentLease(binding.taskId, now),
            runtimeBinding =
              lease === null ? null : resolveTaskBoundRuntimeBinding(session, binding.taskId, lease.executionId);
          if (lease === null || runtimeBinding === null) return [];
          return isTaskBoundRuntimeWriter(lease, actor, source, runtimeBinding)
            ? [{ id: lease.executionId, lease }]
            : [];
        }) ?? [],
      descendantMatches =
        exactMatches.length > 0 || taskId === undefined || !tasks.has(taskId)
          ? []
          : (session?.taskBindings.flatMap((binding) => {
              if (
                !taskIsDescendantOf(
                  taskId,
                  binding.taskId,
                  (current) => projection.read(current).snapshot.task?.metadata?.parentTaskId ?? null,
                )
              )
                return [];
              const lease = projection.currentLease(binding.taskId, now),
                runtimeBinding =
                  lease === null ? null : resolveTaskBoundRuntimeBinding(session, binding.taskId, lease.executionId);
              if (lease === null || runtimeBinding === null) return [];
              return isTaskBoundRuntimeWriter(lease, actor, source, runtimeBinding)
                ? [{ id: lease.executionId, lease }]
                : [];
            }) ?? []),
      matches = exactMatches.length > 0 ? exactMatches : descendantMatches,
      unique = [...new Map(matches.map((match) => [match.id, match])).values()];
    return unique.length === 1
      ? {
          id: unique[0]!.id,
          candidates: [],
          lease: unique[0]!.lease,
          runtimeDelegatedTaskId: exactMatches.length === 0 ? (taskId ?? null) : null,
        }
      : {
          id: null,
          candidates: unique.map((match) => match.id).sort(),
          lease: null,
          runtimeDelegatedTaskId: null,
        };
  }
  // Channel selection must authorize the caller, not just observe the scanned
  // path set: pinning a non-holder to a task lease they cannot hold turns a
  // legal repository-prose submit into lease_conflict (and makes `--path`
  // behave differently from an implicit submit purely by set size). The lease
  // channel is only chosen when the caller is its holder on this channel —
  // the same authority decideDocWrite would demand — so a held lease owned by
  // another executor falls back to the lease-free prose channel instead of
  // being rejected.
  const taskIds = [...tasks],
    current = taskIds.length === 1 ? projection.currentLease(taskIds[0]!, now) : null,
    lease =
      current?.phase === "held" && isSameExecution(current.actor, actor) && sameWriteSource(current.source, source)
        ? current
        : null;
  return { id: lease?.executionId ?? null, candidates: [], lease, runtimeDelegatedTaskId: null };
}

function dirtyPaths(
  repoRoot: string,
  authoredPrefix: string,
  conflictPaths: Iterable<string>,
  logicalScope = "",
): string[] {
  const scopePath = [authoredPrefix, logicalScope.replace(/\/$/u, "")].filter(Boolean).join("/"),
    scope = scopePath || ".",
    changed = gitStatusNames(repoRoot, scope),
    prefix = authoredPrefix ? `${authoredPrefix}/` : "";
  return [
    ...new Set(
      changed
        .filter(
          (value) =>
            (!prefix || value.startsWith(prefix)) &&
            !value.includes(".conflict-") &&
            !/\/\.ha-(?:visible|settle)-/u.test(`/${value}`),
        )
        .map((value) => value.slice(prefix.length))
        .concat(
          [...conflictPaths].filter(
            (logical) => !logicalScope || logical.startsWith(`${logicalScope.replace(/\/$/u, "")}/`),
          ),
        ),
    ),
  ];
}

function gitStatusNames(repoRoot: string, scope: string): string[] {
  // A plain status opportunistically writes the refreshed index, so a scan overlapping the
  // settlement worker's update-index would overwrite the freshly settled index with the older
  // snapshot it read and keep doc status BLOCKED until the next ledger write (F-B9DAA193).
  const entries = gitNames(repoRoot, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      scope,
    ]),
    paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // In porcelain -z format, renamed and copied entries are followed by the
    // original pathname. The scanner needs the destination candidate only.
    if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") index++;
  }
  return paths;
}
function localDocConflictsByPath(
  layout: ReturnType<typeof resolveHarnessLayout>,
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const record of localGitWorktreeSettlement.docSyncConflicts(layout)) {
    const current = grouped.get(record.logicalPath) ?? [];
    current.push(record.localPath);
    grouped.set(record.logicalPath, current);
  }
  return grouped;
}
function gitNames(repoRoot: string, args: readonly string[]): string[] {
  return (
    /* @gate-identity check-sync-subprocess/sync-subprocess-007 */
    execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", windowsHide: true })
      .split("\0")
      .filter(Boolean)
  );
}
function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}
function directFile(authoredRoot: string, logical: string): boolean {
  let target = authoredRoot;
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false;
  for (const segment of logical.split("/")) {
    target = path.join(target, segment);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false;
  }
  return !existsSync(target) || lstatSync(target).isFile();
}
function canonicalProseBytes(bytes: Uint8Array, policyId: string | undefined): Uint8Array {
  if (policyId !== DOC_POLICY_ID || !bytes.includes(13)) return bytes;
  try {
    return Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/gu, "\n"));
  } catch {
    return bytes;
  }
}

// Only the previous scan's file inputs survive. Canonical document state and
// ownership still come from the center projection; conflicts and file metadata
// are observed on every scan, including when the ledger has not advanced.
const candidateBytes = new WeakMap<
  CanonicalEventStore,
  {
    readonly key: string;
    readonly files: Map<string, { readonly identity: string; readonly bytes: Uint8Array }>;
  }
>();

function candidateByteReader(store: CanonicalEventStore, cut: LedgerCutIdentity, authoredRoot: string) {
  const key = stableStringify({ authoredRoot, cut, generation: store.ledgerMetadata().generation }),
    previous = candidateBytes.get(store),
    files = new Map<string, { readonly identity: string; readonly bytes: Uint8Array }>();
  candidateBytes.set(store, { key, files });
  return (target: string): Uint8Array => {
    const stat = lstatSync(target, { bigint: true }),
      identity = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"),
      cached = previous?.key === key ? previous.files.get(target) : undefined,
      bytes = cached?.identity === identity ? cached.bytes : readFileSync(target);
    files.set(target, { identity, bytes });
    return bytes;
  };
}
