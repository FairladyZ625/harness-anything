import { consumeKnownError } from "../error-consumption.ts";
import { sha256Bytes, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { type PortableDocumentPath } from "../layout/portable-path.ts";
import { isSameExecution } from "./actor-domain-services.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "./artifact-text-classification.ts";
import {
  additiveProof,
  decisionDocumentPath,
  opaqueProof,
  touch,
} from "./doc-sync-regions.ts";
import {
  CurrentDocEventV1,
  DOC_POLICY_ID,
  DocContentBlob,
  DocEventChange,
  DocEventMutation,
  DocEventV1,
  DocPolicyUpgrade,
  docRouteRegistry,
  DocSyncContractError,
  DocWriteDecision,
  DocWriteDecisionInput,
} from "./doc-sync-types.ts";
import {
  policyMatchesClaim,
  sameWriteChannel,
  taskArtifactPath,
  taskFromPath,
  validDocEventChange,
} from "./doc-sync-validation.ts";
import { MIGRATION_DOCUMENT_POLICY_ID } from "./migration-import-event.ts";
import type {
  DocSyncDifference,
  DocSyncUnresolvedTouch,
} from "./receipt-domain-registry.ts";
import {
  isTaskBoundRuntimeWriter,
  runtimeSessionIdFromActor,
} from "./task-bound-runtime-authority.ts";
import {
  freezeDeclaredWritePlan,
  isFrozenWritePlan,
  isRecord,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";

export function decideDocWrite(input: DocWriteDecisionInput): DocWriteDecision {
  const paths = input.intent.changes.map((change, index) => ({
    path: change.path,
    baseBlobSha256: change.baseBlobSha256,
    currentBlobSha256: input.documents[index]?.blobSha256 ?? null,
    candidateBlobSha256: change.candidate?.sha256 ?? null,
  }));
  const holder =
    input.lease === null
      ? null
      : {
          taskId: input.lease.taskId,
          executionId: input.lease.executionId,
          personId: input.lease.actor.principal.personId,
          executorId: input.lease.actor.executor?.id ?? null,
          source: input.lease.source,
          expiresAt: input.lease.expiresAt,
          version: input.lease.version,
        };
  const differences: DocSyncDifference[] = [],
    unresolvedTouches: DocSyncUnresolvedTouch[] = [],
    deletions: { path: string; baseBlobSha256: string; source: "intent" }[] =
      [],
    changes: DocEventMutation[] = [],
    blobs: DocContentBlob[] = [];
  const reject = (code: string, nextAction: string): DocWriteDecision => ({
    accepted: false,
    code,
    detail: {
      kind: "doc_sync",
      code,
      baseLedgerSha: input.intent.baseLedgerSha,
      currentLedgerSha: input.currentLedgerSha,
      paths,
      holder,
      differences,
      unresolvedTouches,
      deletions,
      nextAction,
    },
  });
  const retirementReason = input.retirementReason?.trim();
  if (
    retirementReason !== undefined &&
    (!retirementReason ||
      input.intent.changes.length !== 1 ||
      input.intent.changes[0]?.candidate !== null ||
      input.intent.executionId !== null)
  )
    return reject(
      "invalid_retirement",
      "retire exactly one canonical document with a non-empty reason outside an execution lease",
    );
  const runtimeActor = runtimeSessionIdFromActor(input.actor) !== null,
    directHolder =
      input.lease !== null &&
      isSameExecution(input.lease.actor, input.actor) &&
      sameWriteChannel(input.lease.source, input.source),
    runtimeWorker =
      input.lease !== null &&
      input.runtimeBinding !== undefined &&
      isTaskBoundRuntimeWriter(
        input.lease,
        input.actor,
        input.source,
        input.runtimeBinding,
      );
  if (
    input.intent.executionId === null
      ? input.lease !== null || runtimeActor
      : input.lease === null ||
        input.lease.phase !== "held" ||
        input.lease.executionId !== input.intent.executionId ||
        (!directHolder && !runtimeWorker)
  )
    return reject(
      "lease_conflict",
      "refresh status and submit through the matching execution or repository prose channel",
    );
  if (
    stableStringify(input.intent.baseLedgerSha) !==
    stableStringify(input.currentLedgerSha)
  )
    return reject(
      "base_ledger_changed",
      "run ha doc status, then ha doc sync --dry-run --path <path> for the fresh base and resubmit with a new opId",
    );
  for (const [index, change] of input.intent.changes.entries()) {
    const current = input.documents[index] ?? null,
      route = resolveDocRoute(change.path),
      task =
        input.resolvedTaskIds === undefined
          ? taskFromPath(change.path)
          : (input.resolvedTaskIds[index] ?? null);
    if (
      runtimeWorker &&
      !directHolder &&
      (task !== input.runtimeBinding!.taskId || !taskArtifactPath(change.path))
    )
      unresolvedTouches.push(
        touch(
          change.path,
          null,
          task !== input.runtimeBinding!.taskId
            ? "target task does not match the live runtime binding"
            : "task-bound runtime writes are limited to the assigned task artifacts subtree",
          "task-bound-runtime-artifacts",
        ),
      );
    if (task !== null && input.lease !== null && task !== input.lease.taskId)
      unresolvedTouches.push(
        touch(
          change.path,
          null,
          "target task does not match the execution lease",
          "matching-task-lease",
        ),
      );
    if (!route.allowed)
      unresolvedTouches.push(
        touch(
          change.path,
          null,
          "path is owned by a typed route",
          route.requiredRoute,
        ),
      );
    if (change.baseBlobSha256 !== (current?.blobSha256 ?? null))
      return reject(
        "base_blob_changed",
        "run ha doc status, then ha doc sync --dry-run --path <path> for the changed document and resubmit with a new opId",
      );
    const policyUpgrade: DocPolicyUpgrade | null =
      change.policyId === DOC_POLICY_ID &&
      current !== null &&
      current.policyId === MIGRATION_DOCUMENT_POLICY_ID
        ? { from: MIGRATION_DOCUMENT_POLICY_ID, to: DOC_POLICY_ID }
        : null;
    if (
      (change.candidate !== null &&
        !policyMatchesClaim(change.policyId, change.candidate)) ||
      (current !== null &&
        change.policyId !== OPAQUE_TEXTUAL_POLICY_ID &&
        policyUpgrade === null &&
        current.policyId !== change.policyId)
    )
      return reject(
        "semantic_policy_changed",
        "refresh status after the content policy change",
      );
    if (change.candidate === null) {
      if (change.baseBlobSha256 !== null) {
        deletions.push({
          path: change.path,
          baseBlobSha256: change.baseBlobSha256,
          source: "intent",
        });
        if (retirementReason !== undefined)
          changes.push({
            path: change.path,
            baseBlobSha256: change.baseBlobSha256,
            candidate: null,
            policyId: change.policyId,
            regionProofs: [],
          });
      }
      continue;
    }
    if (current === null && decisionDocumentPath(change.path)) {
      unresolvedTouches.push(
        touch(
          change.path,
          null,
          "Decision documents must be proposed through the typed route",
          "ha decision --help",
        ),
      );
      continue;
    }
    const claim = input.claims[index];
    if (
      claim === null ||
      claim.byteLength !== change.candidate.size ||
      sha256Bytes(claim ?? new Uint8Array()) !== change.candidate.sha256
    )
      return reject(
        "content_claim_mismatch",
        "upload a claim whose hash and size match the descriptor",
      );
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(claim);
    } catch (error) {
      consumeKnownError(error);
      unresolvedTouches.push(
        touch(
          change.path,
          null,
          "claim is not valid UTF-8",
          "typed-binary-content",
        ),
      );
      continue;
    }
    if (change.policyId !== OPAQUE_TEXTUAL_POLICY_ID && body.includes("\r")) {
      unresolvedTouches.push(
        touch(
          change.path,
          null,
          "claim is not canonical LF text",
          "canonical-utf8-prose",
        ),
      );
      continue;
    }
    const semantic =
      change.policyId === OPAQUE_TEXTUAL_POLICY_ID
        ? opaqueProof()
        : additiveProof(
            change.path,
            current?.body ?? "",
            body,
            change.candidate.mediaType,
            current === null,
          );
    differences.push(...semantic.differences);
    unresolvedTouches.push(...semantic.unresolved);
    changes.push({
      path: change.path,
      baseBlobSha256: change.baseBlobSha256,
      candidate: {
        sha256: change.candidate.sha256,
        size: change.candidate.size,
        mediaType: change.candidate.mediaType,
      },
      policyId: change.policyId,
      regionProofs: semantic.proofs,
      ...(policyUpgrade ? { policyUpgrade } : {}),
    });
    blobs.push({
      sha256: change.candidate.sha256,
      size: change.candidate.size,
      mediaType: change.candidate.mediaType,
      body,
    });
  }
  if (deletions.length && retirementReason === undefined)
    return reject(
      "deletion_forbidden",
      "run ha doc retire --path <path> --reason <reason> for an intentional retirement, or restore the document",
    );
  if (retirementReason !== undefined && deletions.length !== 1)
    return reject(
      "document_not_found",
      "retire a document that still exists in the canonical projection",
    );
  if (unresolvedTouches.length)
    return reject(
      "unresolved_touch",
      unresolvedTouches.some(
        ({ reason }) => reason === "claim is not canonical LF text",
      )
        ? "convert the claim to LF line endings, then resubmit the same document with a new opId"
        : "resolve denied, ambiguous, heading, or machine-owned touches before resubmitting",
    );
  const event: CurrentDocEventV1 = {
    schema: "doc-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "documents_written",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      executionId: input.intent.executionId,
      baseLedgerSha: input.intent.baseLedgerSha,
      changes,
      ...(retirementReason === undefined ? {} : { retirementReason }),
    },
  };
  return { accepted: true, event, blobs, plan: docSyncWritePlan(event) };
}

export function docSyncWritePlan(
  event: DocEventV1,
): FrozenWritePlan<"DocSyncSubmit"> {
  const targets: WriteTarget[] = [
    {
      kind: "event_file",
      path: eventObjectTarget(event.opId),
      operation: "create",
    },
    {
      kind: "event_head",
      path: "harness/events/head.json",
      operation: "replace",
    },
  ];
  for (const change of event.payload.changes)
    if (change.candidate === null)
      targets.push(
        {
          kind: "authored_file_delete",
          path: change.path,
          operation: "delete",
          baseSha256: change.baseBlobSha256!,
        },
        {
          kind: "projection_invalidation",
          projection: "document/v1",
          key: change.path,
        },
      );
    else
      targets.push(
        {
          kind: "authored_file",
          path: change.path,
          operation: "replace",
          sha256: change.candidate.sha256,
          size: change.candidate.size,
          mediaType: change.candidate.mediaType,
        },
        {
          kind: "projection_invalidation",
          projection: "document/v1",
          key: change.path,
        },
        {
          kind: "content_blob",
          sha256: change.candidate.sha256,
          size: change.candidate.size,
          mediaType: change.candidate.mediaType,
        },
      );
  return freezeDeclaredWritePlan({ commandType: "DocSyncSubmit", targets }, [
    "DocSyncSubmit",
  ]);
}

export function assertDocSyncWritePlan(
  event: DocEventV1,
  plan: FrozenWritePlan<"DocSyncSubmit"> | undefined,
): asserts plan is FrozenWritePlan<"DocSyncSubmit"> {
  const expected = docSyncWritePlan(event),
    shape = (candidate: FrozenWritePlan<"DocSyncSubmit">) =>
      stableStringify({
        commandType: candidate.commandType,
        targets: candidate.targets.map(stableStringify).sort(),
      });
  if (
    plan === undefined ||
    !isFrozenWritePlan(plan) ||
    shape(plan) !== shape(expected)
  )
    throw new DocSyncContractError(
      "doc write plan must exactly declare event, head, projection, and content targets",
    );
}

export function resolveDocRoute(path: PortableDocumentPath): {
  readonly allowed: boolean;
  readonly requiredRoute: string;
} {
  const taskFile = /^tasks\/[^/]+\/(.+)$/u.exec(path)?.[1],
    taskRoute =
      taskFile === "progress.md"
        ? "task-progress-append"
        : taskFile === "INDEX.md"
          ? "task-lifecycle"
          : taskFile === "task-contract.json"
            ? "task-contract-upgrade"
            : taskFile === "facts.md"
              ? "ha fact record --help"
              : taskFile === "code-doc-anchors.json"
                ? "task-code-doc-reconcile"
                : taskFile?.startsWith("executions/")
                  ? "task-lifecycle"
                  : taskFile?.startsWith("reviews/")
                    ? "task-review-execution"
                    : null;
  if (taskRoute) return { allowed: false, requiredRoute: taskRoute };
  const denied = docRouteRegistry.find(
    (route) => path === route.prefix || path.startsWith(route.prefix),
  );
  return denied
    ? { allowed: false, requiredRoute: denied.requiredRoute }
    : { allowed: true, requiredRoute: "doc-sync" };
}

export function verifyDocEventChange(
  change: DocEventChange,
  baseBody: string,
  candidateBody: string,
): boolean {
  const compiled =
    change.policyId === OPAQUE_TEXTUAL_POLICY_ID
      ? opaqueProof()
      : additiveProof(
          change.path,
          baseBody,
          candidateBody,
          change.candidate.mediaType,
          change.baseBlobSha256 === null,
        );
  return (
    compiled.unresolved.length === 0 &&
    stableStringify(compiled.proofs) === stableStringify(change.regionProofs)
  );
}

export function isValidDocEventChange(
  value: unknown,
  allowUnknownFields = false,
): value is DocEventChange {
  return (
    validDocEventChange(value, allowUnknownFields) &&
    isRecord(value) &&
    value.candidate !== null
  );
}
