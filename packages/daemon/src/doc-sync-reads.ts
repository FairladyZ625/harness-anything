import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  leaseIsEffective,
  type TaskProjection,
  type TaskProjectionQueries,
  type TaskProjectionReader,
} from "@harness-anything/kernel";
import {
  canonicalEventCut,
  classifyRawArtifactPath,
  documentPath,
  documentWorkspacePath,
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
  resolveDocRoute,
  resolveHarnessLayout,
  mediaTypeForBinaryPath,
  worktreeDocumentMediaType,
  sha256Bytes,
  sha256Text,
  stableStringify,
  type DocEventV1,
  type DocSyncReceiptDetail,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { scannerRead } from "./doc-sync-adjudication.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";
import { directPaths, holder, observe, readDetail } from "./doc-sync-details.ts";
import {
  docSyncError,
  hasExactDocSyncActionFields,
  localProseSource,
  proof,
  rejectDocSyncAction,
  requiredDocSyncText,
} from "./doc-sync-files.ts";
import { scanReceipt, scopeTouches } from "./doc-sync-settlement.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import {
  presetSnapshotReader,
  readTaskWorktreeExecutionBinding,
  taskLeaseAcquiredRevision,
  taskWorktreeBinding,
} from "./task-worktree.ts";
import { taskWorktreeRoot } from "./task-worktree-candidates.ts";
import {
  readSubmissionArtifact,
  readSubmissionArtifactRange,
  submissionArtifactPath,
  verifyAcceptedContent,
} from "./submission-artifacts.ts";
import { renderWorkExplainer } from "./work-read.ts";

export function readAction(input: Input): WriteReceipt {
  if (input.action.kind !== "doc-show") return scanReceipt(input, scannerRead(input));
  const rawPaths = input.action.kind === "doc-show" ? [input.action.path] : input.action.paths;
  const ranged =
    input.action.kind === "doc-show" &&
    (Object.hasOwn(input.action, "offset") || Object.hasOwn(input.action, "length"));
  const pinned =
    ranged && Object.hasOwn(input.action, "contentSha256") && Object.hasOwn(input.action, "contentRevision");
  const hasPartialPin = Object.hasOwn(input.action, "contentSha256") !== Object.hasOwn(input.action, "contentRevision");
  if (
    !hasExactDocSyncActionFields(
      input.action,
      input.action.kind === "doc-show"
        ? [
            "kind",
            "path",
            ...(input.action.raw === true ? ["raw"] : []),
            ...(ranged ? ["offset", "length"] : []),
            ...(pinned ? ["contentSha256", "contentRevision"] : []),
          ]
        : ["kind", "paths"],
    ) ||
    !Array.isArray(rawPaths) ||
    !rawPaths.length ||
    rawPaths.some((item) => typeof item !== "string")
  )
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  if (
    hasPartialPin ||
    (!ranged && (Object.hasOwn(input.action, "contentSha256") || Object.hasOwn(input.action, "contentRevision")))
  )
    throw docSyncError("invalid_command", "doc-show content identity requires a range offset and length");
  let paths;
  try {
    paths = rawPaths.map((item) => documentPath(String(item)));
  } catch {
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  }
  const principal = input.binding.executionPrincipal;
  if (principal?.role === "reviewer" && principal.taskId !== null && principal.executionId !== null) {
    const task = input.projection.read(principal.taskId),
      execution = task.snapshot.executions.find((entry) => entry.executionId === principal.executionId),
      requested = paths[0],
      anchor = execution?.submission?.artifacts?.find(
        (entry) => submissionArtifactPath(task.packagePath!, entry.path) === requested,
      );
    // Submitted artifacts retain their frozen bytes; other reads use the shared live projection.
    if (task.packagePath && anchor) {
      if (ranged) {
        const offset = Number(input.action.offset),
          length = Number(input.action.length),
          artifact = readSubmissionArtifactRange(
            { store: input.store, cellCodedError: docSyncError },
            task.packagePath,
            anchor.path,
            anchor.revision,
            anchor.blobSha256,
            offset,
            length,
          );
        if (
          pinned &&
          (String(input.action.contentSha256) !== artifact.anchor.blobSha256 ||
            Number(input.action.contentRevision) !== anchor.revision)
        )
          throw docSyncError("content_changed", "Frozen artifact content identity changed during range read");
        return {
          outcome: "applied",
          opId: artifact.acceptance,
          revision: anchor.revision,
          evidence: Buffer.from(artifact.bytes).toString("base64"),
          evidenceEncoding: "base64",
          evidenceOffset: offset,
          evidenceSize: artifact.size,
          evidenceDone: offset + artifact.bytes.byteLength >= artifact.size,
          evidenceBlobSha256: artifact.anchor.blobSha256,
          evidenceSourceRevision: anchor.revision,
          evidenceWorkspaceRevision: anchor.revision,
          evidenceContentEncoding: artifact.encoding,
          visibility: "center",
          proof: proof(anchor.revision, anchor.revision, true, false),
        } as unknown as WriteReceipt;
      }
      const artifact = readSubmissionArtifact(
        { store: input.store, cellCodedError: docSyncError },
        task.packagePath,
        anchor.path,
        anchor.revision,
        anchor.blobSha256,
      );
      if (
        pinned &&
        (String(input.action.contentSha256) !== artifact.anchor.blobSha256 ||
          Number(input.action.contentRevision) !== anchor.revision)
      )
        throw docSyncError("content_changed", "Frozen artifact content identity changed during range read");
      if (ranged) {
        const bytes =
            artifact.encoding === "base64" ? Buffer.from(artifact.body, "base64") : Buffer.from(artifact.body),
          offset = Number(input.action.offset),
          length = Number(input.action.length),
          chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
        return {
          ...artifact,
          evidence: chunk.toString("base64"),
          evidenceEncoding: "base64",
          evidenceOffset: offset,
          evidenceSize: bytes.byteLength,
          evidenceDone: offset + chunk.byteLength >= bytes.byteLength,
          evidenceBlobSha256: artifact.anchor.blobSha256,
          evidenceSourceRevision: anchor.revision,
          evidenceWorkspaceRevision: anchor.revision,
          evidenceContentEncoding: artifact.encoding,
        } as unknown as WriteReceipt;
      }
      return {
        outcome: "applied",
        opId: artifact.acceptance,
        revision: anchor.revision,
        evidence: artifact.body,
        visibility: "center",
        proof: proof(anchor.revision, anchor.revision, true, false),
      };
    }
  }
  if (!directPaths(input.rootDir, paths) || paths.some((candidate) => !resolveDocRoute(candidate).allowed))
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  const current = input.store.currentCut(),
    lease = null;
  // Dispatch credentials grant repository-wide read visibility; task lease checks remain for
  // ordinary node reads without an execution principal.
  const scope = input.binding.executionPrincipal ? [] : scopeTouches(input, paths);
  if (scope.length)
    return rejectDocSyncAction(
      `read:${input.action.kind}:${current.headDigest}`,
      "execution_scope_mismatch",
      readDetail(input, paths, current, lease, scope),
    );
  const reads = paths.map((candidate) => input.projection.readDocument(candidate)),
    revision = current.revision,
    ready = reads.every((read) => read.status === "ready");
  const receiptDetail = readDetail(input, paths, current, lease, []),
    worktreeVisible = observe(
      input.rootDir,
      input.binding.source,
      reads.map((read) => read.document),
    );
  if (input.action.kind === "doc-show" && ready && reads[0]?.document === null)
    return rejectDocSyncAction(`read:doc-show:${current.headDigest}`, "document_not_found", receiptDetail);
  // A raw artifact is owned and materialized like any other document, so saying "not found" would hide it.
  // It just has no text to print: name the owner and where the bytes are instead of returning an empty body.
  const rawDocument = input.action.kind === "doc-show" && ready ? reads[0]?.document : null;
  if (rawDocument != null && rawDocument.policyId === RAW_ARTIFACT_POLICY_ID)
    return rejectDocSyncAction(
      `read:doc-show:${current.headDigest}`,
      "document_not_text",
      receiptDetail,
      `${rawDocument.path} is a raw task artifact of ${rawDocument.size} bytes; ` +
        `read the materialized file or content object ${rawDocument.blobSha256}`,
    );
  const rangeOffset =
      input.action.kind === "doc-show" && Number.isSafeInteger(input.action.offset) && Number(input.action.offset) >= 0
        ? Number(input.action.offset)
        : null,
    rangeLength =
      input.action.kind === "doc-show" &&
      Number.isSafeInteger(input.action.length) &&
      Number(input.action.length) > 0 &&
      Number(input.action.length) <= 64 * 1024
        ? Number(input.action.length)
        : null;
  if ((rangeOffset === null) !== (rangeLength === null))
    throw docSyncError("invalid_command", "doc-show range requires both offset and length");
  if (
    pinned &&
    (!reads[0]?.document ||
      String(input.action.contentSha256) !== reads[0].document.blobSha256 ||
      Number(input.action.contentRevision) !== reads[0].document.workspaceRevision)
  )
    throw docSyncError("content_changed", "Document content identity changed during range read");
  if (rangeOffset !== null && rangeLength !== null && reads[0]?.document) {
    const document = reads[0].document,
      sourceRevision = reads[0].sourceRevision;
    if (
      pinned &&
      (String(input.action.contentSha256) !== document.blobSha256 ||
        Number(input.action.contentRevision) !== document.workspaceRevision)
    )
      throw docSyncError("content_changed", "Document content identity changed during range read");
    const encoding = verifyAcceptedContent(
        { store: input.store, cellCodedError: docSyncError },
        document.blobSha256,
        document.size,
      ),
      bytes = input.store.readContentBlobRange(document.blobSha256, rangeOffset, rangeLength);
    if (bytes === null) throw docSyncError("document_not_found", "document content is unavailable");
    const rangeReceipt = (
      ready
        ? {
            outcome: "applied",
            opId: `read:${input.action.kind}:${current.headDigest}`,
            revision,
            visibility: "center",
            proof: proof(revision, revision, true, worktreeVisible),
            detail: receiptDetail,
          }
        : {
            outcome: "pending",
            opId: `read:${input.action.kind}:${current.headDigest}`,
            revision,
            visibility: "center",
            proof: proof(revision, Math.min(...reads.map((read) => read.watermark)), false, worktreeVisible),
            detail: receiptDetail,
          }
    ) as WriteReceipt;
    return {
      ...rangeReceipt,
      evidence: Buffer.from(bytes).toString("base64"),
      evidenceEncoding: "base64",
      evidenceOffset: rangeOffset,
      evidenceSize: document.size,
      evidenceDone: rangeOffset + bytes.byteLength >= document.size,
      evidenceBlobSha256: document.blobSha256,
      evidenceSourceRevision: sourceRevision,
      evidenceWorkspaceRevision: document.workspaceRevision,
      evidenceContentEncoding: encoding,
    } as unknown as WriteReceipt;
  }
  const evidence =
    input.action.kind === "doc-show"
      ? (reads[0]?.document?.body ?? "document:not-found")
      : `document-cut:${current.headDigest}`;
  const baseReceipt = (
    ready
      ? {
          outcome: "applied",
          opId: `read:${input.action.kind}:${current.headDigest}`,
          revision,
          evidence,
          visibility: "center",
          proof: proof(revision, revision, true, worktreeVisible),
          detail: receiptDetail,
        }
      : {
          outcome: "pending",
          opId: `read:${input.action.kind}:${current.headDigest}`,
          revision,
          evidence,
          visibility: "center",
          proof: proof(revision, Math.min(...reads.map((read) => read.watermark)), false, worktreeVisible),
          detail: receiptDetail,
        }
  ) as WriteReceipt;
  if (rangeOffset === null || rangeLength === null) return baseReceipt;
  const bytes = Buffer.from(evidence),
    chunk = bytes.subarray(rangeOffset, Math.min(bytes.byteLength, rangeOffset + rangeLength));
  return {
    ...baseReceipt,
    evidence: chunk.toString("base64"),
    evidenceEncoding: "base64",
    evidenceOffset: rangeOffset,
    evidenceSize: bytes.byteLength,
    evidenceDone: rangeOffset + chunk.byteLength >= bytes.byteLength,
    evidenceBlobSha256: reads[0]?.document?.blobSha256 ?? null,
    evidenceSourceRevision: reads[0]?.sourceRevision ?? revision,
    evidenceWorkspaceRevision: reads[0]?.document?.workspaceRevision ?? revision,
    evidenceContentEncoding: "utf8",
  } as WriteReceipt;
}

export function readDocReceipt(input: Omit<Input, "action">, event: DocEventV1): DocSettlementReceipt {
  // Only a CLI-typed selection prints the workspace spelling; an internal read keeps the authored key.
  const layout = input.workspaceCoordinate === true ? resolveHarnessLayout(input.rootDir) : null,
    workspacePath =
      layout === null
        ? (document: string) => document
        : (document: string) => documentWorkspacePath(input.rootDir, document, layout),
    retirement = event.payload.retirementReason === undefined ? null : event.payload.changes,
    reads = event.payload.changes.map((change) => input.projection.readDocument(change.path)),
    canonicalVisible = reads.every((read, index) => {
      const candidate = event.payload.changes[index]!.candidate;
      return (
        read.status === "ready" &&
        (candidate === null ? read.document === null : read.document?.blobSha256 === candidate.sha256) &&
        read.watermark >= event.workspaceRevision
      );
    }),
    appliedCut = Math.min(...reads.map((read) => read.watermark)),
    current = input.store.currentCut(),
    lease =
      event.payload.executionId === null
        ? null
        : input.projection.currentLeaseForExecution(event.payload.executionId, input.now());
  const receiptDetail: DocSyncReceiptDetail = {
    kind: "doc_sync",
    code: canonicalVisible ? (retirement === null ? "applied" : "retired") : "projection_pending",
    baseLedgerSha: event.payload.baseLedgerSha,
    currentLedgerSha: current,
    paths: event.payload.changes.map((change, index) => ({
      path: workspacePath(change.path),
      baseBlobSha256: change.baseBlobSha256,
      currentBlobSha256: reads[index]?.document?.blobSha256 ?? null,
      candidateBlobSha256: change.candidate?.sha256 ?? null,
    })),
    holder: holder(lease),
    differences: [],
    unresolvedTouches: [],
    deletions:
      retirement === null
        ? []
        : retirement.map((change) => ({
            path: workspacePath(change.path),
            baseBlobSha256: change.baseBlobSha256!,
            source: "intent" as const,
          })),
  };
  const retirementReceipt =
      retirement === null
        ? null
        : {
            schema: "doc-retirement-receipt/v1",
            retirements: retirement.map((change) => ({
              path: workspacePath(change.path),
              baseBlobSha256: change.baseBlobSha256!,
            })),
            reason: event.payload.retirementReason,
          },
    worktreeVisible =
      retirement === null
        ? observe(
            input.rootDir,
            input.binding.source,
            reads.map((read) => read.document),
          )
        : localProseSource(input.binding.source)
          ? retirement.every(
              (change) =>
                !existsSync(path.join(resolveHarnessLayout(input.rootDir).authoredRoot, ...change.path.split("/"))),
            )
          : null;
  const common = {
    opId: event.opId,
    revision: event.workspaceRevision,
    evidence:
      retirementReceipt === null
        ? `event-object:${event.opId}`
        : `doc-retirement:${stableStringify(retirementReceipt)}`,
    visibility: "center" as const,
    proof: proof(event.workspaceRevision, appliedCut, canonicalVisible, worktreeVisible),
    detail: receiptDetail,
  };
  const settlement = canonicalVisible ? ("applied" as const) : ("pending" as const),
    materialized = input.store.publication(event),
    identity = {
      commitSha: materialized.commitSha?.sha ?? null,
      cut: canonicalEventCut(current.repoId, event),
      settlement,
      receiptId: event.opId,
    };
  return canonicalVisible
    ? { outcome: "applied", ...common, ...identity }
    : {
        outcome: "pending",
        ...common,
        ...identity,
        guidance: [{ kind: "retry-receipt", args: { opId: event.opId } }],
      };
}

/** Raw bytes this document preview read carries inline. Above it the
 * read still answers with true metadata and the repository path the bytes materialize at. */
// Viewer payloads are still bounded per request, but common PDF/DOCX files may be larger than the
// old 2 MiB text-oriented ceiling. The source remains the authorized content object or task package.
export const TASK_DOCUMENT_INLINE_BYTES_MAX = 16 * 1024 * 1024;

/** The cut a document read answered from. `canonical` is the accepted projection, `authored-copy` is
 * the live file under the authored root, `execution` is one execution's own workspace, `derived` is a
 * rendered explainer, and `unobservable` means the requested cut could not be seen. */
export type ProjectedDocumentSource = "canonical" | "authored-copy" | "execution" | "derived" | "unobservable";
/** Whether the returned cut is known to match the accepted canonical cut. `unobservable` is not
 * `false`: a missing authored copy or an unreadable workspace is an absence of evidence, never a
 * claim that the workspace is clean. */
export type ProjectedDocumentSyncState = "synced" | "unsynced" | "unobservable" | "derived";

export interface CanonicalDocumentVersion {
  readonly workspaceRevision: number;
  readonly blobSha256: string;
  readonly size: number;
}

export interface ExecutionObservationBinding {
  readonly executionId: string;
  readonly leaseVersion: number;
  readonly leaseExpiresAt: string;
  readonly observedAt: string;
}

interface DocumentCut {
  readonly contentKind: "text" | "binary";
  readonly body: string;
  readonly bytes: Buffer | null;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string | null;
}

interface ObservedDocumentRow {
  readonly body: string | null;
  readonly bytes: Buffer;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string | null;
}

/** What this read needs from the repo cell: the layout, the projection, and the content-object store
 * the canonical bytes come from. Structural on purpose, the same way readArtifactsGui takes its own. */
export interface ProjectedDocumentReadContext {
  readonly rootDir: string;
  readonly projection: TaskProjection;
  readonly store: { readonly readContentBlob: (sha256: string) => Uint8Array | null };
  /** Owns both sessions; callers must invoke this read outside any pinned projection session. */
  readonly withReadSession?: TaskProjectionReader["withSession"];
  /** Observation clock; tests inject one, production reads the wall clock once per observation. */
  readonly now?: () => string;
}

export function readProjectedDocument(
  context: ProjectedDocumentReadContext,
  payload: Readonly<Record<string, unknown>>,
) {
  // Query-only readers supply the existing session port so the post-IO check starts after the
  // initial snapshot has ended. Other contexts can still answer canonical/authored reads.
  const read: TaskProjectionReader["withSession"] = context.withReadSession ?? ((use) => use(context.projection)),
    result = read((projection) =>
      readProjectedDocumentAtCut({ ...context, projection: projection as TaskProjection }, payload),
    );
  return typeof result === "function" ? read(result) : result;
}

function readProjectedDocumentAtCut(context: ProjectedDocumentReadContext, payload: Readonly<Record<string, unknown>>) {
  const { rootDir, projection } = context,
    taskId = requiredDocSyncText(payload.taskId, "taskId"),
    requested = requiredDocSyncText(payload.path, "path"),
    view = documentReadView(payload.view),
    executionId = payload.executionId === undefined ? null : requiredDocSyncText(payload.executionId, "executionId"),
    // Absence settles through the same judgment as task show / dispatches / read-set: a lagging
    // cut is not an answer about this task, and a current cut without it is a not-found naming it.
    task = requireCurrentTaskProjection(projection, taskId, "task document read"),
    packagePath = task.packagePath;
  const logical = documentPath(`${packagePath}/${requested}`),
    read = projection.readDocument(logical),
    document = read.document,
    workExplainer = requested === "artifacts/explainer.html" && task.snapshot.task?.taskClass === "work",
    // What the accepted policy says this document is, and — before anything is accepted — what the
    // path itself claims. A reader must never have to infer "not text" from an empty body.
    binary =
      document === null ? classifyRawArtifactPath(logical) !== null : document.policyId === RAW_ARTIFACT_POLICY_ID,
    authored = readWorktreeDocument(taskPackageWorktreeRoot(rootDir, packagePath), requested, binary),
    canonicalVersion: CanonicalDocumentVersion | null =
      document === null
        ? null
        : {
            workspaceRevision: document.workspaceRevision,
            blobSha256: document.blobSha256,
            size: Number(document.size),
          },
    repositoryPath = repositoryPathOf(rootDir, logical),
    base = {
      ok: true as const,
      status: read.status,
      taskId,
      path: requested,
      repositoryPath,
      canonicalVersion,
      watermark: read.watermark,
      sourceRevision: read.sourceRevision,
    };
  const unobservable = (reason: string) => ({
    ...base,
    source: "unobservable" as const,
    syncState: "unobservable" as const,
    body: "",
    blobSha256: null,
    contentKind: binary ? ("binary" as const) : ("text" as const),
    mediaType: documentMediaType(document, authored, requested, binary),
    size: null,
    bytes: null,
    worktreeBody: null,
    uncommitted: false,
    execution: null,
    unobservableReason: reason,
  });
  const observed = (
    cut: DocumentCut,
    source: Exclude<ProjectedDocumentSource, "derived" | "unobservable">,
    syncState: Exclude<ProjectedDocumentSyncState, "derived">,
    execution: ExecutionObservationBinding | null = null,
  ) => ({
    ...base,
    source,
    syncState,
    body: cut.body,
    blobSha256: cut.blobSha256,
    contentKind: cut.contentKind,
    mediaType: cut.mediaType,
    size: cut.size,
    bytes: cut.bytes === null ? null : Buffer.from(cut.bytes).toString("base64"),
    // The live authored copy stays visible beside the canonical answer; it is never folded into the
    // canonical digest. A missing copy is null, and `syncState` says the comparison could not happen.
    worktreeBody: authored?.body ?? null,
    // The legacy boolean describes the cut this response returned. For a canonical answer that cut is
    // the accepted projection, so the field still reports whether the authored copy diverged.
    uncommitted:
      source === "canonical"
        ? authored !== null && (canonicalVersion === null || authored.blobSha256 !== canonicalVersion.blobSha256)
        : canonicalVersion === null || cut.blobSha256 !== canonicalVersion.blobSha256,
    execution,
    unobservableReason: null,
  });

  if (workExplainer) {
    if (view !== "default" && view !== "canonical") return unobservable("derived_document_has_no_requested_source");
    const rendered = renderWorkExplainer(projection, taskId),
      derived = {
        contentKind: "text" as const,
        body: rendered,
        bytes: null,
        blobSha256: sha256Text(rendered),
        size: Buffer.byteLength(rendered),
        mediaType: "text/html",
      };
    return {
      ...base,
      source: "derived" as const,
      syncState: "derived" as const,
      body: derived.body,
      blobSha256: derived.blobSha256,
      contentKind: derived.contentKind,
      mediaType: derived.mediaType,
      size: derived.size,
      bytes: null,
      worktreeBody: derived.body,
      uncommitted: false,
      execution: null,
      unobservableReason: null,
    };
  }

  if (view === "execution") {
    if (executionId === null) return unobservable("execution_not_specified");
    if (context.withReadSession === undefined) return unobservable("execution_workspace_unavailable");
    const observation = observeExecution(context, task, packagePath, requested, binary, executionId);
    if ("reason" in observation) return unobservable(observation.reason);
    // A monotonic acquisition cannot return to A after re-entry B. This continuation runs in
    // a new session, since snapshot A contains no proof about the live files read above.
    return (projection: TaskProjectionQueries) => {
      const lease = projection.currentLease(taskId);
      if (
        lease === null ||
        !leaseIsEffective(lease) ||
        lease.executionId !== executionId ||
        lease.source !== "local" ||
        observation.acquiredRevision !== taskLeaseAcquiredRevision(projection, taskId, executionId)
      )
        return unobservable("execution_workspace_stale_marker");
      return observed(observation.cut, "execution", syncStateOf(observation.cut, canonicalVersion), {
        executionId,
        leaseVersion: lease.version,
        leaseExpiresAt: lease.expiresAt,
        observedAt: context.now?.() ?? new Date().toISOString(),
      });
    };
  }

  if (view === "authored-copy") {
    if (authored === null) return unobservable("authored_copy_not_observed");
    const cut = cutOfWorktree(authored, requested, binary);
    return observed(cut, "authored-copy", syncStateOf(cut, canonicalVersion));
  }

  // An explicit canonical view is a strict request for the accepted cut. A missing accepted
  // document is unobservable; the authored copy is never substituted for it.
  if (view === "canonical") {
    if (document === null) return unobservable("document_not_observed");
    const { cut, syncState } = canonicalCutAndSync(context, document, authored, binary, requested),
      result = observed(cut, "canonical", syncState === "unobservable" ? "unobservable" : syncState);
    return authored === null ? { ...result, unobservableReason: "authored_copy_not_observed" } : result;
  }

  // Default view keeps the previous behaviour: the accepted cut is the answer. Only when there is no accepted cut, or when a raw
  // artifact's live bytes differ from the accepted object, does the returned content come from the
  // authored copy — and then `source` says so instead of silently mixing digest and bytes.
  if (document === null) {
    if (authored === null) return unobservable("document_not_observed");
    const cut = cutOfWorktree(authored, requested, binary);
    return observed(cut, "authored-copy", "unsynced");
  }
  if (binary && authored !== null && authored.blobSha256 !== document.blobSha256) {
    const cut = cutOfWorktree(authored, requested, binary);
    return observed(cut, "authored-copy", "unsynced");
  }
  const { cut, syncState } = canonicalCutAndSync(context, document, authored, binary, requested),
    result = observed(cut, "canonical", syncState === "unobservable" ? "unobservable" : syncState);
  return authored === null ? { ...result, unobservableReason: "authored_copy_not_observed" } : result;
}

function canonicalCutAndSync(
  context: ProjectedDocumentReadContext,
  document: {
    readonly body: string;
    readonly blobSha256: string;
    readonly size: number | bigint;
    readonly mediaType: string;
  },
  authored: ObservedDocumentRow | null,
  binary: boolean,
  requested: string,
): { readonly cut: DocumentCut; readonly syncState: "synced" | "unsynced" | "unobservable" } {
  const canonicalBytes =
      binary && Number(document.size) <= TASK_DOCUMENT_INLINE_BYTES_MAX
        ? context.store.readContentBlob(document.blobSha256)
        : null,
    cut = cutOfCanonical(document, binary, canonicalBytes, requested),
    syncState: "synced" | "unsynced" | "unobservable" =
      authored === null ? "unobservable" : authored.blobSha256 === document.blobSha256 ? "synced" : "unsynced";
  return { cut, syncState };
}

type DocumentReadView = "default" | "canonical" | "authored-copy" | "execution";

/** Absent view keeps the previous default: a binary whose live copy differs may answer that copy,
 * labelled authored-copy. An explicit `view: "canonical"` is strict and never falls back. */
function documentReadView(value: unknown): DocumentReadView {
  if (value === undefined || value === null) return "default";
  if (value === "canonical" || value === "authored-copy" || value === "execution") return value;
  throw docSyncError("invalid_command", 'document read view must be "canonical", "authored-copy" or "execution"');
}

function cutOfCanonical(
  document: {
    readonly body: string;
    readonly blobSha256: string;
    readonly size: number | bigint;
    readonly mediaType: string;
  },
  binary: boolean,
  canonicalBytes: Uint8Array | null,
  requested: string,
): DocumentCut {
  return {
    contentKind: binary ? "binary" : "text",
    body: binary ? "" : document.body,
    bytes: binary ? (canonicalBytes === null ? null : Buffer.from(canonicalBytes)) : null,
    blobSha256: document.blobSha256,
    size: Number(document.size),
    mediaType: binary ? mediaTypeForBinaryPath(requested, document.mediaType) : document.mediaType,
  };
}

function cutOfWorktree(row: ObservedDocumentRow, requested: string, binary: boolean): DocumentCut {
  return {
    contentKind: binary ? "binary" : "text",
    body: binary ? "" : (row.body ?? ""),
    bytes: binary ? row.bytes : null,
    blobSha256: row.blobSha256,
    size: row.size,
    mediaType: binary ? mediaTypeForBinaryPath(requested, row.mediaType) : row.mediaType,
  };
}

function syncStateOf(cut: DocumentCut, canonicalVersion: CanonicalDocumentVersion | null): "synced" | "unsynced" {
  return canonicalVersion !== null && cut.blobSha256 === canonicalVersion.blobSha256 ? "synced" : "unsynced";
}

function documentMediaType(
  document: { readonly mediaType: string } | null,
  authored: ObservedDocumentRow | null,
  requested: string,
  binary: boolean,
): string | null {
  const mediaType = document?.mediaType ?? authored?.mediaType ?? null;
  return binary ? mediaTypeForBinaryPath(requested, mediaType) : mediaType;
}

/** A read-time observation of one execution's workspace. It is bounded by the execution's effective
 * lease: a released, expired or foreign lease has no workspace authority to show, so the answer is
 * `unobservable` rather than the current canonical or authored copy wearing an execution label. */
function observeExecution(
  context: ProjectedDocumentReadContext,
  task: ReturnType<TaskProjection["read"]> & { readonly packagePath: string },
  packagePath: string,
  requested: string,
  binary: boolean,
  executionId: string,
): { readonly cut: DocumentCut; readonly acquiredRevision: number } | { readonly reason: string } {
  const execution = task.snapshot.executions.find((candidate) => candidate.executionId === executionId);
  if (execution === undefined) return { reason: "execution_not_found" };
  const lease = task.snapshot.lease;
  if (lease === null || !leaseIsEffective(lease) || lease.executionId !== executionId)
    return { reason: "execution_not_leased" };
  if (execution.state !== "active") return { reason: "execution_not_active" };
  // A local lease is the only ownership this daemon can prove. A node lease belongs to a remote
  // workspace; the center's local worktree or authored package may be an older cut from another
  // execution, so it must not wear this execution's label.
  if (lease.source !== "local") return { reason: "execution_owner_not_local" };
  const workspace = executionWorkspaceRoot(context, task, packagePath);
  if (workspace.root === null || workspace.worktreeRoot === null) return { reason: workspace.reason };
  // The marker is written only by the local start that prepared this worktree. A reused old
  // checkout, a failed checkout, or a marker from another execution has no matching proof.
  const marker = readTaskWorktreeExecutionBinding(workspace.worktreeRoot, executionId);
  if (marker.invalid) return { reason: "execution_workspace_marker_invalid" };
  if (
    marker.binding === null ||
    marker.binding.taskId !== task.snapshot.task?.taskId ||
    marker.binding.executionId !== executionId
  )
    return { reason: "execution_workspace_unbound" };
  const row = readWorktreeDocument(workspace.root, requested, binary);
  if (row === null) return { reason: "document_not_observed" };
  return {
    cut: cutOfWorktree(row, requested, binary),
    acquiredRevision: marker.binding.acquiredRevision,
  };
}

/** An execution is observed only in its materialized task worktree. A task-package task's authored
 * copy is not proof of execution ownership, and a bound-but-absent worktree is unobservable — never
 * silently replaced by the center's copy. */
function executionWorkspaceRoot(
  context: ProjectedDocumentReadContext,
  task: ReturnType<TaskProjection["read"]> & { readonly packagePath: string },
  packagePath: string,
): { readonly root: string | null; readonly worktreeRoot: string | null; readonly reason: string } {
  if (taskWorktreeBinding(task.snapshot.task, presetSnapshotReader(context.projection)) === null)
    return { root: null, worktreeRoot: null, reason: "execution_workspace_unavailable" };
  const taskRoot = taskWorktreeRoot(context, task.snapshot);
  if (taskRoot === null) return { root: null, worktreeRoot: null, reason: "execution_workspace_not_materialized" };
  const layout = resolveHarnessLayout(context.rootDir),
    relative = path.relative(layout.rootDir, layout.authoredRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return { root: null, worktreeRoot: null, reason: "execution_workspace_outside_checkout" };
  return {
    root: path.resolve(taskRoot, relative, ...packagePath.split("/")),
    worktreeRoot: taskRoot,
    reason: "",
  };
}

/** Repository-relative path of an authored document, resolved from the configured authored root. */
function repositoryPathOf(rootDir: string, logical: string): string {
  return path
    .relative(rootDir, path.join(resolveHarnessLayout(rootDir).authoredRoot, logical))
    .split(path.sep)
    .join("/");
}

/** GUI read repo.tasks.documents.list: projected documents under one task package,
 * with paths relative to the package root. Files that exist only in the worktree (created
 * but never doc-synced) are listed too, flagged uncommitted, so they are visible at all. */
export function listProjectedTaskDocuments(
  rootDir: string,
  projection: TaskProjection,
  payload: Readonly<Record<string, unknown>>,
): import("./protocol/daemon-protocol.contract.ts").DaemonTaskDocumentListResult {
  const taskId = requiredDocSyncText(payload.taskId, "taskId"),
    // Same shared judgment as the document read above: the list must not answer a lagging cut
    // with stale rows, nor a current cut without the task with an empty success.
    task = requireCurrentTaskProjection(projection, taskId, "task documents list"),
    packagePath = task.packagePath;
  const prefix = `${packagePath}/`,
    basis = projection.readDocuments(prefix),
    worktree = worktreeDocumentIndex(taskPackageWorktreeRoot(rootDir, packagePath), packagePath),
    worktreeByPath = new Map(worktree.map((row) => [row.path, row])),
    documents = [
      ...(task.snapshot.task?.taskClass === "work"
        ? [
            {
              path: "artifacts/explainer.html",
              blobSha256: sha256Text(renderWorkExplainer(projection, taskId)),
              size: Buffer.byteLength(renderWorkExplainer(projection, taskId)),
              mediaType: "text/html",
              uncommitted: false,
            },
          ]
        : []),
      ...basis.documents
        .filter((row) => row.path.startsWith(prefix))
        .filter(
          (row) => !(task.snapshot.task?.taskClass === "work" && row.path === `${prefix}artifacts/explainer.html`),
        )
        .map((row) => {
          const relative = row.path.slice(prefix.length),
            live = worktreeByPath.get(relative);
          return {
            path: relative,
            blobSha256: row.blobSha256,
            size: row.size,
            mediaType: row.mediaType,
            uncommitted: live !== undefined && live.blobSha256 !== row.blobSha256,
          };
        }),
      ...worktree.filter(
        (row) =>
          !(task.snapshot.task?.taskClass === "work" && row.path === "artifacts/explainer.html") &&
          !basis.documents.some((projected) => projected.path === `${prefix}${row.path}`),
      ),
    ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: true,
    status: task.status,
    taskId,
    documents,
    watermark: basis.watermark,
    sourceRevision: basis.sourceRevision,
  };
}

const worktreeDocumentMaxBytes = TASK_DOCUMENT_INLINE_BYTES_MAX,
  worktreeDocumentMaxEntries = 2000;

type WorktreeDocumentRow = {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly uncommitted: true;
};

/** Task packages live under the authored harness root (harness/tasks/<package>), which is
 * where doc-sync writes and where the live working copy the GUI must show resides. */
function taskPackageWorktreeRoot(rootDir: string, packagePath: string): string | null {
  const authoredRoot = path.resolve(resolveHarnessLayout(rootDir).authoredRoot),
    packageRoot = path.resolve(authoredRoot, packagePath);
  return packageRoot.startsWith(`${authoredRoot}${path.sep}`) ? packageRoot : null;
}

function resolveWorktreeDocumentPath(packageRoot: string | null, relative: string): string | null {
  if (packageRoot === null || statLinkSync(packageRoot)?.isSymbolicLink()) return null;
  const target = path.resolve(packageRoot, relative);
  if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) return null;
  let cursor = packageRoot;
  for (const segment of path.relative(packageRoot, target).split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (statLinkSync(cursor)?.isSymbolicLink()) return null;
  }
  return target;
}

/** One live file from the task package's working copy, or null when it is absent. Binary bytes are
 * never turned into a string here: a lossy UTF-8 view of a PNG is not "the live content of that
 * file", it is a different file that happens to share its name. */
function readWorktreeDocument(
  packageRoot: string | null,
  relative: string,
  binary: boolean,
): {
  readonly body: string | null;
  readonly bytes: Buffer;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string | null;
} | null {
  const target = resolveWorktreeDocumentPath(packageRoot, relative);
  if (target === null) return null;
  const stat = statFileSync(target);
  if (stat === null || !stat.isFile() || stat.size > worktreeDocumentMaxBytes) return null;
  const bytes = readFileSync(target);
  return {
    body: binary ? null : bytes.toString("utf8"),
    bytes,
    blobSha256: sha256Bytes(bytes),
    size: bytes.byteLength,
    mediaType: binary ? RAW_ARTIFACT_MEDIA_TYPE : worktreeDocumentMediaType(relative),
  };
}

/** Document-shaped files currently on disk under the task package. The worktree is the
 * truth for "what exists now"; the projection is the truth for "what is committed". */
function worktreeDocumentIndex(packageRoot: string | null, packagePath: string): readonly WorktreeDocumentRow[] {
  if (packageRoot === null) return [];
  const root = packageRoot,
    rows: WorktreeDocumentRow[] = [];
  if (!existsSync(root) || statLinkSync(root)?.isSymbolicLink() || !statFileSync(root)?.isDirectory()) return rows;
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && rows.length < worktreeDocumentMaxEntries && visited < worktreeDocumentMaxEntries * 4) {
    const directory = queue.shift()!;
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      consumeKnownError(error);
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
        continue;
      }
      // A file whose name promises no text is still a document once it sits in a task's artifacts/
      // subtree — the raw policy owns it, so listing it as octet-stream is the truth and dropping it
      // would hide a real output from the only surface that lists the package.
      const relative = path.relative(root, target).split(path.sep).join("/"),
        mediaType =
          worktreeDocumentMediaType(entry.name) ?? classifyRawArtifactPath(`${packagePath}/${relative}`)?.mediaType,
        stat = mediaType === undefined || !entry.isFile() ? null : statFileSync(target);
      if (mediaType === undefined || mediaType === null || stat === null || stat.size > worktreeDocumentMaxBytes)
        continue;
      const bytes = readFileSync(target);
      rows.push({
        path: relative,
        blobSha256: sha256Bytes(bytes),
        size: stat.size,
        mediaType,
        uncommitted: true,
      });
    }
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

export function statFileSync(target: string): import("node:fs").Stats | null {
  try {
    return statSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function statLinkSync(target: string): import("node:fs").Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
