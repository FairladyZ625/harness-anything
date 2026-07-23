import { Effect } from "effect";
import {
  createWritableEntityRegistry,
  daemonAdmissionBytes,
  type JournalRecordWitnessV1
} from "@harness-anything/kernel";
import type {
  AuthorityCommittedReceipt,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationState,
  AuthoritySubmissionService,
  DelegationTokenVerification,
} from "./types.ts";
import { validateActorAxesBindingPresentationV2 } from "./actor-axes-binding-v2.ts";
import {
  decodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  semanticRequestDigestV2,
  SemanticAdmissionErrorV2,
  type AuthorizedOperationAttemptV2
} from "./semantic-mutation-envelope-v2.ts";
import { BoundedAuthorityBatcher, KeyedSerialAuthorityExecutor } from "./authority-batcher.ts";
import { shadowPublicationSchema } from "./shadow.ts";
import { completeAuthorityCommittedReceiptV2 } from "./committed-event-publication-v2.ts";
import {
  validateLegacyAuthorityIngress,
  validateLegacyTokenEnvelopeClaims
} from "./legacy-admission.ts";
import { createAuthorityOperationRecordPersistence } from "./operation-record-persistence.ts";
import { persistAuthorityIntentWhileGenerationCurrent } from "./intent-record-persistence.ts";
import { canonicalAuthorityRequestDigest, runWithAuthorityAdmission } from "./admission.ts";
import {
  authorityPublicationBatchSize,
  authorityPublicationMaxWaitMs,
  type AuthorityAdmission,
  type PreparedAuthoritySubmission,
  type TerminalAuthoritySubmission
} from "./service-admission-types.ts";
import {
  generationFencedReceipt,
  generationFencedIndeterminateReceipt,
  isDaemonGenerationFenced,
  persistTerminalOrRejectGeneration,
  rejectGenerationFencedBatch,
  rejectStaleGeneration
} from "./generation-fence-enforcement.ts";
import { batchReceipts, indeterminate, rejected, retryable, terminal } from "./receipt-builders.ts";
import { authorityPublicationSegments } from "./publication-segments.ts";
import { createReplicaPublicationChange } from "./replica-publication-change.ts";
import type { AuthoritySubmissionServiceOptions } from "./service-options.ts";
import { createAuthorityRecoverySubmitterV2 } from "./authority-recovery-submission-v2.ts";
import { authorityOperationPublicView } from "./operation-record-public-view.ts";
import { prepareAuthorityV2 } from "./authority-v2-preparation.ts";
export type { AuthoritySubmissionServiceOptions, AuthoritySubmissionV2Options } from "./service-options.ts";
export function createAuthoritySubmissionService(options: AuthoritySubmissionServiceOptions): AuthoritySubmissionService {
  const writableEntityRegistry = options.v2
    ? createWritableEntityRegistry(options.v2.entityRegistrations)
    : undefined;
  const byOperation = new KeyedSerialAuthorityExecutor();
  const now = options.now ?? (() => new Date().toISOString());
  const persistence = createAuthorityOperationRecordPersistence(options.operationRegistry, options.generationFenceWitness);
  const { put } = persistence;
  const persistTerminal = (...args: Parameters<typeof persistence.persistTerminal>) =>
    persistTerminalOrRejectGeneration(persistence.persistTerminal, args);
  const publications = new BoundedAuthorityBatcher<AuthorityAdmission, AuthorityOperationReceipt>(
    (admissions) => options.publicationExecutor
      ? options.publicationExecutor.run(() => publishBatch(admissions))
      : publishBatch(admissions),
    authorityPublicationBatchSize,
    authorityPublicationMaxWaitMs
  );
  const resumeV2 = options.v2?.runAuthorizedRecoveryAttempt
    ? createAuthorityRecoverySubmitterV2({
      workspaceId: options.workspaceId,
      options: options.v2,
      admissionBudget: options.admissionBudget,
      submitPrepared: (validated) => {
        const opId = operationIdDiagnosticV2(validated.envelope.operationId);
        return byOperation.run(
          `${validated.envelope.workspaceId}\0${opId}`,
          () => publications.run(prepareAuthorityV2({
            ...validated,
            mode: "outer-proceeding-recovery",
            options,
            writableEntityRegistry: writableEntityRegistry!,
            put,
            persistTerminal
          }))
        );
      }
    })
    : undefined;

  return {
    submit: (envelope) => runWithAuthorityAdmission({
      budget: options.admissionBudget,
      identity: envelope,
      semanticDigest: canonicalAuthorityRequestDigest(envelope),
      bytes: daemonAdmissionBytes(envelope),
      work: () => byOperation.run(
        `${envelope.workspaceId}\0${envelope.opId}`,
        () => publications.run(prepare(envelope))
      )
    }),
    ...(options.v2 ? {
      submitV2,
      ...(resumeV2 ? { resumeV2 } : {})
    } : {}),
    getOperation: async (workspaceId, opId) => {
      const stored = await options.operationRegistry.get(workspaceId, opId);
      return stored ? authorityOperationPublicView(stored) : undefined;
    }
  };

  async function submitV2(attempt: AuthorizedOperationAttemptV2): Promise<AuthorityOperationReceipt> {
    const v2 = options.v2;
    if (!v2) throw new Error("AUTHORITY_V2_NOT_NEGOTIATED");
    if (!attempt.requestId) throw new Error("AUTHORITY_V2_REQUEST_ID_REQUIRED");

    // The presentation token is authenticated before the semantic payload is
    // decoded. A reconnect may present a newer token for the same protected
    // binding; the envelope's original admissionTokenRef is checked separately.
    const verified = await validateActorAxesBindingPresentationV2(attempt.presentationToken, v2.bindingRuntime, {
      workspaceId: options.workspaceId,
      channelNonceDigest: v2.channelNonceDigest,
      schemaTuple: v2.schemaTuple
    });
    const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
    const opId = operationIdDiagnosticV2(envelope.operationId);
    return runWithAuthorityAdmission({
      budget: options.admissionBudget,
      identity: { workspaceId: envelope.workspaceId, opId },
      semanticDigest: Buffer.from(semanticRequestDigestV2(envelope)).toString("hex"),
      bytes: daemonAdmissionBytes(attempt),
      work: () => byOperation.run(
        `${envelope.workspaceId}\0${opId}`,
        () => publications.run(prepareAuthorityV2({
          envelope,
          verified,
          canonicalRequestEnvelope: Buffer.from(attempt.envelope).toString("base64url"),
          mode: "new-admission",
          options,
          writableEntityRegistry: writableEntityRegistry!,
          put,
          persistTerminal
        }))
      )
    });
  }

  async function prepare(envelope: AuthorityOperationEnvelope): Promise<AuthorityAdmission> {
    const semanticDigest = canonicalAuthorityRequestDigest(envelope);
    const generationRejection = await rejectStaleGeneration(options.generationFenceWitness, envelope, semanticDigest);
    if (generationRejection) return terminal(generationRejection);
    const known = await options.operationRegistry.get(envelope.workspaceId, envelope.opId);
    if (known) {
      if (known.semanticDigest !== semanticDigest) return terminal(rejected(envelope, semanticDigest, "OP_ID_REUSE"));
      if (known.receipt) return terminal(known.receipt);
      return terminal(indeterminate(envelope, semanticDigest, `operation remains ${known.state}`));
    }
    const intentRejection = await persistAuthorityIntentWhileGenerationCurrent({
      generationFence: options.generationFenceWitness,
      identity: envelope,
      persist: () => put(envelope, semanticDigest, "RECEIVED")
    });
    if (intentRejection) return terminal(generationFencedReceipt(envelope, semanticDigest, intentRejection));
    if (options.v2 && (envelope.operation.kind === "doc_sync_submit" || envelope.operation.kind === "script_ingest")) {
      return terminal(await persistTerminal(
        envelope,
        semanticDigest,
        "REJECTED",
        rejected(envelope, semanticDigest, "SEMANTIC_DIFF_REQUIRED")
      ));
    }
    const ingressFailure = validateLegacyAuthorityIngress(envelope, semanticDigest, options.workspaceId);
    if (ingressFailure) return terminal(await persistTerminal(envelope, semanticDigest, "REJECTED", ingressFailure));

    let verification: DelegationTokenVerification;
    try {
      const { delegationToken, ...unsignedEnvelope } = envelope;
      verification = await options.tokenVerifier.verify({ token: delegationToken, envelope: unsignedEnvelope });
    } catch (error) {
      return terminal(await persistTerminal(envelope, semanticDigest, "REJECTED", rejected(envelope, semanticDigest, `TOKEN_REJECTED:${describe(error)}`)));
    }
    const claimFailure = validateLegacyTokenEnvelopeClaims(envelope, verification);
    if (claimFailure) return terminal(await persistTerminal(envelope, semanticDigest, "REJECTED", claimFailure));

    try {
      await options.fenceWitness.assertHeld("before-prepare", envelope);
    } catch (error) {
      return terminal(await persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`)));
    }

    const coordinator = options.coordinatorFactory.create({
      attribution: verification.attribution,
      sessionId: verification.claims.sessionId
    });
    return {
      kind: "prepared",
      workspaceId: envelope.workspaceId,
      opId: envelope.opId,
      operation: envelope.operation,
      semanticDigest,
      coordinator,
      recordedProtocol: { kind: "authority-operation/v1", schemaTuple: envelope.protocol }
    };
  }

  async function publishBatch(admissions: ReadonlyArray<AuthorityAdmission>): Promise<ReadonlyArray<AuthorityOperationReceipt>> {
    const receipts = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
    const prepared = admissions.filter((admission): admission is PreparedAuthoritySubmission => admission.kind === "prepared");
    if (prepared.length === 0) return admissions.map((admission) => (admission as TerminalAuthoritySubmission).receipt);
    const segments = authorityPublicationSegments(prepared);
    if (segments.length > 1) {
      // V1 and V2 may coexist after explicit schema negotiation, but one Git
      // commit cannot truthfully anchor a V2 "exactly this batch" vector while
      // also containing unanchored legacy operations. Publication revalidation
      // similarly requires a single-operation FIFO segment.
      const settled = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
      for (const segment of segments) {
        const segmentReceipts = await publishBatch(segment);
        segment.forEach((candidate, index) => settled.set(candidate, segmentReceipts[index]!));
      }
      return admissions.map((admission) => admission.kind === "terminal"
        ? admission.receipt
        : settled.get(admission)!);
    }

    let previousHead: string | null;
    try {
      await options.fenceWitness.assertHeld("before-canonical-publish", prepared[0]);
      previousHead = await options.publicationInspector.currentHead();
    } catch (error) {
      await settlePrepared(prepared, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    if (await rejectGenerationFencedBatch(options.generationFenceWitness, prepared, receipts)) {
      return batchReceipts(admissions, receipts);
    }

    const candidates: PreparedAuthoritySubmission[] = [];
    const journalWitnesses = new Map<PreparedAuthoritySubmission, JournalRecordWitnessV1>();
    let canonicalFlushCommitted = false;
    const publishWhileGenerationCurrent = async (): Promise<ReadonlyArray<AuthorityOperationReceipt>> => {
      for (const entry of prepared) {
        try {
          await options.generationFenceWitness?.assertHeld("before-prepare", entry);
          await entry.publicationRevalidation?.();
          const acknowledgement = await Effect.runPromise(entry.coordinator.enqueue(entry.operation));
          if (entry.recoveryMode) {
            if (!acknowledgement.journalWitness || !entry.coordinator.flushExactJournalRecord) {
              receipts.set(entry, await persistTerminal(
                entry,
                entry.semanticDigest,
                "INDETERMINATE",
                indeterminate(
                  entry,
                  entry.semanticDigest,
                  "AUTHORITY_RECOVERY_EXACT_JOURNAL_WITNESS_UNAVAILABLE"
                ),
                entry.authorityIntegrity,
                entry.canonicalRequestEnvelope,
                entry.operation,
                entry.recoveryPublicationPolicy,
                entry.fixedOperationBinding
              ));
              continue;
            }
            journalWitnesses.set(entry, acknowledgement.journalWitness);
          }
          await options.generationFenceWitness?.assertHeld("before-prepare", entry);
          await put(
            entry,
            entry.semanticDigest,
            "PREPARED",
            undefined,
            undefined,
            entry.authorityIntegrity,
            entry.canonicalRequestEnvelope,
            entry.operation,
            entry.recoveryPublicationPolicy,
            entry.fixedOperationBinding
          );
          candidates.push(entry);
        } catch (error) {
          if (isDaemonGenerationFenced(error)) throw error;
          const reason = error instanceof SemanticAdmissionErrorV2 ? error.code : `ADMISSION_REJECTED:${describe(error)}`;
          receipts.set(entry, await persistTerminal(
            entry,
            entry.semanticDigest,
            "REJECTED",
            rejected(entry, entry.semanticDigest, reason),
            entry.authorityIntegrity,
            entry.canonicalRequestEnvelope,
            entry.operation,
            entry.recoveryPublicationPolicy,
            entry.fixedOperationBinding
          ));
        }
      }
      if (candidates.length === 0) return batchReceipts(admissions, receipts);
      try {
      await options.generationFenceWitness?.assertHeld("before-canonical-publish", candidates[0]);
      const recoveryCandidate = candidates[0]!.recoveryMode ? candidates[0] : undefined;
      const flush = recoveryCandidate
        ? await Effect.runPromise(recoveryCandidate.coordinator.flushExactJournalRecord!(
          "recovery",
          journalWitnesses.get(recoveryCandidate)!
        ))
        : await Effect.runPromise(candidates[0]!.coordinator.flush("explicit"));
      if (!flush.committed || flush.opCount !== candidates.length) {
        // Keep the v1 wire reason stable; the invariant now means exactly the
        // operation set owned by this publication batch, still never a subset.
        await settlePrepared(candidates, receipts, "RETRYABLE_NOT_COMMITTED", (entry) =>
          retryable(entry, entry.semanticDigest, "PUBLICATION_DID_NOT_COMMIT_EXACTLY_ONE_OPERATION"));
        return batchReceipts(admissions, receipts);
      }
      canonicalFlushCommitted = true;
    } catch (error) {
      if (isDaemonGenerationFenced(error)) throw error;
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `PUBLICATION_OUTCOME_UNKNOWN:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    let commitSha: string;
    try {
      await options.fenceWitness.assertHeld("after-canonical-publish", candidates[0]);
      const publication = await options.publicationInspector.inspectPublishedHead(
        previousHead,
        candidates.map((entry) => entry.opId)
      );
      commitSha = publication.commitSha;
      for (const entry of candidates) {
        await options.generationFenceWitness?.assertHeld("after-canonical-publish", entry);
        await put(
          entry,
          entry.semanticDigest,
          "PUBLISHED",
          undefined,
          commitSha,
          entry.authorityIntegrity,
          entry.canonicalRequestEnvelope,
          entry.operation,
          entry.recoveryPublicationPolicy,
          entry.fixedOperationBinding
        );
      }
    } catch (error) {
      if (isDaemonGenerationFenced(error)) throw error;
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `PUBLICATION_PROOF_FAILED:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    const latest = await options.replicaChangeLog.latest(candidates[0]!.workspaceId);
    const change = createReplicaPublicationChange({
      revision: (latest?.revision ?? 0) + 1,
      operations: candidates,
      commitSha,
      previousCommit: previousHead,
      changedAt: now()
    });
    try {
      for (const entry of candidates) {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
      }
      await options.replicaChangeLog.append(change);
      if (options.shadowPublicationLog) {
        const priorShadow = await options.shadowPublicationLog.list(candidates[0]!.workspaceId);
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", candidates[0]);
        await options.shadowPublicationLog.append({
          schema: shadowPublicationSchema,
          workspaceId: candidates[0]!.workspaceId,
          sequence: priorShadow.length + 1,
          commitSha,
          previousCommit: previousHead,
          opIds: candidates.map((entry) => entry.opId),
          observedAt: change.changedAt
        });
      }
      for (const entry of candidates) {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
        await put(
          entry,
          entry.semanticDigest,
          "INDEXED",
          undefined,
          commitSha,
          entry.authorityIntegrity,
          entry.canonicalRequestEnvelope,
          entry.operation,
          entry.recoveryPublicationPolicy,
          entry.fixedOperationBinding
        );
      }
    } catch (error) {
      if (isDaemonGenerationFenced(error)) throw error;
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `INDEX_RECOVERY_REQUIRED:${describe(error)}`, commitSha));
      return batchReceipts(admissions, receipts);
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const entry = candidates[index]!;
      const baseReceipt: AuthorityCommittedReceipt = {
        tag: "COMMITTED" as const,
        workspaceId: entry.workspaceId,
        opId: entry.opId,
        semanticDigest: entry.semanticDigest,
        revision: change.revision,
        commitSha,
        previousCommit: previousHead,
        ...(entry.authorityIntegrity ? { authorityIntegrity: entry.authorityIntegrity } : {})
      };
      let receipt: AuthorityOperationReceipt = baseReceipt;
      try {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
      } catch (error) {
        receipt = isDaemonGenerationFenced(error)
          ? generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error, commitSha)
          : await persistPostCommitIntegrityFailure(entry, `AUTHORITY_FENCE_LOST:${describe(error)}`, commitSha);
        receipts.set(entry, receipt);
        continue;
      }
      if (entry.authorityIntegrity) {
        if (!entry.actorAxesBinding) {
          receipt = await persistPostCommitIntegrityFailure(entry, "PROTOCOL_DAMAGED:ACTOR_AXES_BINDING_CORE_REQUIRED", commitSha);
          receipts.set(entry, receipt);
          continue;
        }
      }
      try {
        const persistCommitted = async () => {
          if (entry.authorityIntegrity) {
            await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
            receipt = await completeAuthorityCommittedReceiptV2({
              publisher: options.v2!.committedEventPublisher,
              receipt: baseReceipt,
              actorAxesBinding: entry.actorAxesBinding!,
              occurredAt: change.changedAt
            });
          }
          await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
          await put(
            entry,
            entry.semanticDigest,
            "COMMITTED",
            receipt,
            commitSha,
            entry.authorityIntegrity,
            entry.canonicalRequestEnvelope,
            entry.operation,
            entry.recoveryPublicationPolicy,
            entry.fixedOperationBinding
          );
          return receipt;
        };
        receipt = options.generationFenceWitness
          ? await options.generationFenceWitness.runExclusive("before-terminal-visibility", entry, persistCommitted)
          : await persistCommitted();
      } catch (error) {
        receipt = isDaemonGenerationFenced(error)
          ? generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error, commitSha)
          : await persistPostCommitIntegrityFailure(entry, `PROTOCOL_DAMAGED:V2_EVENT_PUBLICATION_FAILED:${describe(error)}`, commitSha);
      }
      receipts.set(entry, receipt);
    }
    return batchReceipts(admissions, receipts);
    };
    try {
      return options.generationFenceWitness
        ? await options.generationFenceWitness.runExclusive(
          "before-canonical-publish",
          prepared[0],
          publishWhileGenerationCurrent
        )
        : await publishWhileGenerationCurrent();
    } catch (error) {
      if (!isDaemonGenerationFenced(error)) throw error;
      for (const entry of prepared) {
        if (receipts.has(entry)) continue;
        receipts.set(entry, canonicalFlushCommitted
          ? generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error)
          : generationFencedReceipt(entry, entry.semanticDigest, error));
      }
      return batchReceipts(admissions, receipts);
    }
  }

  async function persistPostCommitIntegrityFailure(
    entry: PreparedAuthoritySubmission,
    reason: string,
    commitSha: string
  ): Promise<AuthorityOperationReceipt> {
    const receipt = indeterminate(entry, entry.semanticDigest, reason, commitSha);
    try {
      return await persistence.persistTerminal(
        entry,
        entry.semanticDigest,
        "INDETERMINATE",
        receipt,
        entry.authorityIntegrity,
        entry.canonicalRequestEnvelope,
        entry.operation,
        entry.recoveryPublicationPolicy,
        entry.fixedOperationBinding
      );
    } catch (error) {
      if (!isDaemonGenerationFenced(error)) throw error;
      return generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error, commitSha);
    }
  }

  async function settlePrepared(
    entries: ReadonlyArray<PreparedAuthoritySubmission>,
    receipts: Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>,
    state: Extract<AuthorityOperationState, "REJECTED" | "RETRYABLE_NOT_COMMITTED" | "INDETERMINATE">,
    makeReceipt: (entry: PreparedAuthoritySubmission) => AuthorityOperationReceipt
  ): Promise<void> {
    for (const entry of entries) {
      receipts.set(entry, await persistTerminal(
        entry,
        entry.semanticDigest,
        state,
        makeReceipt(entry),
        entry.authorityIntegrity,
        entry.canonicalRequestEnvelope,
        entry.operation,
        entry.recoveryPublicationPolicy,
        entry.fixedOperationBinding
      ));
    }
  }

}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return `${"_tag" in error ? String((error as { readonly _tag?: unknown })._tag) : "error"}:${describe(cause)}`;
  }
  return String(error);
}
