import path from "node:path";
import type * as DocumentStatus from "@harness-anything/kernel/internal/domain/authored-document-status.ts";
import type { CanonicalMaterializationState } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { NodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import {
  canonicalEventCut,
  classifyRawArtifactPath,
  documentPath,
  documentWorkspacePath,
  leaseIsEffective,
  mediaTypeForBinaryPath,
  RAW_ARTIFACT_POLICY_ID,
  resolveDocRoute,
  resolveHarnessLayout,
  sha256Text,
  stableStringify,
  type ActorIdentity,
  type CanonicalEventStore,
  type DocEventV1,
  type DocSyncReceiptDetail,
  type TaskProjectionQueries,
  type TaskProjectionReader,
  type WriteReceiptDraft as WriteReceipt,
  type WriteSource,
} from "@harness-anything/kernel";
import {
  readSubmissionArtifact,
  readSubmissionArtifactRange,
  submissionArtifactPath,
  verifyAcceptedContent,
} from "../commands/submission-artifacts.ts";
import { scopeTouches } from "./doc-sync-adjudication.ts";
import {
  docSyncError,
  hasExactDocSyncActionFields,
  holder,
  localProseSource,
  proof,
  readDetail,
  rejectDocSyncAction,
  requiredDocSyncText,
  type DocAction,
} from "./doc-sync-details.ts";
import { requireCurrentTaskProjection } from "./projection-task-read.ts";
import { projectedTaskMaterializationState } from "./task-show-read.ts";
import { renderWorkExplainer } from "./work-read.ts";

/** Raw bytes this document preview read carries inline. Above it the
 * read still answers with true metadata and the repository path the bytes materialize at. */
export const TASK_DOCUMENT_INLINE_BYTES_MAX = 16 * 1024 * 1024;

export type ProjectedDocumentSource = "canonical" | "authored-copy" | "execution" | "derived" | "unobservable";
export type ProjectedDocumentSyncState = DocumentStatus.ProjectedDocumentSyncState;

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

export interface DocumentCut {
  readonly contentKind: "text" | "binary";
  readonly body: string;
  readonly bytes: Buffer | null;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string | null;
}

export interface ObservedDocumentRow {
  readonly body: string | null;
  readonly bytes: Buffer;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string | null;
}

export interface WorktreeDocumentRow {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly uncommitted: true;
}

export type DocSettlementReceipt = WriteReceipt & {
  readonly commitSha?: string | null;
  readonly settlement?: WriteReceipt["outcome"];
  readonly receiptId?: string;
  readonly summary?: string;
  readonly materializationState?: CanonicalMaterializationState;
};

export interface DocReadExecutionPrincipal {
  readonly role: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
}

export interface DocReadInput {
  readonly action: DocAction;
  readonly binding: {
    readonly actor: ActorIdentity;
    readonly source: WriteSource;
    readonly executionPrincipal?: DocReadExecutionPrincipal;
    /** Set by stateless cloud read hosts after OIDC repository-read authorization (not a local writer). */
    readonly repositoryReadAuthorized?: boolean;
  };
  readonly rootDir: string;
  readonly store: Pick<
    CanonicalEventStore,
    "currentCut" | "readContentBlob" | "readContentBlobRange" | "readContentBlobSize" | "readEventAtRevision"
  > & { readonly publication?: CanonicalEventStore["publication"] };
  readonly projection: TaskProjectionQueries;
  readonly nodeTaskMaterializationPolicy?: NodeTaskMaterializationPolicy;
  readonly now: () => string;
  readonly workspaceCoordinate?: boolean;
}

export interface DocReadPorts {
  /** Local filesystem scanner for `doc-status` / `doc-dry-run`. Omitted on stateless cloud nodes. */
  readonly scannerRead?: () => WriteReceipt;
  /** Local symlink check on authored workspace paths. Omitted on stateless cloud nodes. */
  readonly directPaths?: (paths: readonly string[]) => boolean;
  /** Local authored working-copy observation. Omitted on stateless cloud nodes. */
  readonly observe?: (
    documents: readonly ({ readonly path: string; readonly blobSha256: string } | null)[],
  ) => boolean | null;
  /** Local retirement observation (`true` when retired path is absent from authored root). */
  readonly worktreePathMissing?: (logicalPath: string) => boolean;
}

export function readDocAction(input: DocReadInput, ports: DocReadPorts = {}): WriteReceipt {
  if (input.action.kind !== "doc-show") {
    if (!ports.scannerRead)
      throw docSyncError("invalid_command", `${input.action.kind} requires a local workspace scanner`);
    return ports.scannerRead();
  }
  const rawPaths = [input.action.path];
  const ranged = Object.hasOwn(input.action, "offset") || Object.hasOwn(input.action, "length");
  const pinned =
    ranged && Object.hasOwn(input.action, "contentSha256") && Object.hasOwn(input.action, "contentRevision");
  const hasPartialPin = Object.hasOwn(input.action, "contentSha256") !== Object.hasOwn(input.action, "contentRevision");
  if (
    !hasExactDocSyncActionFields(input.action, [
      "kind",
      "path",
      ...(input.action.raw === true ? ["raw"] : []),
      ...(ranged ? ["offset", "length"] : []),
      ...(pinned ? ["contentSha256", "contentRevision"] : []),
    ]) ||
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
  if (
    (ports.directPaths && !ports.directPaths(paths)) ||
    paths.some((candidate) => !resolveDocRoute(candidate).allowed)
  )
    throw docSyncError("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  const current = input.store.currentCut(),
    lease = null;
  // Dispatch credentials and stateless cloud repository-read grants provide repository-wide
  // read visibility; task lease checks remain for ordinary node reads without either.
  const scope =
    input.binding.executionPrincipal || input.binding.repositoryReadAuthorized ? [] : scopeTouches(input, paths);
  if (scope.length)
    return rejectDocSyncAction(
      `read:${input.action.kind}:${current.headDigest}`,
      "execution_scope_mismatch",
      readDetail(input, paths, current, lease, scope),
    );
  const activeReads = paths.map((candidate) => input.projection.readDocument(candidate)),
    reads = paths.map((candidate, index) => {
      const active = activeReads[index]!;
      if (active.document !== null) return active;
      return input.projection.readDocumentHistory?.(candidate) ?? active;
    }),
    revision = current.revision,
    ready = reads.every((read) => read.status === "ready");
  const receiptDetail = readDetail(input, paths, current, lease, []),
    materializationState =
      reads[0]?.document !== null
        ? activeReads[0]?.document === null
          ? ("dematerialized_terminal" as const)
          : input.nodeTaskMaterializationPolicy === "none" && reads[0]!.document!.mediaType === "text/markdown"
            ? ("skipped_by_node_policy" as const)
            : activeReads[0]?.document !== null
              ? (() => {
                  const document = activeReads[0]!.document!,
                    taskId = input.projection.taskIdForDocumentPath(document.path),
                    taskRead = taskId === null ? null : input.projection.read(taskId),
                    task = taskRead?.snapshot.task
                      ? { ...taskRead.snapshot.task, packagePath: taskRead.packagePath }
                      : null;
                  return task === null
                    ? ("materialized" as const)
                    : projectedTaskMaterializationState(
                        input.projection,
                        task,
                        input.nodeTaskMaterializationPolicy ?? "include_done",
                        document.path,
                      );
                })()
              : ("dematerialized_terminal" as const)
        : undefined,
    worktreeVisible = ports.observe ? ports.observe(reads.map((read) => read.document)) : null;
  if (ready && reads[0]?.document === null)
    return rejectDocSyncAction(`read:doc-show:${current.headDigest}`, "document_not_found", receiptDetail);
  const rawDocument = ready ? reads[0]?.document : null;
  if (rawDocument != null && rawDocument.policyId === RAW_ARTIFACT_POLICY_ID)
    return rejectDocSyncAction(
      `read:doc-show:${current.headDigest}`,
      "document_not_text",
      receiptDetail,
      `${rawDocument.path} is a raw task artifact of ${rawDocument.size} bytes; ` +
        `read the materialized file or content object ${rawDocument.blobSha256}`,
    );
  const rangeOffset =
      Number.isSafeInteger(input.action.offset) && Number(input.action.offset) >= 0
        ? Number(input.action.offset)
        : null,
    rangeLength =
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
      ...(materializationState === undefined ? {} : { materializationState }),
    } as unknown as WriteReceipt;
  }
  const evidence = reads[0]?.document?.body ?? "document:not-found";
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
          ...(materializationState === undefined ? {} : { materializationState }),
        }
      : {
          outcome: "pending",
          opId: `read:${input.action.kind}:${current.headDigest}`,
          revision,
          evidence,
          visibility: "center",
          proof: proof(revision, Math.min(...reads.map((read) => read.watermark)), false, worktreeVisible),
          detail: receiptDetail,
          ...(materializationState === undefined ? {} : { materializationState }),
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

export function readDocReceipt(
  input: Omit<DocReadInput, "action"> & { readonly store: Pick<CanonicalEventStore, "currentCut" | "publication"> },
  event: DocEventV1,
  ports: Pick<DocReadPorts, "observe" | "worktreePathMissing"> = {},
): DocSettlementReceipt {
  // Only a CLI-typed selection prints the workspace spelling; an internal read keeps the authored key.
  const layout = input.workspaceCoordinate === true ? resolveHarnessLayout(input.rootDir) : null,
    workspacePath =
      layout === null
        ? (document: string) => document
        : (document: string) => documentWorkspacePath(input.rootDir, document, layout),
    retirement = event.payload.retirementReason === undefined ? null : event.payload.changes,
    reads = event.payload.changes.map((change) => {
      const active = input.projection.readDocument(change.path);
      if (change.candidate === null) {
        const history = active.document === null ? input.projection.readDocumentHistory?.(change.path) : undefined;
        return history?.document ? history : active;
      }
      return active.document !== null ? active : (input.projection.readDocumentHistory?.(change.path) ?? active);
    }),
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
        ? ports.observe
          ? ports.observe(reads.map((read) => read.document))
          : null
        : localProseSource(input.binding.source) && ports.worktreePathMissing
          ? retirement.every((change) => ports.worktreePathMissing!(change.path))
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

export interface ProjectedDocumentLocalPorts {
  readonly readAuthoredCopy?: (packagePath: string, requested: string, binary: boolean) => ObservedDocumentRow | null;
  readonly observeExecution?: (
    context: ProjectedDocumentReadContext,
    task: ReturnType<TaskProjectionQueries["read"]> & { readonly packagePath: string },
    packagePath: string,
    requested: string,
    binary: boolean,
    executionId: string,
  ) => { readonly cut: DocumentCut; readonly acquiredRevision: number } | { readonly reason: string };
  readonly leaseAcquiredRevision?: (
    projection: TaskProjectionQueries,
    taskId: string,
    executionId: string,
  ) => number | null;
}

/** What this read needs from a host: the layout root, the projection, and the content-object store.
 * Stateless cloud callers omit `local`; daemon callers inject local authored-copy / execution-worktree probes. */
export interface ProjectedDocumentReadContext {
  readonly rootDir: string;
  readonly projection: TaskProjectionQueries;
  readonly store: { readonly readContentBlob: (sha256: string) => Uint8Array | null };
  /** Owns both sessions; callers must invoke this read outside any pinned projection session. */
  readonly withReadSession?: TaskProjectionReader["withSession"];
  /** Observation clock; tests inject one, production reads the wall clock once per observation. */
  readonly now?: () => string;
  readonly local?: ProjectedDocumentLocalPorts;
}

export function readProjectedDocument(
  context: ProjectedDocumentReadContext,
  payload: Readonly<Record<string, unknown>>,
) {
  const read: TaskProjectionReader["withSession"] = context.withReadSession ?? ((use) => use(context.projection)),
    result = read((projection) => readProjectedDocumentAtCut({ ...context, projection }, payload));
  return typeof result === "function" ? read(result) : result;
}

function readProjectedDocumentAtCut(context: ProjectedDocumentReadContext, payload: Readonly<Record<string, unknown>>) {
  const { rootDir, projection } = context,
    taskId = requiredDocSyncText(payload.taskId, "taskId"),
    requested = requiredDocSyncText(payload.path, "path"),
    view = documentReadView(payload.view),
    executionId = payload.executionId === undefined ? null : requiredDocSyncText(payload.executionId, "executionId"),
    task = requireCurrentTaskProjection(projection, taskId, "task document read"),
    packagePath = task.packagePath;
  const logical = documentPath(`${packagePath}/${requested}`),
    read = projection.readDocument(logical),
    document = read.document,
    workExplainer = requested === "artifacts/explainer.html" && task.snapshot.task?.taskClass === "work",
    binary =
      document === null ? classifyRawArtifactPath(logical) !== null : document.policyId === RAW_ARTIFACT_POLICY_ID,
    authored = context.local?.readAuthoredCopy?.(packagePath, requested, binary) ?? null,
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
    worktreeBody: authored?.body ?? null,
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
    if (
      context.withReadSession === undefined ||
      context.local?.observeExecution === undefined ||
      context.local?.leaseAcquiredRevision === undefined
    )
      return unobservable("execution_workspace_unavailable");
    const observation = context.local.observeExecution(context, task, packagePath, requested, binary, executionId);
    if ("reason" in observation) return unobservable(observation.reason);
    const leaseAcquiredRevision = context.local.leaseAcquiredRevision;
    return (nextProjection: TaskProjectionQueries) => {
      const lease = nextProjection.currentLease(taskId);
      if (
        lease === null ||
        !leaseIsEffective(lease) ||
        lease.executionId !== executionId ||
        lease.source !== "local" ||
        observation.acquiredRevision !== leaseAcquiredRevision(nextProjection, taskId, executionId)
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

  if (view === "canonical") {
    if (document === null) return unobservable("document_not_observed");
    const { cut, syncState } = canonicalCutAndSync(context, document, authored, binary, requested),
      result = observed(cut, "canonical", syncState === "unobservable" ? "unobservable" : syncState);
    return authored === null ? { ...result, unobservableReason: "authored_copy_not_observed" } : result;
  }

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

export function cutOfWorktree(row: ObservedDocumentRow, requested: string, binary: boolean): DocumentCut {
  return {
    contentKind: binary ? "binary" : "text",
    body: binary ? "" : (row.body ?? ""),
    bytes: binary ? row.bytes : null,
    blobSha256: row.blobSha256,
    size: row.size,
    mediaType: binary ? mediaTypeForBinaryPath(requested, row.mediaType) : row.mediaType,
  };
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
): { readonly cut: DocumentCut; readonly syncState: DocumentStatus.ObservedDocumentSyncState } {
  const canonicalBytes =
      binary && Number(document.size) <= TASK_DOCUMENT_INLINE_BYTES_MAX
        ? context.store.readContentBlob(document.blobSha256)
        : null,
    cut = cutOfCanonical(document, binary, canonicalBytes, requested),
    syncState: DocumentStatus.ObservedDocumentSyncState =
      authored === null ? "unobservable" : authored.blobSha256 === document.blobSha256 ? "synced" : "unsynced";
  return { cut, syncState };
}

type DocumentReadView = "default" | "canonical" | "authored-copy" | "execution";

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

function syncStateOf(
  cut: DocumentCut,
  canonicalVersion: CanonicalDocumentVersion | null,
): Exclude<DocumentStatus.ObservedDocumentSyncState, "unobservable"> {
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

function repositoryPathOf(rootDir: string, logical: string): string {
  return path
    .relative(rootDir, path.join(resolveHarnessLayout(rootDir).authoredRoot, logical))
    .split(path.sep)
    .join("/");
}

export interface ProjectedTaskDocumentListItem {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly uncommitted: boolean;
}

export interface ProjectedTaskDocumentListResult {
  readonly ok: true;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly taskId: string;
  readonly documents: readonly ProjectedTaskDocumentListItem[];
  readonly watermark: number;
  readonly sourceRevision: number;
}

export interface TaskDocumentListLocalPorts {
  readonly listWorktreeDocuments?: (packagePath: string) => readonly WorktreeDocumentRow[];
}

/** Projected documents under one task package, with paths relative to the package root.
 * Stateless callers omit `ports` and see only canonical projected rows (plus derived work explainer). */
export function listProjectedTaskDocuments(
  projection: TaskProjectionQueries,
  payload: Readonly<Record<string, unknown>>,
  ports: TaskDocumentListLocalPorts = {},
): ProjectedTaskDocumentListResult {
  const taskId = requiredDocSyncText(payload.taskId, "taskId"),
    task = requireCurrentTaskProjection(projection, taskId, "task documents list"),
    packagePath = task.packagePath;
  const prefix = `${packagePath}/`,
    basis = projection.readDocuments(prefix),
    worktree = ports.listWorktreeDocuments?.(packagePath) ?? [],
    worktreeByPath = new Map(worktree.map((row) => [row.path, row])),
    workExplainerHtml = task.snapshot.task?.taskClass === "work" ? renderWorkExplainer(projection, taskId) : null,
    documents: ProjectedTaskDocumentListItem[] = [
      ...(workExplainerHtml !== null
        ? [
            {
              path: "artifacts/explainer.html",
              blobSha256: sha256Text(workExplainerHtml),
              size: Buffer.byteLength(workExplainerHtml),
              mediaType: "text/html",
              uncommitted: false,
            },
          ]
        : []),
      ...basis.documents
        .filter((row) => row.path.startsWith(prefix))
        .filter((row) => !(workExplainerHtml !== null && row.path === `${prefix}artifacts/explainer.html`))
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
          !(workExplainerHtml !== null && row.path === "artifacts/explainer.html") &&
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

export interface CanonicalDocumentListQuery {
  readonly prefix?: string;
  readonly limit: number;
  readonly afterPath?: string;
  readonly includeHistory?: boolean;
  readonly excludeTaskPackages?: boolean;
}

/** Bounded canonical document listing (`ha doc list` cloud read surface). */
export function listCanonicalDocuments(
  projection: Pick<TaskProjectionQueries, "readDocuments">,
  query: CanonicalDocumentListQuery,
) {
  const read = projection.readDocuments(query.prefix ?? "", {
    limit: query.limit,
    ...(query.afterPath === undefined ? {} : { afterPath: query.afterPath }),
    ...(query.includeHistory === undefined ? {} : { includeHistory: query.includeHistory }),
    ...(query.excludeTaskPackages === undefined ? {} : { excludeTaskPackages: query.excludeTaskPackages }),
  });
  return {
    ok: true as const,
    status: read.status,
    documents: read.documents,
    page: read.page ?? { nextPath: null },
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}
