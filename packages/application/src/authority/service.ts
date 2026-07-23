import { Effect } from "effect";
import {
  compileRegistryMutationPlan,
  createWritableEntityRegistry,
  daemonAdmissionBytes,
  type AuthorityOperationIntegrity,
  type WriteOp
} from "@harness-anything/kernel";
import type {
  AuthorityCommittedReceipt,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationState,
  AuthoritySubmissionService,
  DelegationTokenVerification,
} from "./types.ts";
import {
  actorAxesBindingDigestV2,
  consumeActorAxesBindingOperationV2,
  sameProtocolSchemaTupleV2,
  validateActorAxesBindingPresentationV2,
  type VerifiedActorAxesBindingV2
} from "./actor-axes-binding-v2.ts";
import {
  assertMutationClaimMatchesV2,
  assertStoragePlanMatchesMutationSetV2,
  decodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  SemanticAdmissionErrorV2,
  validateEnvelopeBindingV2,
  type AuthorizedOperationAttemptV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import { BoundedAuthorityBatcher, KeyedSerialAuthorityExecutor } from "./authority-batcher.ts";
import {
  authorizeSemanticCompilationV2
} from "./semantic-authorizer-v2.ts";
import { shadowPublicationSchema } from "./shadow.ts";
import { actorAxesBindingCoreFromVerifiedV2, completeAuthorityCommittedReceiptV2 } from "./committed-event-publication-v2.ts";
import { recoverKnownAuthorityOperationV2 } from "./authority-attribution-event-v2-operation-recovery.ts";
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
import type { AuthoritySubmissionServiceOptions } from "./service-options.ts";
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
    ...(options.v2 ? { submitV2 } : {}),
    getOperation: async (workspaceId, opId) => {
      const stored = await options.operationRegistry.get(workspaceId, opId);
      if (!stored) return undefined;
      const { canonicalRequestEnvelope: _canonicalRequestEnvelope, ...publicRecord } = stored;
      return publicRecord;
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
      semanticDigest: hex(semanticRequestDigestV2(envelope)),
      bytes: daemonAdmissionBytes(attempt),
      work: () => byOperation.run(
        `${envelope.workspaceId}\0${opId}`,
        () => publications.run(prepareV2(envelope, verified, Buffer.from(attempt.envelope).toString("base64url")))
      )
    });
  }

  async function prepareV2(
    envelope: SemanticMutationEnvelopeV2,
    verified: VerifiedActorAxesBindingV2,
    canonicalRequestEnvelope: string
  ): Promise<AuthorityAdmission> {
    const v2 = options.v2!;
    const opId = operationIdDiagnosticV2(envelope.operationId);
    const recordedProtocol = {
      kind: "semantic-mutation-envelope/v2" as const,
      schemaTuple: envelope.schemaTuple
    };
    const identity = { workspaceId: envelope.workspaceId, opId, recordedProtocol };
    const semanticDigest = hex(semanticRequestDigestV2(envelope));
    const generationRejection = await rejectStaleGeneration(options.generationFenceWitness, identity, semanticDigest);
    if (generationRejection) return terminal(generationRejection);
    const known = await options.operationRegistry.get(envelope.workspaceId, opId);
    if (known) {
      if (known.semanticDigest !== semanticDigest) return terminal(rejected(identity, semanticDigest, "OP_ID_REUSE"));
      if (v2.recoverCommittedReceipt
        && (known.state === "INDEXED" || known.state === "INDETERMINATE")
        && known.recordedProtocol?.kind === "semantic-mutation-envelope/v2") {
        const recoverCommittedReceipt = v2.recoverCommittedReceipt;
        const recover = () => recoverKnownAuthorityOperationV2({
            known,
            semanticDigest,
            canonicalRequestEnvelope,
            verified,
            recover: recoverCommittedReceipt,
            ...(options.generationFenceWitness ? {
              assertCurrent: () => options.generationFenceWitness!.assertHeld("before-terminal-journal", identity)
            } : {}),
            persist: (receipt) => put(identity, semanticDigest, "COMMITTED", receipt, known.commitSha, known.authorityIntegrity, known.canonicalRequestEnvelope)
          });
        let recovered: AuthorityCommittedReceipt | undefined;
        try {
          recovered = options.generationFenceWitness
            ? await options.generationFenceWitness.runExclusive("before-terminal-journal", identity, recover)
            : await recover();
        } catch (error) {
          if (!isDaemonGenerationFenced(error)) throw error;
          return terminal(generationFencedReceipt(identity, semanticDigest, error));
        }
        if (recovered) return terminal(recovered);
      }
      if (known.receipt) return terminal(known.receipt);
      return terminal(indeterminate(identity, semanticDigest, `operation remains ${known.state}`));
    }
    const intentRejection = await persistAuthorityIntentWhileGenerationCurrent({
      generationFence: options.generationFenceWitness,
      identity,
      persist: () => put(identity, semanticDigest, "RECEIVED", undefined, undefined, undefined, canonicalRequestEnvelope)
    });
    if (intentRejection) return terminal(generationFencedReceipt(identity, semanticDigest, intentRejection));
    let computedIntegrity: AuthorityOperationIntegrity | undefined;
    try {
      if (!sameProtocolSchemaTupleV2(envelope.schemaTuple, v2.schemaTuple)) {
        throw new SemanticAdmissionErrorV2("ENVELOPE_SCHEMA_TUPLE_MISMATCH");
      }
      validateEnvelopeBindingV2(envelope, verified.token.claims);
      if (envelope.operationId.namespace.authorityGeneration !== verified.token.claims.authorityGeneration) {
        throw new SemanticAdmissionErrorV2("OP_NAMESPACE_AUTHORITY_GENERATION_MISMATCH");
      }
      if (!await v2.bindingRuntime.validateAdmissionTokenRef({
        bindingId: envelope.binding.bindingId,
        tokenId: envelope.binding.admissionTokenRef.tokenId,
        tokenDigest: envelope.binding.admissionTokenRef.tokenDigest
      })) throw new SemanticAdmissionErrorV2("ADMISSION_TOKEN_REF_MISMATCH");
      await v2.operationNamespaceVerifier.verify(envelope.operationId);

      const semanticCompilation = await v2.semanticCompiler.compile(envelope, {
        actor: {
          principal: { personId: verified.token.claims.principalPersonId },
          executor: verified.token.claims.executorAgentId
            ? { kind: "agent", id: verified.token.claims.executorAgentId }
            : null,
          responsibleHuman: `person:${verified.token.claims.principalPersonId}`
        },
        sessionId: verified.token.claims.sessionId,
        nowMs: v2.bindingRuntime.nowMs()
      });
      const compilation = compileRegistryMutationPlan(writableEntityRegistry!, semanticCompilation.mutationPlan);
      assertStoragePlanMatchesMutationSetV2(compilation.mutationSet, compilation.storagePlan);
      assertMutationClaimMatchesV2(envelope, compilation.mutationSet);
      authorizeSemanticCompilationV2(envelope, compilation.storagePlan.touchedPaths, semanticCompilation.decodedBytes, verified, v2.matchEntityRefPrefix);

      const mutationDigest = hex(semanticMutationSetDigestV2(compilation.mutationSet));
      const bindingDigest = hex(actorAxesBindingDigestV2(verified.token.claims));
      const authorityIntegrity: AuthorityOperationIntegrity = {
        schema: "authority-operation-integrity/v2",
        semanticRequestDigest: semanticDigest,
        semanticMutationSetDigest: mutationDigest,
        mutationRegistryVersion: compilation.mutationSet.registryVersion,
        actorAxesBindingDigest: bindingDigest,
        canonicalMutationSet: compilation.mutationSet
      };
      computedIntegrity = authorityIntegrity;
      await consumeActorAxesBindingOperationV2(verified, v2.bindingRuntime);
      try {
        await options.fenceWitness.assertHeld("before-prepare", identity);
      } catch (error) {
        return terminal(await persistTerminal(
          identity,
          semanticDigest,
          "INDETERMINATE",
          indeterminate(identity, semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`),
          authorityIntegrity,
          canonicalRequestEnvelope
        ));
      }
      const operation: WriteOp = { ...semanticCompilation.operation, opId, authorityIntegrity };
      const coordinator = options.coordinatorFactory.create({
        attribution: verified.attribution,
        sessionId: verified.token.claims.sessionId
      });
      return {
        kind: "prepared",
        workspaceId: envelope.workspaceId,
        opId,
        operation,
        semanticDigest,
        coordinator,
        authorityIntegrity,
        actorAxesBinding: actorAxesBindingCoreFromVerifiedV2(verified),
        canonicalRequestEnvelope,
        ...(semanticCompilation.publicationRevalidation
          ? { publicationRevalidation: semanticCompilation.publicationRevalidation }
          : {}),
        recordedProtocol
      };
    } catch (error) {
      const reason = error instanceof SemanticAdmissionErrorV2 ? error.code : `ADMISSION_REJECTED:${describe(error)}`;
      return terminal(await persistTerminal(
        identity,
        semanticDigest,
        "REJECTED",
        rejected(identity, semanticDigest, reason),
        computedIntegrity,
        canonicalRequestEnvelope
      ));
    }
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
    let canonicalFlushCommitted = false;
    const publishWhileGenerationCurrent = async (): Promise<ReadonlyArray<AuthorityOperationReceipt>> => {
      for (const entry of prepared) {
        try {
          await options.generationFenceWitness?.assertHeld("before-prepare", entry);
          await entry.publicationRevalidation?.();
          await Effect.runPromise(entry.coordinator.enqueue(entry.operation));
          await options.generationFenceWitness?.assertHeld("before-prepare", entry);
          await put(entry, entry.semanticDigest, "PREPARED", undefined, undefined, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
          candidates.push(entry);
        } catch (error) {
          if (isDaemonGenerationFenced(error)) throw error;
          const reason = error instanceof SemanticAdmissionErrorV2 ? error.code : `ADMISSION_REJECTED:${describe(error)}`;
          receipts.set(entry, await persistTerminal(
            entry,
            entry.semanticDigest,
            "REJECTED",
            rejected(entry, entry.semanticDigest, reason)
          ));
        }
      }
      if (candidates.length === 0) return batchReceipts(admissions, receipts);
      try {
      await options.generationFenceWitness?.assertHeld("before-canonical-publish", candidates[0]);
      const flush = await Effect.runPromise(candidates[0]!.coordinator.flush("explicit"));
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
        await put(entry, entry.semanticDigest, "PUBLISHED", undefined, commitSha, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
      }
    } catch (error) {
      if (isDaemonGenerationFenced(error)) throw error;
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `PUBLICATION_PROOF_FAILED:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    const latest = await options.replicaChangeLog.latest(candidates[0]!.workspaceId);
    const changes = candidates.map((entry, index) => ({
      schema: "replica-change/v1" as const,
      workspaceId: entry.workspaceId,
      revision: (latest?.revision ?? 0) + index + 1,
      opId: entry.opId,
      semanticDigest: entry.semanticDigest,
      commitSha,
      previousCommit: previousHead,
      changedAt: now(),
      ...(entry.authorityIntegrity ? { authorityIntegrity: entry.authorityIntegrity } : {})
    }));
    try {
      for (const [index, change] of changes.entries()) {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", candidates[index]);
        await options.replicaChangeLog.append(change);
      }
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
          observedAt: changes[0]!.changedAt
        });
      }
      for (const entry of candidates) {
        await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
        await put(entry, entry.semanticDigest, "INDEXED", undefined, commitSha, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
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
        revision: changes[index]!.revision,
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
              occurredAt: changes[index]!.changedAt
            });
          }
          await options.generationFenceWitness?.assertHeld("before-terminal-visibility", entry);
          await put(entry, entry.semanticDigest, "COMMITTED", receipt, commitSha, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
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
        entry.canonicalRequestEnvelope
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
        entry.canonicalRequestEnvelope
      ));
    }
  }

}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return `${"_tag" in error ? String((error as { readonly _tag?: unknown })._tag) : "error"}:${describe(cause)}`;
  }
  return String(error);
}
