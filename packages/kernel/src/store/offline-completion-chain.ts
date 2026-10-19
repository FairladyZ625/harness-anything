import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { submissionDigest, submissionId, type ExecutionV1, type SubmissionV1 } from "../domain/execution.ts";
import { reviewDigest, type ReviewV1, type ReviewConsentV1, type ReviewDispositionV1 } from "../domain/review.ts";
import type { TaskV2 } from "../domain/task.ts";
import type { FrozenCompletionContract, FrozenGateRequirement } from "../domain/completion-contract.ts";
import type { CompletionGateWitnessV1 } from "../domain/completion-gate-witness.ts";
import { effectiveCloseoutGates, type CloseoutSettingsV1 } from "../domain/settings-closeout.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";
import type { ConvertedCompletionSnapshot } from "./offline-completion-snapshots.ts";

interface ContentClaim {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly path?: string;
}
interface HistoricalPayload extends Record<string, unknown> {
  readonly task?: TaskV2;
  readonly execution?: ExecutionV1;
  readonly review?: ReviewV1;
  readonly consent?: ReviewConsentV1;
  readonly disposition?: ReviewDispositionV1;
  readonly witness?: CompletionGateWitnessV1;
  readonly documentClaims?: readonly ContentClaim[];
  readonly initialDocumentClaims?: readonly ContentClaim[];
  readonly taskContractClaim?: ContentClaim;
  readonly presetSnapshotClaim?: ContentClaim & { readonly digest: string };
  readonly previousDigest?: string;
  readonly supersedesSubmissionId?: string;
}

/**
 * One mapper per immutable source cut. Keys include entity/execution/iteration and old content
 * identity; prose, opaque receipt ids, and unrelated digests are never searched and replaced.
 */
export function makeOfflineCompletionChain(input: {
  readonly generation: 1 | 2;
  readonly snapshots: ReadonlyMap<string, ConvertedCompletionSnapshot>;
  readonly missingSnapshots: ReadonlySet<string>;
  readonly readContent: (sha256: string) => Uint8Array | null;
}) {
  const submissions = new Map<string, SubmissionV1>(),
    contracts = new Map<string, FrozenCompletionContract>(),
    reviews = new Map<string, ReviewV1>(),
    gaps = new Map<string, NonNullable<TaskV2["presetSnapshotGap"]>>();
  let closeout: CloseoutSettingsV1 = { profile: "standard" };
  const snapshotDigest = (old: string) => {
    const converted = input.snapshots.get(old);
    if (!converted && input.missingSnapshots.has(old)) return old as `sha256:${string}`;
    if (!converted)
      throw new Error(`snapshot ${old} has no accepted content claim or inventoried historical gap in the source cut`);
    return converted.claim.digest;
  };
  const executionKey = (execution: ExecutionV1) =>
    stableStringify([execution.taskId, execution.executionId, execution.iteration]);
  const cutKey = (execution: ExecutionV1, digest: string) => stableStringify([executionKey(execution), digest]);
  function mapSubmission(event: CanonicalEventV1, execution: ExecutionV1, task: TaskV2): SubmissionV1 {
    const original = execution.submission!,
      key = cutKey(execution, submissionDigest(original)),
      existing = submissions.get(key);
    if (existing) return existing;
    const identity = executionKey(execution);
    let contract = contracts.get(identity);
    if (!contract) {
      const previous = original.completionContract,
        requirements =
          previous?.gates ?? task.completionGateIds.map((gateId) => ({ gateId, appliesTo: "code" as const }));
      const gates: FrozenGateRequirement[] = requirements.map((requirement) => ({
        ...requirement,
        witness: {
          kind: "historical",
          adapterId: null,
          adapterOptions: {},
          acceptedDefinition:
            "witness" in requirement ? (requirement.witness as unknown as Record<string, unknown>) : null,
        },
      }));
      if (!task.presetSnapshotDigest) throw new Error(`submitted task ${task.taskId} has no historical snapshot`);
      contract = {
        historicalAcceptance: {
          sourceGeneration: input.generation,
          sourceRevision: event.workspaceRevision,
          ...(input.missingSnapshots.has(task.presetSnapshotDigest) ? { snapshotGap: true as const } : {}),
        },
        presetSnapshotDigest: snapshotDigest(task.presetSnapshotDigest),
        gates,
        closeoutGates:
          previous?.closeoutGates ?? effectiveCloseoutGates(closeout, task.completionGateIds, task.closeoutOverrides),
        ...(previous?.reviewer ? { reviewer: previous.reviewer } : {}),
      };
      contracts.set(identity, contract);
    }
    const current = { ...original, completionContract: contract };
    submissions.set(key, current);
    return current;
  }
  function mapPin(execution: ExecutionV1, old: string): `sha256:${string}` {
    const mapped = submissions.get(cutKey(execution, old));
    if (!mapped) throw new Error(`submission reference ${execution.executionId}/${old} has no preceding accepted cut`);
    return submissionDigest(mapped);
  }
  function mapReview(original: ReviewV1, execution: ExecutionV1): ReviewV1 {
    const key = stableStringify([original.taskId, original.reviewId, reviewDigest(original)]),
      existing = reviews.get(key);
    if (existing) return existing;
    const oldPin = original.submissionDigest ?? submissionDigest(execution.submission!);
    // The carrier fixes the missing legacy pin at this review's acceptance, never a later/latest cut.
    if (
      original.executionId !== execution.executionId ||
      original.iteration !== execution.iteration ||
      original.commitSha !== execution.submission!.commitSha
    )
      throw new Error(`review ${original.reviewId} does not bind its accepted execution carrier`);
    const current = { ...original, submissionDigest: mapPin(execution, oldPin) };
    reviews.set(key, current);
    return current;
  }
  function mapContractClaim(
    claim: ContentClaim,
    oldDigest: string,
    task: TaskV2,
    blobs: CanonicalContentBlob[],
  ): ContentClaim {
    const bytes = input.readContent(claim.sha256);
    if (!bytes) throw new Error(`task contract content ${claim.sha256} is absent`);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (body.presetSnapshotDigest !== oldDigest)
      throw new Error(`task contract ${claim.path} does not bind its event snapshot`);
    const serialized = `${JSON.stringify(
        {
          ...body,
          presetSnapshotDigest: task.presetSnapshotDigest,
          ...(task.presetSnapshotGap ? { presetSnapshotGap: task.presetSnapshotGap } : {}),
        },
        null,
        2,
      )}\n`,
      sha256 = sha256Text(serialized),
      size = Buffer.byteLength(serialized);
    blobs.push({ sha256, size, mediaType: claim.mediaType, body: serialized });
    return { ...claim, sha256, size };
  }
  return {
    convert(event: CanonicalEventV1): {
      readonly event: CanonicalEventV1;
      readonly blobs: readonly CanonicalContentBlob[];
    } {
      const original = event.payload as HistoricalPayload,
        blobs: CanonicalContentBlob[] = [];
      if (event.schema === "settings-event/v1") {
        const settings = original.settings as { readonly closeout?: CloseoutSettingsV1 };
        closeout = settings.closeout ?? { profile: "standard" };
      }
      if (!original.task) return { event, blobs };
      let payload: HistoricalPayload = { ...original };
      const oldSnapshot = original.task.presetSnapshotDigest;
      if (oldSnapshot && input.missingSnapshots.has(oldSnapshot) && !gaps.has(oldSnapshot))
        gaps.set(oldSnapshot, {
          reason: "snapshot-bytes-unavailable",
          sourceGeneration: input.generation,
          sourceRevision: event.workspaceRevision,
        });
      const task = oldSnapshot
        ? {
            ...original.task,
            presetSnapshotDigest: snapshotDigest(oldSnapshot),
            ...(gaps.has(oldSnapshot) ? { presetSnapshotGap: gaps.get(oldSnapshot)! } : {}),
          }
        : original.task;
      payload = { ...payload, task };
      if (original.presetSnapshotClaim) {
        const converted = input.snapshots.get(original.presetSnapshotClaim.digest)!;
        payload = { ...payload, presetSnapshotClaim: converted.claim };
        blobs.push(converted.blob);
      }
      if (original.previousDigest) {
        const previousDigest = snapshotDigest(original.previousDigest);
        payload = {
          ...payload,
          previousDigest,
          ...(previousDigest === task.presetSnapshotDigest
            ? { historicalAcceptance: { sourceGeneration: input.generation, sourceRevision: event.workspaceRevision } }
            : {}),
        };
      }
      if (original.initialDocumentClaims && oldSnapshot)
        payload = {
          ...payload,
          initialDocumentClaims: original.initialDocumentClaims.map((claim) =>
            claim.path?.endsWith("/task-contract.json") ? mapContractClaim(claim, oldSnapshot, task, blobs) : claim,
          ),
        };
      if (original.taskContractClaim && oldSnapshot)
        payload = {
          ...payload,
          taskContractClaim: mapContractClaim(original.taskContractClaim, oldSnapshot, task, blobs),
        };
      if (original.documentClaims && oldSnapshot)
        payload = {
          ...payload,
          documentClaims: original.documentClaims.map((claim) =>
            claim.path?.endsWith("/task-contract.json") ? mapContractClaim(claim, oldSnapshot, task, blobs) : claim,
          ),
        };
      const execution = original.execution;
      if (execution?.schema === "execution/v1") {
        const submission = execution.submission ? mapSubmission(event, execution, original.task) : null;
        payload = { ...payload, execution: { ...execution, gateRuns: [], submission } };
        if (original.supersedesSubmissionId)
          payload = {
            ...payload,
            supersedesSubmissionId: `submission:${mapPin(execution, original.supersedesSubmissionId.slice("submission:".length))}`,
          };
        if (original.review) payload = { ...payload, review: mapReview(original.review, execution) };
        if (original.consent) {
          if (
            !original.review ||
            original.consent.reviewDigest !== reviewDigest(original.review) ||
            original.consent.contentDigest !== original.review.contentDigest
          )
            throw new Error(`consent ${original.consent.consentId} does not bind its accepted review packet`);
          payload = {
            ...payload,
            consent: {
              ...original.consent,
              reviewDigest: reviewDigest(payload.review!),
              submissionDigest: original.consent.submissionDigest
                ? mapPin(execution, original.consent.submissionDigest)
                : payload.review!.submissionDigest,
            },
          };
        }
        if (original.disposition)
          payload = {
            ...payload,
            disposition: {
              ...original.disposition,
              submissionDigest: mapPin(execution, original.disposition.submissionDigest),
            },
          };
        if (event.type === "completion_gate_verified" && original.witness) {
          const {
            subjects: _subjects,
            predicateType: _predicateType,
            predicate: _predicate,
            diagnostic: _diagnostic,
            ...receipt
          } = original.witness;
          payload = {
            ...payload,
            witness: {
              ...receipt,
              schema: "completion-gate-acceptance/v1",
              historicalAcceptance: {
                sourceGeneration: input.generation,
                sourceRevision: event.workspaceRevision,
                submissionDigest: submissionDigest(submission!),
              },
              ...(receipt.basis
                ? { basis: { ...receipt.basis, submissionDigest: mapPin(execution, receipt.basis.submissionDigest) } }
                : {}),
            },
          };
        }
      }
      if (event.type === "task_completed") {
        const gates = original.closeoutGates as Readonly<Record<string, boolean>> | undefined;
        payload = {
          ...payload,
          historicalAcceptance: { sourceGeneration: input.generation, sourceRevision: event.workspaceRevision },
          closeoutGates: gates
            ? { ...gates, fact: gates.fact ?? true }
            : effectiveCloseoutGates(closeout, task.completionGateIds, task.closeoutOverrides),
        };
      }
      return { event: { ...event, payload } as CanonicalEventV1, blobs };
    },
    mappedSubmissionId(execution: ExecutionV1): string {
      const mapped = submissions.get(cutKey(execution, submissionDigest(execution.submission!)));
      if (!mapped) throw new Error(`submission ${execution.executionId} was not converted`);
      return submissionId(mapped);
    },
  };
}
