import { Effect } from "effect";
import { stablePayloadHash } from "../../../kernel/src/index.ts";
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
}

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
  const serial = new SerialAuthorityExecutor();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    submit: (envelope) => serial.run(() => submitSerial(envelope)),
    getOperation: (workspaceId, opId) => options.operationRegistry.get(workspaceId, opId)
  };

  async function submitSerial(envelope: AuthorityOperationEnvelope): Promise<AuthorityOperationReceipt> {
    const semanticDigest = canonicalAuthorityRequestDigest(envelope);
    const known = await options.operationRegistry.get(envelope.workspaceId, envelope.opId);
    if (known) {
      if (known.semanticDigest !== semanticDigest) return rejected(envelope, semanticDigest, "OP_ID_REUSE");
      if (known.receipt) return known.receipt;
      return indeterminate(envelope, semanticDigest, `operation remains ${known.state}`);
    }

    await put(envelope, semanticDigest, "RECEIVED");
    const ingressFailure = validateIngress(envelope, semanticDigest, options.workspaceId);
    if (ingressFailure) return persistTerminal(envelope, semanticDigest, "REJECTED", ingressFailure);

    let verification: DelegationTokenVerification;
    try {
      const { delegationToken, ...unsignedEnvelope } = envelope;
      verification = await options.tokenVerifier.verify({ token: delegationToken, envelope: unsignedEnvelope });
    } catch (error) {
      return persistTerminal(envelope, semanticDigest, "REJECTED", rejected(envelope, semanticDigest, `TOKEN_REJECTED:${describe(error)}`));
    }
    const claimFailure = validateClaims(envelope, verification);
    if (claimFailure) return persistTerminal(envelope, semanticDigest, "REJECTED", claimFailure);

    try {
      await options.fenceWitness.assertHeld();
    } catch (error) {
      return persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`));
    }

    const previousHead = await options.publicationInspector.currentHead();
    const coordinator = options.coordinatorFactory.create({
      attribution: verification.attribution,
      sessionId: verification.claims.sessionId
    });
    try {
      await Effect.runPromise(coordinator.enqueue(envelope.operation));
      await put(envelope, semanticDigest, "PREPARED");
    } catch (error) {
      return persistTerminal(envelope, semanticDigest, "REJECTED", rejected(envelope, semanticDigest, `ADMISSION_REJECTED:${describe(error)}`));
    }

    try {
      const flush = await Effect.runPromise(coordinator.flush("explicit"));
      if (!flush.committed || flush.opCount !== 1) {
        return persistTerminal(envelope, semanticDigest, "RETRYABLE_NOT_COMMITTED", retryable(envelope, semanticDigest, "PUBLICATION_DID_NOT_COMMIT_EXACTLY_ONE_OPERATION"));
      }
    } catch (error) {
      return persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, `PUBLICATION_OUTCOME_UNKNOWN:${describe(error)}`));
    }

    let commitSha: string;
    try {
      await options.fenceWitness.assertHeld();
      const publication = await options.publicationInspector.inspectPublishedHead(previousHead);
      if (publication.parentCommits.length !== (previousHead ? 1 : 0)
        || (previousHead && publication.parentCommits[0] !== previousHead)) {
        return persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, "NON_LINEAR_CANONICAL_PUBLICATION", publication.commitSha));
      }
      commitSha = publication.commitSha;
      await put(envelope, semanticDigest, "PUBLISHED", undefined, commitSha);
    } catch (error) {
      return persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, `PUBLICATION_PROOF_FAILED:${describe(error)}`));
    }

    const latest = await options.replicaChangeLog.latest(envelope.workspaceId);
    if (latest && latest.commitSha !== previousHead) {
      return persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, "REPLICA_CHANGE_LOG_DIVERGED", commitSha));
    }
    const change = {
      schema: "replica-change/v1" as const,
      workspaceId: envelope.workspaceId,
      revision: (latest?.revision ?? 0) + 1,
      opId: envelope.opId,
      semanticDigest,
      commitSha,
      previousCommit: previousHead,
      changedAt: now()
    };
    try {
      await options.replicaChangeLog.append(change);
      if (options.shadowPublicationLog) {
        const priorShadow = await options.shadowPublicationLog.list(envelope.workspaceId);
        await options.shadowPublicationLog.append({
          schema: shadowPublicationSchema,
          workspaceId: envelope.workspaceId,
          sequence: priorShadow.length + 1,
          commitSha,
          previousCommit: previousHead,
          opIds: [envelope.opId],
          observedAt: change.changedAt
        });
      }
      await put(envelope, semanticDigest, "INDEXED", undefined, commitSha);
    } catch (error) {
      return persistTerminal(envelope, semanticDigest, "INDETERMINATE", indeterminate(envelope, semanticDigest, `INDEX_RECOVERY_REQUIRED:${describe(error)}`, commitSha));
    }

    const receipt = {
      tag: "COMMITTED" as const,
      workspaceId: envelope.workspaceId,
      opId: envelope.opId,
      semanticDigest,
      revision: change.revision,
      commitSha,
      previousCommit: previousHead
    };
    await put(envelope, semanticDigest, "COMMITTED", receipt, commitSha);
    return receipt;
  }

  async function persistTerminal(
    envelope: AuthorityOperationEnvelope,
    digest: string,
    state: Extract<AuthorityOperationState, "REJECTED" | "RETRYABLE_NOT_COMMITTED" | "INDETERMINATE">,
    receipt: AuthorityOperationReceipt
  ): Promise<AuthorityOperationReceipt> {
    await put(envelope, digest, state, receipt, "commitSha" in receipt ? receipt.commitSha : undefined);
    return receipt;
  }

  function put(
    envelope: AuthorityOperationEnvelope,
    semanticDigest: string,
    state: AuthorityOperationState,
    receipt?: AuthorityOperationReceipt,
    commitSha?: string
  ): Promise<void> {
    return options.operationRegistry.put({
      workspaceId: envelope.workspaceId,
      opId: envelope.opId,
      semanticDigest,
      state,
      ...(receipt ? { receipt } : {}),
      ...(commitSha ? { commitSha } : {})
    });
  }
}

class SerialAuthorityExecutor {
  private tail: Promise<void> = Promise.resolve();

  run<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateIngress(envelope: AuthorityOperationEnvelope, digest: string, workspaceId: string): AuthorityRejectedReceipt | undefined {
  if (!envelope.workspaceId || envelope.workspaceId !== workspaceId) return rejected(envelope, digest, "WORKSPACE_MISMATCH");
  if (!envelope.opId || envelope.operation.opId !== envelope.opId) return rejected(envelope, digest, "OP_ID_MISMATCH");
  if (envelope.claimedDigest !== digest) return rejected(envelope, digest, "REQUEST_DIGEST_MISMATCH");
  if (!envelope.channelNonceDigest) return rejected(envelope, digest, "CHANNEL_BINDING_REQUIRED");
  return undefined;
}

function validateClaims(envelope: AuthorityOperationEnvelope, verification: DelegationTokenVerification): AuthorityRejectedReceipt | undefined {
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
