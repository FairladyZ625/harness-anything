import { Effect } from "effect";
import {
  createExactWriteScope,
  createJournaledBatch,
  createWritableEntityRegistry,
  daemonAdmissionBytes,
  type FlushReport,
  type JournaledBatchEntry
} from "@harness-anything/kernel";
import type {
  AuthorityCommittedPhysicalObservationV2,
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
import { completeAuthorityCommittedReceiptsV2 } from "./committed-event-publication-v2.ts";
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
import type {
  AuthorityPublicationExecutionContext,
  AuthoritySubmissionServiceOptions
} from "./service-options.ts";
import {
  inspectAuthoritySettlementPublication,
  resolveAuthorityReplicaPublicationChange
} from "./publication-settlement.ts";
import type { ReplicaPublicationOperation } from "./replica-publication-change.ts";
import {
  authorityServiceErrorDescription as describe,
  createAuthorityCoordinatorResolver
} from "./service-support.ts";
import { createAuthorityRecoverySubmitterV2 } from "./authority-recovery-submission-v2.ts";
import { authorityOperationPublicView } from "./operation-record-public-view.ts";
import { prepareAuthorityV2 } from "./authority-v2-preparation.ts";
import { classifyAuthorityPublicationOutcome } from "./publication-outcome.ts";
import { completedPublicationCut, segmentedPublicationCut, settleAuthorityPublicationCut, type AuthorityPublicationCut } from "./publication-cut.ts";
export type {
  AuthorityPublicationExecutionContext,
  AuthoritySubmissionServiceOptions,
  AuthoritySubmissionV2Options
} from "./service-options.ts";

export function createAuthoritySubmissionService(options: AuthoritySubmissionServiceOptions): AuthoritySubmissionService {
  const writableEntityRegistry = options.v2
    ? createWritableEntityRegistry(options.v2.entityRegistrations)
    : undefined;
  const byOperation = new KeyedSerialAuthorityExecutor();
  const exactWriteScopes = new Map<string, ReturnType<typeof createExactWriteScope>>();
  const createCoordinator = createAuthorityCoordinatorResolver({
    coordinatorFactory: options.coordinatorFactory,
    exactWriteScopes,
    createExactWriteScope
  });
  const now = options.now ?? (() => new Date().toISOString());
  const persistence = createAuthorityOperationRecordPersistence(options.operationRegistry, options.generationFenceWitness);
  const { put } = persistence;
  const persistTerminal = (...args: Parameters<typeof persistence.persistTerminal>) =>
    persistTerminalOrRejectGeneration(persistence.persistTerminal, args);
  const publications = new BoundedAuthorityBatcher<AuthorityAdmission, AuthorityOperationReceipt>(
    async (admissions) => {
      const cut = options.publicationExecutor
        ? await options.publicationExecutor.run((execution) => publishBatchToCut(admissions, execution))
        : await publishBatchToCut(admissions, { allowDurableSuccessor: false });
      return settleAuthorityPublicationCut(cut);
    },
    authorityPublicationBatchSize,
    authorityPublicationMaxWaitMs,
    { allowOverlappingBatches: options.publicationExecutor !== undefined }
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
            createCoordinator,
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
    options.onTelemetry?.("authority-admission");
    const verified = await validateActorAxesBindingPresentationV2(attempt.presentationToken, v2.bindingRuntime, {
      workspaceId: options.workspaceId,
      channelNonceDigest: v2.channelNonceDigest,
      schemaTuple: v2.schemaTuple
    });
    options.onTelemetry?.("authority-binding-verified");
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
          createCoordinator,
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

    const publicationSessionId = verification.claims.sessionId;
    const coordinator = createCoordinator(verification.attribution, publicationSessionId);
    return {
      kind: "prepared",
      workspaceId: envelope.workspaceId,
      opId: envelope.opId,
      operation: envelope.operation,
      semanticDigest,
      publicationSessionId,
      coordinator,
      recordedProtocol: { kind: "authority-operation/v1", schemaTuple: envelope.protocol }
    };
  }

  async function publishBatchToCut(
    admissions: ReadonlyArray<AuthorityAdmission>,
    execution: AuthorityPublicationExecutionContext
  ): Promise<AuthorityPublicationCut> {
    options.onTelemetry?.("authority-batch-start");
    const receipts = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
    const prepared = admissions.filter((admission): admission is PreparedAuthoritySubmission => admission.kind === "prepared");
    if (prepared.length === 0) {
      return completedPublicationCut(admissions.map((admission) => (admission as TerminalAuthoritySubmission).receipt));
    }
    const segments = authorityPublicationSegments(prepared);
    if (segments.length > 1) {
      // V1 and V2 may coexist after explicit schema negotiation, but one Git
      // commit cannot truthfully anchor a V2 "exactly this batch" vector while
      // also containing unanchored legacy operations. Publication revalidation
      // similarly requires a single-operation FIFO segment.
      const cuts: Array<{
        readonly segment: ReadonlyArray<PreparedAuthoritySubmission>;
        readonly cut: AuthorityPublicationCut;
      }> = [];
      for (const segment of segments) {
        cuts.push({ segment, cut: await publishBatchToCut(segment, execution) });
      }
      return segmentedPublicationCut(admissions, cuts);
    }

    let previousHead: string | null;
    try {
      await options.fenceWitness.assertHeld("before-canonical-publish", prepared[0]);
      previousHead = await options.publicationInspector.currentHead();
    } catch (error) {
      await settlePrepared(prepared, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`));
      return completedPublicationCut(batchReceipts(admissions, receipts));
    }

    if (await rejectGenerationFencedBatch(options.generationFenceWitness, prepared, receipts)) {
      return completedPublicationCut(batchReceipts(admissions, receipts));
    }

    const candidates: PreparedAuthoritySubmission[] = [];
    const batchEntries = new Map<PreparedAuthoritySubmission, JournaledBatchEntry>();
    let canonicalFlushCommitted = false;
    const publishWhileGenerationCurrent = async (): Promise<AuthorityPublicationCut> => {
      for (const entry of prepared) {
        try {
          await options.generationFenceWitness?.assertHeld("before-prepare", entry);
          await entry.publicationRevalidation?.();
          options.onTelemetry?.("authority-coordinator-enqueue");
          const acknowledgement = await Effect.runPromise(entry.coordinator.enqueue(entry.operation));
          options.onTelemetry?.("authority-coordinator-enqueued");
          batchEntries.set(entry, acknowledgement);
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
          options.onTelemetry?.("authority-prepared-persisted");
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
      if (candidates.length === 0) return completedPublicationCut(batchReceipts(admissions, receipts));
      let outcome: ReturnType<typeof classifyAuthorityPublicationOutcome>;
      let publicationReport: FlushReport | undefined;
      try {
        await options.generationFenceWitness?.assertHeld("before-canonical-publish", candidates[0]);
        const [firstCandidate, ...remainingCandidates] = candidates;
        const batchCoordinator = firstCandidate!.coordinator;
        const batch = createJournaledBatch([
          batchEntries.get(firstCandidate!)!,
          ...remainingCandidates.map((candidate) => batchEntries.get(candidate)!)
        ]);
        options.onTelemetry?.("authority-flush-start");
        const result = await Effect.runPromise(Effect.either(batchCoordinator.commitExact(
          firstCandidate!.recoveryMode ? "recovery" : "explicit",
          batch
        )));
        if (result._tag === "Left") {
          outcome = classifyAuthorityPublicationOutcome({ kind: "error", error: result.left });
        } else {
          publicationReport = result.right;
          outcome = classifyAuthorityPublicationOutcome({
            kind: "report",
            report: result.right,
            expectedOpCount: candidates.length
          });
        }
      } catch (error) {
        if (isDaemonGenerationFenced(error)) throw error;
        outcome = classifyAuthorityPublicationOutcome({ kind: "error", error });
      }
      if (outcome.kind === "rejected") {
        await settlePrepared(candidates, receipts, "REJECTED", (entry) =>
          rejected(entry, entry.semanticDigest, outcome.reason));
        return completedPublicationCut(batchReceipts(admissions, receipts));
      }
      if (outcome.kind === "retryable") {
        await settlePrepared(candidates, receipts, "RETRYABLE_NOT_COMMITTED", (entry) =>
          retryable(entry, entry.semanticDigest, outcome.reason));
        return completedPublicationCut(batchReceipts(admissions, receipts));
      }
      if (outcome.kind === "indeterminate") {
        await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
          indeterminate(entry, entry.semanticDigest, outcome.reason));
        return completedPublicationCut(batchReceipts(admissions, receipts));
      }
      canonicalFlushCommitted = true;

      let commitSha: string;
      let publicationOperations: ReadonlyArray<ReplicaPublicationOperation>;
      let publicationObservation: AuthorityCommittedPhysicalObservationV2 | undefined;
      try {
        await options.fenceWitness.assertHeld("after-canonical-publish", candidates[0]);
        const publication = await inspectAuthoritySettlementPublication({
          inspector: options.publicationInspector,
          operationRegistry: options.operationRegistry,
          candidates,
          execution,
          ...(publicationReport ? { publicationReport } : {}),
          previousHead
        });
        commitSha = publication.commitSha;
        previousHead = publication.previousHead;
        publicationOperations = publication.operations;
        publicationObservation = publication.observation;
      } catch (error) {
        if (isDaemonGenerationFenced(error)) throw error;
        await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
          indeterminate(entry, entry.semanticDigest, `PUBLICATION_PROOF_FAILED:${describe(error)}`));
        return completedPublicationCut(batchReceipts(admissions, receipts));
      }

    const replicaPublication = await resolveAuthorityReplicaPublicationChange({
      changeLog: options.replicaChangeLog,
      operations: publicationOperations,
      commitSha,
      previousCommit: previousHead,
      changedAt: now()
    });
    const { change } = replicaPublication;
    try {
      for (const entry of candidates) {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
      }
      if (!replicaPublication.existing) await options.replicaChangeLog.append(change);
      if (!replicaPublication.existing && options.shadowPublicationLog) {
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
      await options.generationFenceWitness?.assertHeld("before-terminal-visibility", candidates[0]);
      await persistence.putMany(candidates.map((entry) => ({
        envelope: entry,
        semanticDigest: entry.semanticDigest,
        state: "INDEXED" as const,
        commitSha,
        authorityIntegrity: entry.authorityIntegrity,
        canonicalRequestEnvelope: entry.canonicalRequestEnvelope,
        canonicalOperation: entry.operation,
        recoveryPublicationPolicy: entry.recoveryPublicationPolicy,
        fixedOperationBinding: entry.fixedOperationBinding
      })));
    } catch (error) {
      if (isDaemonGenerationFenced(error)) throw error;
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `INDEX_RECOVERY_REQUIRED:${describe(error)}`, commitSha));
      return completedPublicationCut(batchReceipts(admissions, receipts));
    }

    return { settle: async () => {
    const committed = new Map<PreparedAuthoritySubmission, AuthorityCommittedReceipt>();
    for (const entry of candidates) {
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
      if (entry.authorityIntegrity && !entry.actorAxesBinding) {
        receipts.set(entry, await persistPostCommitIntegrityFailure(
          entry,
          "PROTOCOL_DAMAGED:ACTOR_AXES_BINDING_CORE_REQUIRED",
          commitSha
        ));
      } else {
        committed.set(entry, baseReceipt);
      }
    }

    const v2Entries = [...committed.keys()].filter((entry) => entry.authorityIntegrity);
    if (v2Entries.length > 0) {
      try {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", v2Entries[0]);
        const completed = await completeAuthorityCommittedReceiptsV2({
          publisher: options.v2!.committedEventPublisher,
          publications: v2Entries.map((entry) => ({
            receipt: committed.get(entry)!,
            actorAxesBinding: entry.actorAxesBinding!,
            occurredAt: change.changedAt
          })),
          ...(publicationObservation ? { observation: publicationObservation } : {})
        });
        v2Entries.forEach((entry, index) => committed.set(entry, completed[index]!));
        options.onTelemetry?.("authority-event-published");
      } catch (error) {
        for (const entry of v2Entries) {
          committed.delete(entry);
          receipts.set(entry, isDaemonGenerationFenced(error)
            ? generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error, commitSha)
            : await persistPostCommitIntegrityFailure(
                entry,
                `PROTOCOL_DAMAGED:V2_EVENT_PUBLICATION_FAILED:${describe(error)}`,
                commitSha
              ));
        }
      }
    }

    const committedEntries = [...committed.entries()];
    if (committedEntries.length > 0) {
      try {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", committedEntries[0]![0]);
        options.onTelemetry?.("authority-terminal-record-start");
        await persistence.putMany(committedEntries.map(([entry, receipt]) => ({
          envelope: entry,
          semanticDigest: entry.semanticDigest,
          state: "COMMITTED" as const,
          receipt,
          commitSha,
          authorityIntegrity: entry.authorityIntegrity,
          canonicalRequestEnvelope: entry.canonicalRequestEnvelope,
          canonicalOperation: entry.operation,
          recoveryPublicationPolicy: entry.recoveryPublicationPolicy,
          fixedOperationBinding: entry.fixedOperationBinding
        })));
        options.onTelemetry?.("authority-terminal-record-persisted");
        for (const [entry, receipt] of committedEntries) receipts.set(entry, receipt);
      } catch (error) {
        for (const [entry] of committedEntries) {
          receipts.set(entry, isDaemonGenerationFenced(error)
            ? generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error, commitSha)
            : await persistPostCommitIntegrityFailure(entry, `TERMINAL_RECORD_FAILED:${describe(error)}`, commitSha));
        }
      }
    }
    return batchReceipts(admissions, receipts);
    } };
    };
    try {
      options.onTelemetry?.("authority-generation-acquire");
      return options.generationFenceWitness
        ? await options.generationFenceWitness.runExclusive(
          "before-canonical-publish",
          prepared[0],
          () => {
            options.onTelemetry?.("authority-generation-held");
            return publishWhileGenerationCurrent();
          }
        )
        : await (() => {
          options.onTelemetry?.("authority-generation-held");
          return publishWhileGenerationCurrent();
        })();
    } catch (error) {
      if (!isDaemonGenerationFenced(error)) throw error;
      for (const entry of prepared) {
        if (receipts.has(entry)) continue;
        receipts.set(entry, canonicalFlushCommitted
          ? generationFencedIndeterminateReceipt(entry, entry.semanticDigest, error)
          : generationFencedReceipt(entry, entry.semanticDigest, error));
      }
      return completedPublicationCut(batchReceipts(admissions, receipts));
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
