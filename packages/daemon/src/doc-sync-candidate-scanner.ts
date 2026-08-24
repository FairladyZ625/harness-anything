import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-006 */
  execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalDocumentClaims,
  classifyTextualArtifactPath,
  decideDocWrite,
  DOC_POLICY_ID,
  documentPath,
  isSameExecution,
  isTaskBoundRuntimeWriter,
  parseDocWriteIntent,
  resolveDocRoute,
  resolveHarnessLayout,
  resolveLedgerGitLayout,
  resolveLiveTaskBoundRuntimeBinding,
  resolveRetirableDocument,
  runtimeSessionIdFromActor,
  sha256Bytes,
  stableStringify,
  type ActorIdentity,
  type CanonicalEventStore,
  type DocWriteIntent,
  type LedgerCutIdentity,
  type TaskProjection,
  type WriteSource,
} from "../../kernel/src/index.ts";
import { docSyncError } from "./doc-sync-files.ts";

export type DocCandidateState = "clean" | "eligible" | "inapplicable" | "blocked" | "deletion" | "conflict";
type TextualArtifactMediaType = NonNullable<ReturnType<typeof classifyTextualArtifactPath>>["mediaType"];
export interface DocCandidateRow {
  readonly path: string;
  readonly state: DocCandidateState;
  readonly reason: string | null;
  readonly baseBlobSha256: string | null;
  readonly candidateBlobSha256: string | null;
  readonly size: number | null;
  readonly mediaType: TextualArtifactMediaType | null;
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
  readonly rows: readonly ScannedDocCandidate[];
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
    selected = input.selection?.map((value) => documentPath(value)),
    events = input.store.read().events,
    pendingPaths = events
      .filter((event) => input.store.publication(event).commitSha === null)
      .flatMap((event) => canonicalDocumentClaims(event).map((claim) => claim.path)),
    candidates = selected?.length
      ? [...new Set(selected)]
      : [...new Set([...dirtyPaths(ledger.rootDir, ledger.authoredPrefix), ...pendingPaths])]
          .filter((value) => taskPrefix === null || value.startsWith(taskPrefix)),
    paths = candidates
      .filter(
        (value) =>
          selected?.length ||
          classifyTextualArtifactPath(value) !== null ||
          !resolveDocRoute(documentPath(value)).allowed,
      )
      .sort(),
    baseLedgerSha = input.store.currentCut(),
    execution = executionBinding(paths, input.executionId, input.projection, input.actor, input.source, input.now),
    runtimeSessionId = runtimeSessionIdFromActor(input.actor),
    runtimeSession = runtimeSessionId === null ? null : input.projection.readRuntimeSession(runtimeSessionId),
    runtimeBinding =
      execution.lease === null
        ? null
        : resolveLiveTaskBoundRuntimeBinding(runtimeSession, execution.lease.taskId, execution.lease.executionId),
    rows = paths.map((logical) => scanOne(logical));
  return {
    baseLedgerSha,
    executionId: execution.id,
    executionCandidates: execution.candidates,
    lease: execution.lease,
    rows,
  };
  function scanOne(logical: string): ScannedDocCandidate {
    const document = documentPath(logical),
      route = resolveDocRoute(document),
      target = path.join(layout.authoredRoot, ...logical.split("/")),
      projected = input.projection.readDocument(document),
      conflicts = conflictsFor(logical),
      safe = directFile(layout.authoredRoot, logical),
      classification = classifyTextualArtifactPath(logical),
      rawBytes = safe && existsSync(target) ? readFileSync(target) : null,
      bytes = rawBytes === null ? null : canonicalProseBytes(rawBytes, classification?.policyId),
      retirementBase =
        bytes === null
          ? resolveRetirableDocument(input.rootDir, document, projected.document, events)
          : projected.document,
      base = retirementBase?.blobSha256 ?? null,
      candidate = bytes === null ? null : sha256Bytes(bytes);
    if (!route.allowed) {
      if (route.requiredRoute === "people-registry" && safe && candidate !== null && base === null)
        return scannedCandidateRow(
          "inapplicable",
          "path is owned by people-registry and is outside doc sync",
          bytes,
          base,
          candidate,
          null,
          null,
          route.requiredRoute,
        );
      return safe && candidate !== null && candidate === base
        ? scannedCandidateRow("clean", null, bytes, base, candidate, classification?.mediaType ?? null)
        : scannedCandidateRow(
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
    if (classification === null)
      return scannedCandidateRow(
        "blocked",
        "path is not a supported textual document",
        null,
        projected.document?.blobSha256 ?? null,
        null,
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
    if (bytes === null)
      return scannedCandidateRow(
        retirementBase ? "deletion" : "clean",
        retirementBase ? "canonical document is missing from the worktree" : null,
        null,
        base,
        null,
        null,
        retirementBase ? "deletion_forbidden" : null,
      );
    const { mediaType, policyId } = classification;
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
              candidate: { ref: `doc-sync-claims/${candidate}`, sha256: candidate, size: bytes.byteLength, mediaType },
            },
          ],
        },
        input.workspaceId,
      ),
      decision = decideDocWrite({
        intent,
        opId: "scan",
        eventId: "scan",
        workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
        actor: input.actor,
        source: input.source,
        occurredAt: input.now,
        currentLedgerSha: baseLedgerSha,
        lease: execution.lease,
        documents: [projected.document],
        claims: [bytes],
        resolvedTaskIds: [input.projection.taskIdForDocumentPath(logical)],
        ...(runtimeBinding ? { runtimeBinding } : {}),
      });
    if (decision.accepted) return scannedCandidateRow("eligible", null, bytes, base, candidate, mediaType);
    const unresolved = decision.detail.unresolvedTouches,
      nonTextualArtifact =
        base === null &&
        classification.kind === "opaque-textual" &&
        decision.code === "unresolved_touch" &&
        unresolved.length === 1 &&
        unresolved[0]?.requiredRoute === "typed-binary-content";
    if (nonTextualArtifact)
      return scannedCandidateRow(
        "inapplicable",
        "non-textual artifact is outside doc sync",
        bytes,
        base,
        candidate,
        mediaType,
      );
    return scannedCandidateRow(
      decision.code === "deletion_forbidden" ? "deletion" : "blocked",
      unresolved[0]?.reason ?? decision.detail.nextAction,
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
    ): ScannedDocCandidate {
      return {
        path: logical,
        state,
        reason,
        baseBlobSha256: baseHash,
        candidateBlobSha256: candidateHash,
        size: body?.byteLength ?? null,
        mediaType: media,
        conflicts,
        bytes: body,
        rejectionCode,
        requiredRoute,
        regionId,
      };
    }
  }
  function conflictsFor(logical: string): string[] {
    const target = path.join(layout.authoredRoot, ...logical.split("/")),
      extension = path.extname(target),
      stem = path.basename(target, extension),
      directory = path.dirname(target);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(`${stem}.conflict-`) &&
          name.endsWith(extension) &&
          /^[0-9a-f]{8}$/u.test(name.slice(`${stem}.conflict-`.length, -extension.length)),
      )
      .map((name) => relative(input.rootDir, path.join(directory, name)))
      .sort();
  }
}

export function validateSelectedDocPaths(
  rootDir: string,
  selected: readonly string[],
  scan: DocCandidateScan,
): void {
  if (selected.length === 0) return;
  const authoredPrefix = resolveLedgerGitLayout(rootDir).authoredPrefix,
    prefixed = authoredPrefix
      ? selected.filter((value) => value === authoredPrefix || value.startsWith(`${authoredPrefix}/`))
      : [];
  if (prefixed.length > 0) {
    const rewritten = prefixed.map((value) => value.slice(`${authoredPrefix}/`.length));
    throw docSyncError(
      "invalid_command",
      [
        `doc --path requires authored-root-relative paths; drop the '${authoredPrefix}/' prefix and retry with `,
        `${rewritten.map((value) => `'${value}'`).join(", ")}`,
      ].join(""),
    );
  }
  const missing = scan.rows
    .filter(
      (row) => row.state === "clean" && row.baseBlobSha256 === null && row.candidateBlobSha256 === null,
    )
    .map((row) => row.path);
  if (missing.length > 0)
    throw docSyncError(
      "document_not_found",
      `selected doc-sync path does not match an authored candidate: ${missing.join(", ")}; run ha doc status`,
    );
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
          const classification = classifyTextualArtifactPath(row.path);
          if (classification === null || row.candidateBlobSha256 === null || row.size === null)
            throw new Error(`eligible scan row is not a textual artifact: ${row.path}`);
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

function executionBinding(
  paths: readonly string[],
  explicit: string | undefined,
  projection: TaskProjection,
  actor: ActorIdentity,
  source: WriteSource,
  now: string,
) {
  if (explicit) return { id: explicit, candidates: [], lease: projection.currentLeaseForExecution(explicit, now) };
  const tasks = new Set(paths.flatMap((value) => projection.taskIdForDocumentPath(value) ?? [])),
    runtimeSessionId = runtimeSessionIdFromActor(actor);
  if (runtimeSessionId !== null) {
    const session = projection.readRuntimeSession(runtimeSessionId),
      matches =
        session?.taskBindings.flatMap((binding) => {
          if (!tasks.has(binding.taskId)) return [];
          const lease = projection.currentLeaseForExecution(binding.executionId, now),
            live = resolveLiveTaskBoundRuntimeBinding(session, binding.taskId, binding.executionId);
          return lease?.phase === "held" && live !== null && isTaskBoundRuntimeWriter(lease, actor, source, live)
            ? [{ id: binding.executionId, lease }]
            : [];
        }) ?? [],
      unique = [...new Map(matches.map((match) => [match.id, match])).values()];
    return unique.length === 1
      ? { id: unique[0]!.id, candidates: [], lease: unique[0]!.lease }
      : { id: null, candidates: unique.map((match) => match.id).sort(), lease: null };
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
      current?.phase === "held" &&
      isSameExecution(current.actor, actor) &&
      stableStringify(current.source) === stableStringify(source)
        ? current
        : null;
  return { id: lease?.executionId ?? null, candidates: [], lease };
}
function dirtyPaths(repoRoot: string, authoredPrefix: string): string[] {
  const scope = authoredPrefix || ".",
    changed = gitNames(repoRoot, ["diff", "--name-only", "-z", "HEAD", "--", scope]),
    untracked = gitNames(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope]),
    prefix = authoredPrefix ? `${authoredPrefix}/` : "";
  return [
    ...new Set(
      [...changed, ...untracked]
        .filter(
          (value) =>
            (!prefix || value.startsWith(prefix)) &&
            !value.includes(".conflict-") &&
            !/\/\.ha-(?:visible|settle)-/u.test(`/${value}`),
        )
        .map((value) => value.slice(prefix.length))
        .concat(conflictLogicalPaths(path.join(repoRoot, authoredPrefix))),
    ),
  ];
}
function conflictLogicalPaths(authoredRoot: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /\.conflict-[0-9a-f]{8}\.(?:md|txt)$/u.test(entry.name))
        found.push(relative(authoredRoot, target).replace(/\.conflict-[0-9a-f]{8}(?=\.(?:md|txt)$)/u, ""));
    }
  };
  visit(authoredRoot);
  return found;
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
