import { lstatSync } from "node:fs";
import path from "node:path";
import { writeFileDurably } from "@harness-anything/storage";
import {
  parseDocWriteIntent,
  resolveHarnessLayout,
  runtimeSessionIdFromActor,
  sha256Bytes,
  sha256Text,
  upsertCloseoutSubmissionFacts,
  type DocEventChange,
  type SubmissionV1,
  type TaskProjection,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellBinding, RepoCellOperationalContext } from "./repo-cell-types.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";
import { adjudicateDocIntent, rejectDocSyncAction } from "./doc-sync-actions.ts";
import { publishDocIntent } from "./doc-sync-publication.ts";
import { locateTaskTransitionDocument } from "./transition-document-access.ts";
import { worktreeAuthoredRelative } from "./worktree-setup.ts";

function closeoutDocBinding(
  binding: RepoCellBinding,
  activeLease: ReturnType<TaskProjection["currentLease"]>,
): RepoCellBinding {
  return activeLease === null && runtimeSessionIdFromActor(binding.actor) !== null
    ? { ...binding, actor: { principal: binding.actor.principal, executor: null } }
    : binding;
}

function writeMatchingCloseoutDiskCopy(
  root: string,
  logicalPath: string,
  expectedSha256: string,
  enriched: string,
): void {
  const target = path.join(root, ...logicalPath.split("/")),
    stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) return;
  const onDisk = new TextDecoder("utf-8", { fatal: true }).decode(readAuthoredDocumentBytes(root, logicalPath));
  if (sha256Text(onDisk.replace(/\r\n?/gu, "\n")) !== expectedSha256) return;
  writeFileDurably(target, enriched);
}

export interface PreparedCloseoutFacts {
  readonly path: string;
  readonly baseBlobSha256: string;
  readonly policyId: string;
  readonly mediaType: string;
  readonly enriched: string;
  readonly enrichedBytes: Uint8Array;
}

export type PrepareCloseoutFactsResult =
  | { readonly ok: true; readonly plan: PreparedCloseoutFacts | null }
  | { readonly ok: false; readonly error: Error };

/**
 * Pure pre-validation of closeout delivery-facts rendering before execution_submitted commits,
 * so malformed closeout-facts markers still fail closed without emitting any event.
 */
export function prepareSubmittedCloseoutFacts(
  cell: RepoCellOperationalContext,
  taskId: string,
  submission: SubmissionV1,
): PrepareCloseoutFactsResult {
  const closeout = locateTaskTransitionDocument({ projection: cell.projection, taskId, slot: "task.closeout" });
  if (closeout.path === null) return { ok: true, plan: null };
  const currentDoc = cell.projection.readDocument(closeout.path).document;
  if (!currentDoc) return { ok: true, plan: null };
  let enriched: string;
  try {
    enriched = upsertCloseoutSubmissionFacts(currentDoc.body, submission);
  } catch (error) {
    return {
      ok: false,
      error: cell.cellCodedError("invalid_submission", error instanceof Error ? error.message : String(error)),
    };
  }
  if (enriched === currentDoc.body) return { ok: true, plan: null };
  return {
    ok: true,
    plan: {
      path: closeout.path,
      baseBlobSha256: currentDoc.blobSha256,
      policyId: currentDoc.policyId,
      mediaType: currentDoc.mediaType,
      enriched,
      enrichedBytes: Buffer.from(enriched, "utf8"),
    },
  };
}

/**
 * Publish the managed delivery-facts block in closeout.md via doc-event/v1 (preserve: false)
 * immediately before execution_submitted commits so disk, projection, and Git follower agree
 * byte-for-byte, execution_submitted remains the final event of task-submit, and waiting on the
 * submit receipt covers both closeout.md and execution_submitted.
 */
export function publishSubmittedCloseoutFacts(
  cell: RepoCellOperationalContext,
  taskId: string,
  binding: RepoCellBinding,
  taskRoot: string | null,
  activeLease: ReturnType<TaskProjection["currentLease"]>,
  plan: PreparedCloseoutFacts,
): WriteReceiptDraft {
  const sha = sha256Bytes(plan.enrichedBytes),
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: activeLease?.executionId ?? null,
        baseLedgerSha: cell.store.currentCut(),
        changes: [
          {
            path: plan.path,
            baseBlobSha256: plan.baseBlobSha256,
            policyId: plan.policyId,
            candidate: {
              ref: `doc-sync-claims/${sha}`,
              sha256: sha,
              size: plan.enrichedBytes.byteLength,
              mediaType: plan.mediaType,
            },
          },
        ],
      },
      cell.input.repoId,
    ),
    receipt = publishDocIntent(
      {
        action: { kind: "doc-submit", taskId, paths: [plan.path] },
        binding: closeoutDocBinding(binding, activeLease),
        rootDir: cell.rootDir,
        workspaceId: cell.input.repoId,
        store: cell.store,
        projection: cell.projection,
        now: cell.now,
        taskDocumentChannel: "task-command",
        ...(activeLease === null ? { unleasedTaskCommandId: taskId } : {}),
      } as Parameters<typeof publishDocIntent>[0],
      intent,
      [plan.enrichedBytes],
      activeLease,
    );
  if (receipt.outcome === "applied") {
    const layout = resolveHarnessLayout(cell.rootDir);
    writeMatchingCloseoutDiskCopy(layout.authoredRoot, plan.path, plan.baseBlobSha256, plan.enriched);
    if (taskRoot !== null && (typeof binding.source !== "object" || binding.source.kind !== "node"))
      writeMatchingCloseoutDiskCopy(
        path.join(taskRoot, worktreeAuthoredRelative(layout)),
        plan.path,
        plan.baseBlobSha256,
        plan.enriched,
      );
  }
  return receipt;
}

export interface CarriedTextBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly body: string;
}

export type EnrichCarriedCloseoutResult =
  | {
      readonly ok: true;
      readonly changes: readonly DocEventChange[];
      readonly blobs: readonly CarriedTextBlob[];
    }
  | { readonly ok: false; readonly invalidError: Error }
  | { readonly ok: false; readonly rejected: WriteReceiptDraft };

/**
 * Enrich closeout.md inside carried document claims for an edge task-submit so the
 * existing v5 carriedDocumentClaims channel carries the exact managed delivery-facts block.
 */
export function enrichCarriedCloseoutFacts(input: {
  readonly cell: RepoCellOperationalContext;
  readonly taskId: string;
  readonly opId: string;
  readonly docOpId: string;
  readonly binding: RepoCellBinding;
  readonly executionId: string | null;
  readonly activeLease: ReturnType<TaskProjection["currentLease"]>;
  readonly unleasedTaskCommandId?: string;
  readonly submission: SubmissionV1;
  readonly bodyOverrides: ReadonlyMap<string, string>;
  readonly changes: readonly DocEventChange[];
  readonly blobs: readonly CarriedTextBlob[];
}): EnrichCarriedCloseoutResult {
  const {
      cell,
      taskId,
      opId,
      docOpId,
      binding,
      executionId,
      activeLease,
      unleasedTaskCommandId,
      submission,
      bodyOverrides,
    } = input,
    closeout = locateTaskTransitionDocument({ projection: cell.projection, taskId, slot: "task.closeout" });
  if (closeout.path === null) return { ok: true, changes: input.changes, blobs: input.blobs };
  const carriedIndex = input.changes.findIndex((change) => change.path === closeout.path),
    currentDoc = cell.projection.readDocument(closeout.path).document,
    originalBody = carriedIndex >= 0 ? bodyOverrides.get(closeout.path) : (currentDoc?.body ?? undefined);
  if (originalBody === undefined) return { ok: true, changes: input.changes, blobs: input.blobs };
  let enriched: string;
  try {
    enriched = upsertCloseoutSubmissionFacts(originalBody, submission);
  } catch (error) {
    return {
      ok: false,
      invalidError: cell.cellCodedError("invalid_submission", error instanceof Error ? error.message : String(error)),
    };
  }
  if (enriched === originalBody) return { ok: true, changes: input.changes, blobs: input.blobs };
  const existingChange = carriedIndex >= 0 ? input.changes[carriedIndex]! : null,
    enrichedBytes = Buffer.from(enriched, "utf8"),
    enrichedSha = sha256Bytes(enrichedBytes),
    closeoutIntent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId,
        baseLedgerSha: cell.store.currentCut(),
        changes: [
          {
            path: closeout.path,
            baseBlobSha256: existingChange ? existingChange.baseBlobSha256 : (currentDoc?.blobSha256 ?? null),
            policyId: existingChange
              ? existingChange.policyId
              : (currentDoc?.policyId ?? "markdown-body-replaceable/v1"),
            candidate: {
              ref: `doc-sync-claims/${enrichedSha}`,
              sha256: enrichedSha,
              size: enrichedBytes.byteLength,
              mediaType: existingChange?.candidate?.mediaType ?? currentDoc?.mediaType ?? "text/markdown",
            },
          },
        ],
      },
      cell.input.repoId,
    ),
    adjudication = adjudicateDocIntent(
      {
        binding: closeoutDocBinding(binding, activeLease),
        workspaceId: cell.input.repoId,
        rootDir: cell.rootDir,
        store: cell.store,
        projection: cell.projection,
        now: cell.now,
        taskDocumentChannel: "task-command",
        taskId,
        ...(unleasedTaskCommandId === undefined ? {} : { unleasedTaskCommandId }),
      },
      closeoutIntent,
      [enrichedBytes],
      activeLease,
      `${docOpId}:closeout-facts`,
    );
  if (!adjudication.accepted)
    return {
      ok: false,
      rejected: {
        ...rejectDocSyncAction(opId, adjudication.code, adjudication.detail),
        authorizationDecision: adjudication.authorizationDecision,
        taskId,
        docSync: {
          outcome: "not_applied",
          code: adjudication.code,
          transition: "blocked",
        },
      } as WriteReceiptDraft,
    };
  const enrichedChange = adjudication.decision.event.payload.changes[0],
    enrichedBlob = adjudication.decision.blobs[0];
  if (!enrichedChange || enrichedChange.candidate === null || !enrichedBlob || typeof enrichedBlob.body !== "string")
    throw cell.cellCodedError("invalid_command", "task-carried documents must be UTF-8 text");
  const nextChanges: readonly DocEventChange[] =
      carriedIndex >= 0
        ? input.changes.map((change, index) => (index === carriedIndex ? enrichedChange : change))
        : [...input.changes, enrichedChange],
    retainedShas = new Set(nextChanges.map((change) => change.candidate.sha256)),
    blobsBySha = new Map(
      input.blobs.filter((blob) => retainedShas.has(blob.sha256)).map((blob) => [blob.sha256, blob] as const),
    );
  blobsBySha.set(enrichedBlob.sha256, { ...enrichedBlob, body: enrichedBlob.body });
  return { ok: true, changes: nextChanges, blobs: [...blobsBySha.values()] };
}
