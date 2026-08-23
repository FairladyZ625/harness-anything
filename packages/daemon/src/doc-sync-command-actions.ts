import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CanonicalEventStore, TaskProjection } from "../../kernel/src/index.ts";
import {
  classifyTextualArtifactPath,
  documentPath,
  ledgerGitPath,
  parseDocWriteIntent,
  resolveDocRoute,
  resolveHarnessLayout,
  resolveLedgerGitLayout,
  resolveRetirableDocument,
  sha256Bytes,
  stableStringify,
  type ActorIdentity,
  type EventPublicationKillpoint,
  type WriteReceipt,
  type WriteSource,
} from "../../kernel/src/index.ts";
import { assignmentIntent, scannerSubmit } from "./doc-sync-adjudication.ts";
import { intentFromScan } from "./doc-sync-candidate-scanner.ts";
import { claimBytes, directPaths, touch } from "./doc-sync-details.ts";
import {
  artifactSource,
  docSyncError,
  gitModified,
  gitTracked,
  hasExactDocSyncActionFields,
  localProseSource,
  proof,
  rejectDocSyncAction,
  requiredDocSyncText,
} from "./doc-sync-files.ts";
import { publishDocIntent } from "./doc-sync-publication.ts";
import { readAction } from "./doc-sync-reads.ts";
import { noOp, scanDetail, scannerSettlement } from "./doc-sync-settlement.ts";
import type { FleetAssignmentScope } from "./fleet/contract.ts";

export const DOC_COMMAND_FRAME_MAX_BYTES = 256 * 1024;

export type Action = Readonly<Record<string, unknown>> & { readonly kind: string };

export interface Binding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly docWriteAllowed?: boolean;
  readonly assignmentScope?: FleetAssignmentScope;
}

export type Input = {
  readonly action: Action;
  readonly binding: Binding;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
};

export type DocSettlementReceipt = WriteReceipt & {
  readonly commitSha?: string | null;
  readonly settlement?: WriteReceipt["outcome"];
  readonly receiptId?: string;
  readonly summary?: string;
};

export type ArtifactAddReceipt = DocSettlementReceipt & {
  readonly source?: string;
  readonly destination?: string;
};

export function isDocAction(kind: string): boolean {
  return (
    kind === "doc-status" ||
    kind === "doc-dry-run" ||
    kind === "doc-submit" ||
    kind === "doc-materialize" ||
    kind === "doc-show" ||
    kind === "doc-retire"
  );
}

export async function runDocAction(input: Input): Promise<WriteReceipt> {
  if (Buffer.byteLength(JSON.stringify(input.action)) > DOC_COMMAND_FRAME_MAX_BYTES)
    throw docSyncError("invalid_command", "doc command frame exceeds the descriptor-only limit");
  if (input.action.kind === "doc-materialize") {
    if (!hasExactDocSyncActionFields(input.action, ["kind"]))
      throw docSyncError("invalid_command", "doc materialize takes no options");
    const result = input.store.materialize(),
      revision = input.store.readHead()?.revision ?? 0;
    return {
      outcome: "applied",
      opId: `materialize:${result.commitSha.sha}`,
      revision,
      evidence: `doc-materialize:${stableStringify({ changed: result.changed, conflicts: result.conflicts })}`,
      visibility: "center",
      proof: proof(revision, revision, true, true),
    };
  }
  if (input.action.kind === "doc-retire") return runDocRetire(input);
  if (input.action.kind !== "doc-submit") return readAction(input);
  const scan = localProseSource(input.binding.source) ? scannerSubmit(input) : null;
  if (scan && input.binding.docWriteAllowed === false) {
    const rejected = scanDetail(input, scan, "rbac_forbidden");
    return rejectDocSyncAction(
      `scan:${scan.baseLedgerSha.headDigest}`,
      "rbac_forbidden",
      {
        ...rejected,
        unresolvedTouches: scan.rows.map((row) => touch(row.path, "repo-write", "principal lacks repo-write")),
        nextAction: "use a repo-write principal holding the active execution lease",
      },
      "use a repo-write principal holding the active execution lease",
    );
  }
  if (scan && !scan.rows.some((row) => row.state === "eligible")) {
    const code = scan.rows
        .map((row) => row.rejectionCode)
        .find((candidate) => candidate === "lease_conflict" || candidate === "deletion_forbidden"),
      blocked = scanDetail(input, scan, code ?? "preview_blocked");
    return scan.rows.some((row) => row.state === "blocked" || row.state === "deletion")
      ? rejectDocSyncAction(
          `scan:${scan.baseLedgerSha.headDigest}`,
          code ?? "preview_blocked",
          blocked,
          blocked.nextAction,
        )
      : noOp(input, scan);
  }
  const prepared = scan ? intentFromScan(scan, input.workspaceId) : null,
    intent = prepared?.intent ?? assignmentIntent(input);
  const receipt = publishDocIntent(
    input,
    intent,
    prepared?.claims ??
      intent.changes.map((change) =>
        change.candidate === null ? null : claimBytes(input.rootDir, change.candidate.ref),
      ),
    scan?.lease ??
      (intent.executionId === null ? null : input.projection.currentLeaseForExecution(intent.executionId, input.now())),
  );
  return scan && (receipt.outcome === "applied" || receipt.outcome === "pending")
    ? scannerSettlement(input, scan, receipt)
    : receipt;
}

export function runDocRetire(input: Input): DocSettlementReceipt {
  if (!hasExactDocSyncActionFields(input.action, ["kind", "path", "reason"]))
    throw docSyncError("invalid_command", "doc retire requires path and reason");
  const reason = requiredDocSyncText(input.action.reason, "reason").trim();
  let target: ReturnType<typeof documentPath>;
  try {
    target = documentPath(requiredDocSyncText(input.action.path, "path"));
  } catch {
    throw docSyncError("invalid_command", "doc retire requires one valid doc-sync path");
  }
  if (!directPaths(input.rootDir, [target]) || !resolveDocRoute(target).allowed)
    throw docSyncError("invalid_command", "doc retire requires one valid doc-sync path");
  const read = input.projection.readDocument(target);
  if (read.watermark !== read.sourceRevision)
    throw docSyncError("projection_pending", "retry after the canonical projection catches up");
  const document = resolveRetirableDocument(input.rootDir, target, read.document, input.store.read().events);
  if (document === null) throw docSyncError("document_not_found", `canonical document does not exist: ${target}`);
  const authoredTarget = path.join(resolveHarnessLayout(input.rootDir).authoredRoot, ...target.split("/"));
  if (existsSync(authoredTarget) && sha256Bytes(readFileSync(authoredTarget)) !== document.blobSha256)
    throw docSyncError(
      "retirement_local_modified",
      `restore or sync the locally modified document before retiring it: ${target}`,
    );
  const intent = parseDocWriteIntent(
    {
      schema: "doc-write-intent/v1",
      executionId: null,
      baseLedgerSha: input.store.currentCut(),
      changes: [
        {
          path: target,
          baseBlobSha256: document.blobSha256,
          policyId: document.policyId,
          candidate: null,
        },
      ],
    },
    input.workspaceId,
  );
  return publishDocIntent(input, intent, [null], null, reason);
}

export function runArtifactAdd(input: Input): ArtifactAddReceipt {
  const taskId = requiredDocSyncText(input.action.taskId, "taskId"),
    sourceValue = requiredDocSyncText(input.action.source, "source"),
    destinationValue = requiredDocSyncText(input.action.destination, "destination");
  if (!hasExactDocSyncActionFields(input.action, ["kind", "taskId", "source", "destination"]))
    throw docSyncError("invalid_command", "task artifact add requires taskId, source, and destination");
  const task = input.projection.read(taskId);
  if (task.watermark !== task.sourceRevision || !task.packagePath || !task.snapshot.task)
    throw docSyncError("content_not_ready", `Task ${taskId} is not ready for artifact add`);
  const relativeDestination = destinationValue.startsWith("artifacts/")
    ? destinationValue
    : `artifacts/${destinationValue}`;
  let destination: ReturnType<typeof documentPath>;
  try {
    destination = documentPath(`${task.packagePath}/${relativeDestination}`);
  } catch {
    throw docSyncError(
      "invalid_artifact_path",
      "destination must be a UTF-8 textual artifact path under the current task artifacts/ directory",
    );
  }
  const classification = classifyTextualArtifactPath(destination);
  if (
    !destination.startsWith(`${task.packagePath}/artifacts/`) ||
    classification === null ||
    !directPaths(input.rootDir, [destination])
  )
    throw docSyncError(
      "invalid_artifact_path",
      "destination must be a UTF-8 textual artifact path under the current task artifacts/ directory",
    );
  const layout = resolveHarnessLayout(input.rootDir),
    ledger = resolveLedgerGitLayout(input.rootDir),
    source = artifactSource(input, sourceValue),
    authoredTarget = path.join(layout.authoredRoot, ...destination.split("/")),
    gitTarget = ledgerGitPath(ledger, destination),
    projected = input.projection.readDocument(destination),
    tracked = gitTracked(ledger.rootDir, gitTarget);
  const projectedEdit =
    projected.document !== null &&
    existsSync(authoredTarget) &&
    sha256Bytes(readFileSync(authoredTarget)) !== projected.document.blobSha256;
  if (projectedEdit || (tracked && gitModified(ledger.rootDir, gitTarget)))
    throw docSyncError(
      "artifact_tracked_edit",
      `destination is a tracked edit; use ha doc sync --submit --path ${destination}`,
    );
  if (tracked || existsSync(authoredTarget) || projected.document !== null)
    throw docSyncError("artifact_collision", `artifact destination already exists: ${destination}`);
  if (projected.watermark !== projected.sourceRevision)
    return {
      outcome: "indeterminate",
      opId: `artifact:${input.store.currentCut().headDigest}`,
      code: "projection_pending",
      origin: "N/A",
      nextAction: "retry after the canonical projection catches up",
    };
  const bytes = readFileSync(source.absolute);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw docSyncError("artifact_invalid_utf8", "artifact source must be valid UTF-8");
  }
  const sha = sha256Bytes(bytes),
    base = input.store.currentCut(),
    lease = input.projection.currentLease(taskId, input.now()),
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: lease?.executionId ?? null,
        baseLedgerSha: base,
        changes: [
          {
            path: destination,
            baseBlobSha256: null,
            policyId: classification.policyId,
            candidate: {
              ref: `doc-sync-claims/${sha}`,
              sha256: sha,
              size: bytes.byteLength,
              mediaType: classification.mediaType,
            },
          },
        ],
      },
      input.workspaceId,
    ),
    receipt = publishDocIntent(input, intent, [bytes], lease);
  return receipt.outcome === "applied" || receipt.outcome === "pending"
    ? { ...receipt, source: source.relative, destination }
    : receipt;
}
