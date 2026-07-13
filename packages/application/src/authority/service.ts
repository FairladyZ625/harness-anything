import { Effect } from "effect";
import {
  stablePayloadHash,
  type AuthorityOperationIntegrity,
  type WriteCoordinator,
  type WriteOp
} from "../../../kernel/src/index.ts";
import type {
  AuthorityIndeterminateReceipt,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationState,
  AuthorityRejectedReceipt,
  AuthorityRetryableReceipt,
  AuthoritySubmissionService,
  AttributedCoordinatorFactory,
  AuthorityFenceWitness,
  AuthorityOperationRegistry,
  CanonicalPublicationInspector,
  DelegationTokenVerification,
  DelegationTokenVerifier,
  ReplicaChangeLog
} from "./types.ts";
import {
  actorAxesBindingDigestV2,
  consumeActorAxesBindingOperationV2,
  sameProtocolSchemaTupleV2,
  validateActorAxesBindingPresentationV2,
  type ActorAxesBindingRuntimeV2,
  type ProtocolSchemaTupleV2,
  type VerifiedActorAxesBindingV2
} from "./actor-axes-binding-v2.ts";
import {
  assertMutationClaimMatchesV2,
  decodeSemanticMutationEnvelopeV2,
  operationIdDiagnosticV2,
  semanticMutationSetDigestV2,
  semanticRequestDigestV2,
  SemanticAdmissionErrorV2,
  validateEnvelopeBindingV2,
  type AuthoritySemanticCompilerV2,
  type AuthorizedOperationAttemptV2,
  type OperationNamespaceVerifierV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";
import { BoundedAuthorityBatcher, KeyedSerialAuthorityExecutor } from "./authority-batcher.ts";
import {
  authorizeSemanticCompilationV2,
  type EntityRefPrefixMatcherV2
} from "./semantic-authorizer-v2.ts";
import { shadowPublicationSchema, type ShadowPublicationLog } from "./shadow.ts";

export interface AuthoritySubmissionServiceOptions {
  readonly workspaceId: string;
  readonly coordinatorFactory: AttributedCoordinatorFactory;
  readonly tokenVerifier: DelegationTokenVerifier;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly publicationInspector: CanonicalPublicationInspector;
  readonly fenceWitness: AuthorityFenceWitness;
  readonly shadowPublicationLog?: ShadowPublicationLog;
  readonly now?: () => string;
  readonly v2?: AuthoritySubmissionV2Options;
}

export interface AuthoritySubmissionV2Options {
  readonly schemaTuple: ProtocolSchemaTupleV2;
  readonly channelNonceDigest: Uint8Array;
  readonly bindingRuntime: ActorAxesBindingRuntimeV2;
  readonly semanticCompiler: AuthoritySemanticCompilerV2;
  readonly operationNamespaceVerifier: OperationNamespaceVerifierV2;
  readonly matchEntityRefPrefix?: EntityRefPrefixMatcherV2;
}

const authorityPublicationBatchSize = 8;
const authorityPublicationMaxWaitMs = 10;

interface PreparedAuthoritySubmission {
  readonly kind: "prepared";
  readonly workspaceId: string;
  readonly opId: string;
  readonly operation: WriteOp;
  readonly semanticDigest: string;
  readonly coordinator: WriteCoordinator;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
  readonly canonicalRequestEnvelope?: string;
}

interface TerminalAuthoritySubmission {
  readonly kind: "terminal";
  readonly receipt: AuthorityOperationReceipt;
}

type AuthorityAdmission = PreparedAuthoritySubmission | TerminalAuthoritySubmission;

export function canonicalAuthorityRequestDigest(envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId" | "command" | "operation" | "protocol">): string {
  return stablePayloadHash({
    schema: "authority-operation/v1",
    workspaceId: envelope.workspaceId,
    opId: envelope.opId,
    command: envelope.command,
    operation: envelope.operation,
    protocol: envelope.protocol
  });
}

export function createAuthoritySubmissionService(options: AuthoritySubmissionServiceOptions): AuthoritySubmissionService {
  const byOperation = new KeyedSerialAuthorityExecutor();
  const now = options.now ?? (() => new Date().toISOString());
  const publications = new BoundedAuthorityBatcher<AuthorityAdmission, AuthorityOperationReceipt>(
    publishBatch,
    authorityPublicationBatchSize,
    authorityPublicationMaxWaitMs
  );

  return {
    submit: (envelope) => byOperation.run(
      `${envelope.workspaceId}\0${envelope.opId}`,
      () => publications.run(prepare(envelope))
    ),
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
    return byOperation.run(
      `${envelope.workspaceId}\0${opId}`,
      () => publications.run(prepareV2(envelope, verified, Buffer.from(attempt.envelope).toString("base64url")))
    );
  }

  async function prepareV2(
    envelope: SemanticMutationEnvelopeV2,
    verified: VerifiedActorAxesBindingV2,
    canonicalRequestEnvelope: string
  ): Promise<AuthorityAdmission> {
    const v2 = options.v2!;
    const opId = operationIdDiagnosticV2(envelope.operationId);
    const identity = { workspaceId: envelope.workspaceId, opId };
    const semanticDigest = hex(semanticRequestDigestV2(envelope));
    const known = await options.operationRegistry.get(envelope.workspaceId, opId);
    if (!known) await put(identity, semanticDigest, "RECEIVED", undefined, undefined, undefined, canonicalRequestEnvelope);
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

      const compilation = await v2.semanticCompiler.compile(envelope);
      assertMutationClaimMatchesV2(envelope, compilation.mutationSet);
      authorizeSemanticCompilationV2(envelope, compilation.touchedPaths, compilation.decodedBytes, verified, v2.matchEntityRefPrefix);

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
      if (known) {
        if (known.semanticDigest !== semanticDigest) return terminal(rejected(identity, semanticDigest, "OP_ID_REUSE"));
        if (known.receipt) return terminal(known.receipt);
        return terminal(indeterminate(identity, semanticDigest, `operation remains ${known.state}`));
      }

      await consumeActorAxesBindingOperationV2(verified, v2.bindingRuntime);
      try {
        await options.fenceWitness.assertHeld();
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
      const operation: WriteOp = { ...compilation.operation, opId, authorityIntegrity };
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
        canonicalRequestEnvelope
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
    const known = await options.operationRegistry.get(envelope.workspaceId, envelope.opId);
    if (known) {
      if (known.semanticDigest !== semanticDigest) return terminal(rejected(envelope, semanticDigest, "OP_ID_REUSE"));
      if (known.receipt) return terminal(known.receipt);
      return terminal(indeterminate(envelope, semanticDigest, `operation remains ${known.state}`));
    }

    await put(envelope, semanticDigest, "RECEIVED");
    const ingressFailure = validateIngress(envelope, semanticDigest, options.workspaceId);
    if (ingressFailure) return terminal(await persistTerminal(envelope, semanticDigest, "REJECTED", ingressFailure));

    let verification: DelegationTokenVerification;
    try {
      const { delegationToken, ...unsignedEnvelope } = envelope;
      verification = await options.tokenVerifier.verify({ token: delegationToken, envelope: unsignedEnvelope });
    } catch (error) {
      return terminal(await persistTerminal(envelope, semanticDigest, "REJECTED", rejected(envelope, semanticDigest, `TOKEN_REJECTED:${describe(error)}`)));
    }
    const claimFailure = validateTokenEnvelopeClaims(envelope, verification);
    if (claimFailure) return terminal(await persistTerminal(envelope, semanticDigest, "REJECTED", claimFailure));

    try {
      await options.fenceWitness.assertHeld();
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
      coordinator
    };
  }

  async function publishBatch(admissions: ReadonlyArray<AuthorityAdmission>): Promise<ReadonlyArray<AuthorityOperationReceipt>> {
    const receipts = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
    const prepared = admissions.filter((admission): admission is PreparedAuthoritySubmission => admission.kind === "prepared");
    if (prepared.length === 0) return admissions.map((admission) => (admission as TerminalAuthoritySubmission).receipt);
    if (prepared.some((entry) => entry.authorityIntegrity) && prepared.some((entry) => !entry.authorityIntegrity)) {
      // V1 and V2 may coexist after explicit schema negotiation, but one Git
      // commit cannot truthfully anchor a V2 "exactly this batch" vector while
      // also containing unanchored legacy operations. Preserve FIFO and split
      // only at the provenance boundary.
      const settled = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
      let segment: PreparedAuthoritySubmission[] = [];
      for (const entry of prepared) {
        if (segment.length > 0 && Boolean(segment[0]!.authorityIntegrity) !== Boolean(entry.authorityIntegrity)) {
          const segmentReceipts = await publishBatch(segment);
          segment.forEach((candidate, index) => settled.set(candidate, segmentReceipts[index]!));
          segment = [];
        }
        segment.push(entry);
      }
      if (segment.length > 0) {
        const segmentReceipts = await publishBatch(segment);
        segment.forEach((candidate, index) => settled.set(candidate, segmentReceipts[index]!));
      }
      return admissions.map((admission) => admission.kind === "terminal"
        ? admission.receipt
        : settled.get(admission)!);
    }

    let previousHead: string | null;
    try {
      await options.fenceWitness.assertHeld();
      previousHead = await options.publicationInspector.currentHead();
    } catch (error) {
      await settlePrepared(prepared, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    const candidates: PreparedAuthoritySubmission[] = [];
    for (const entry of prepared) {
      try {
        await Effect.runPromise(entry.coordinator.enqueue(entry.operation));
        await put(entry, entry.semanticDigest, "PREPARED", undefined, undefined, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
        candidates.push(entry);
      } catch (error) {
        receipts.set(entry, await persistTerminal(
          entry,
          entry.semanticDigest,
          "REJECTED",
          rejected(entry, entry.semanticDigest, `ADMISSION_REJECTED:${describe(error)}`)
        ));
      }
    }
    if (candidates.length === 0) return batchReceipts(admissions, receipts);

    try {
      const flush = await Effect.runPromise(candidates[0]!.coordinator.flush("explicit"));
      if (!flush.committed || flush.opCount !== candidates.length) {
        // Keep the v1 wire reason stable; the invariant now means exactly the
        // operation set owned by this publication batch, still never a subset.
        await settlePrepared(candidates, receipts, "RETRYABLE_NOT_COMMITTED", (entry) =>
          retryable(entry, entry.semanticDigest, "PUBLICATION_DID_NOT_COMMIT_EXACTLY_ONE_OPERATION"));
        return batchReceipts(admissions, receipts);
      }
    } catch (error) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `PUBLICATION_OUTCOME_UNKNOWN:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    let commitSha: string;
    try {
      await options.fenceWitness.assertHeld();
      const publication = await options.publicationInspector.inspectPublishedHead(previousHead);
      if (publication.parentCommits.length !== (previousHead ? 1 : 0)
        || (previousHead && publication.parentCommits[0] !== previousHead)) {
        await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
          indeterminate(entry, entry.semanticDigest, "NON_LINEAR_CANONICAL_PUBLICATION", publication.commitSha));
        return batchReceipts(admissions, receipts);
      }
      commitSha = publication.commitSha;
      for (const entry of candidates) {
        await put(entry, entry.semanticDigest, "PUBLISHED", undefined, commitSha, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
      }
    } catch (error) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `PUBLICATION_PROOF_FAILED:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    const latest = await options.replicaChangeLog.latest(candidates[0]!.workspaceId);
    if (latest && latest.commitSha !== previousHead) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, "REPLICA_CHANGE_LOG_DIVERGED", commitSha));
      return batchReceipts(admissions, receipts);
    }
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
      for (const change of changes) await options.replicaChangeLog.append(change);
      if (options.shadowPublicationLog) {
        const priorShadow = await options.shadowPublicationLog.list(candidates[0]!.workspaceId);
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
        await put(entry, entry.semanticDigest, "INDEXED", undefined, commitSha, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
      }
    } catch (error) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry, entry.semanticDigest, `INDEX_RECOVERY_REQUIRED:${describe(error)}`, commitSha));
      return batchReceipts(admissions, receipts);
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const entry = candidates[index]!;
      const receipt = {
        tag: "COMMITTED" as const,
        workspaceId: entry.workspaceId,
        opId: entry.opId,
        semanticDigest: entry.semanticDigest,
        revision: changes[index]!.revision,
        commitSha,
        previousCommit: previousHead,
        ...(entry.authorityIntegrity ? { authorityIntegrity: entry.authorityIntegrity } : {})
      };
      await put(entry, entry.semanticDigest, "COMMITTED", receipt, commitSha, entry.authorityIntegrity, entry.canonicalRequestEnvelope);
      receipts.set(entry, receipt);
    }
    return batchReceipts(admissions, receipts);
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

  async function persistTerminal(
    envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
    digest: string,
    state: Extract<AuthorityOperationState, "REJECTED" | "RETRYABLE_NOT_COMMITTED" | "INDETERMINATE">,
    receipt: AuthorityOperationReceipt,
    authorityIntegrity?: AuthorityOperationIntegrity,
    canonicalRequestEnvelope?: string
  ): Promise<AuthorityOperationReceipt> {
    await put(envelope, digest, state, receipt, "commitSha" in receipt ? receipt.commitSha : undefined, authorityIntegrity, canonicalRequestEnvelope);
    return receipt;
  }

  function put(
    envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
    semanticDigest: string,
    state: AuthorityOperationState,
    receipt?: AuthorityOperationReceipt,
    commitSha?: string,
    authorityIntegrity?: AuthorityOperationIntegrity,
    canonicalRequestEnvelope?: string
  ): Promise<void> {
    return options.operationRegistry.put({
      workspaceId: envelope.workspaceId,
      opId: envelope.opId,
      semanticDigest,
      state,
      ...(receipt ? { receipt } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(authorityIntegrity ? { authorityIntegrity } : {}),
      ...(canonicalRequestEnvelope ? { canonicalRequestEnvelope } : {})
    });
  }
}

function terminal(receipt: AuthorityOperationReceipt): TerminalAuthoritySubmission {
  return { kind: "terminal", receipt };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function batchReceipts(
  admissions: ReadonlyArray<AuthorityAdmission>,
  receipts: ReadonlyMap<PreparedAuthoritySubmission, AuthorityOperationReceipt>
): ReadonlyArray<AuthorityOperationReceipt> {
  return admissions.map((admission) => {
    if (admission.kind === "terminal") return admission.receipt;
    const receipt = receipts.get(admission);
    if (!receipt) throw new Error(`authority batch did not settle operation ${admission.opId}`);
    return receipt;
  });
}

function validateIngress(envelope: AuthorityOperationEnvelope, digest: string, workspaceId: string): AuthorityRejectedReceipt | undefined {
  if (!envelope.workspaceId || envelope.workspaceId !== workspaceId) return rejected(envelope, digest, "WORKSPACE_MISMATCH");
  if (!envelope.opId || envelope.operation.opId !== envelope.opId) return rejected(envelope, digest, "OP_ID_MISMATCH");
  if (envelope.claimedDigest !== digest) return rejected(envelope, digest, "REQUEST_DIGEST_MISMATCH");
  if (!envelope.channelNonceDigest) return rejected(envelope, digest, "CHANNEL_BINDING_REQUIRED");
  return undefined;
}

function validateTokenEnvelopeClaims(envelope: AuthorityOperationEnvelope, verification: DelegationTokenVerification): AuthorityRejectedReceipt | undefined {
  const claims = verification.claims;
  if (claims.workspaceId !== envelope.workspaceId) return rejected(envelope, envelope.claimedDigest, "TOKEN_WORKSPACE_MISMATCH");
  if (claims.channelNonceDigest !== envelope.channelNonceDigest) return rejected(envelope, envelope.claimedDigest, "TOKEN_CHANNEL_MISMATCH");
  if (claims.actorId !== verification.attribution.actor.principal.personId
    || claims.executorId !== (verification.attribution.actor.executor?.id ?? null)) {
    return rejected(envelope, envelope.claimedDigest, "TOKEN_ATTRIBUTION_MISMATCH");
  }
  if (!sameProtocol(claims.protocol, envelope.protocol)) return rejected(envelope, envelope.claimedDigest, "TOKEN_SCHEMA_MISMATCH");
  if (!claims.commandScopes.includes(envelope.command)) return rejected(envelope, envelope.claimedDigest, "TOKEN_COMMAND_SCOPE_DENIED");
  if (claims.maxOps < 1 || claims.maxBytes < Buffer.byteLength(JSON.stringify(envelope.operation), "utf8")) {
    return rejected(envelope, envelope.claimedDigest, "TOKEN_LIMIT_EXCEEDED");
  }
  return undefined;
}

function sameProtocol(left: AuthorityOperationEnvelope["protocol"], right: AuthorityOperationEnvelope["protocol"]): boolean {
  return left.wire === right.wire
    && left.event === right.event
    && left.receipt === right.receipt
    && left.digest === right.digest
    && left.commandRegistry === right.commandRegistry;
}

function rejected(envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">, digest: string, reason: string): AuthorityRejectedReceipt {
  return { tag: "REJECTED", workspaceId: envelope.workspaceId, opId: envelope.opId, semanticDigest: digest, reason };
}

function retryable(envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">, digest: string, reason: string): AuthorityRetryableReceipt {
  return { tag: "RETRYABLE_NOT_COMMITTED", workspaceId: envelope.workspaceId, opId: envelope.opId, semanticDigest: digest, reason };
}

function indeterminate(
  envelope: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  digest: string,
  reason: string,
  commitSha?: string
): AuthorityIndeterminateReceipt {
  return {
    tag: "INDETERMINATE",
    workspaceId: envelope.workspaceId,
    opId: envelope.opId,
    semanticDigest: digest,
    reason,
    ...(commitSha ? { commitSha } : {})
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = (error as { readonly cause?: unknown }).cause;
    return `${"_tag" in error ? String((error as { readonly _tag?: unknown })._tag) : "error"}:${describe(cause)}`;
  }
  return String(error);
}
