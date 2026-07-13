import { Effect } from "effect";
import { stablePayloadHash, type WriteCoordinator } from "../../../kernel/src/index.ts";
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

const authorityPublicationBatchSize = 8;
const authorityPublicationMaxWaitMs = 10;

interface PreparedAuthoritySubmission {
  readonly kind: "prepared";
  readonly envelope: AuthorityOperationEnvelope;
  readonly semanticDigest: string;
  readonly coordinator: WriteCoordinator;
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
    getOperation: (workspaceId, opId) => options.operationRegistry.get(workspaceId, opId)
  };

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
    const claimFailure = validateClaims(envelope, verification);
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
    return { kind: "prepared", envelope, semanticDigest, coordinator };
  }

  async function publishBatch(admissions: ReadonlyArray<AuthorityAdmission>): Promise<ReadonlyArray<AuthorityOperationReceipt>> {
    const receipts = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
    const prepared = admissions.filter((admission): admission is PreparedAuthoritySubmission => admission.kind === "prepared");
    if (prepared.length === 0) return admissions.map((admission) => (admission as TerminalAuthoritySubmission).receipt);

    let previousHead: string | null;
    try {
      await options.fenceWitness.assertHeld();
      previousHead = await options.publicationInspector.currentHead();
    } catch (error) {
      await settlePrepared(prepared, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry.envelope, entry.semanticDigest, `AUTHORITY_FENCE_LOST:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    const candidates: PreparedAuthoritySubmission[] = [];
    for (const entry of prepared) {
      try {
        await Effect.runPromise(entry.coordinator.enqueue(entry.envelope.operation));
        await put(entry.envelope, entry.semanticDigest, "PREPARED");
        candidates.push(entry);
      } catch (error) {
        receipts.set(entry, await persistTerminal(
          entry.envelope,
          entry.semanticDigest,
          "REJECTED",
          rejected(entry.envelope, entry.semanticDigest, `ADMISSION_REJECTED:${describe(error)}`)
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
          retryable(entry.envelope, entry.semanticDigest, "PUBLICATION_DID_NOT_COMMIT_EXACTLY_ONE_OPERATION"));
        return batchReceipts(admissions, receipts);
      }
    } catch (error) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry.envelope, entry.semanticDigest, `PUBLICATION_OUTCOME_UNKNOWN:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    let commitSha: string;
    try {
      await options.fenceWitness.assertHeld();
      const publication = await options.publicationInspector.inspectPublishedHead(previousHead);
      if (publication.parentCommits.length !== (previousHead ? 1 : 0)
        || (previousHead && publication.parentCommits[0] !== previousHead)) {
        await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
          indeterminate(entry.envelope, entry.semanticDigest, "NON_LINEAR_CANONICAL_PUBLICATION", publication.commitSha));
        return batchReceipts(admissions, receipts);
      }
      commitSha = publication.commitSha;
      for (const entry of candidates) {
        await put(entry.envelope, entry.semanticDigest, "PUBLISHED", undefined, commitSha);
      }
    } catch (error) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry.envelope, entry.semanticDigest, `PUBLICATION_PROOF_FAILED:${describe(error)}`));
      return batchReceipts(admissions, receipts);
    }

    const latest = await options.replicaChangeLog.latest(candidates[0]!.envelope.workspaceId);
    if (latest && latest.commitSha !== previousHead) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry.envelope, entry.semanticDigest, "REPLICA_CHANGE_LOG_DIVERGED", commitSha));
      return batchReceipts(admissions, receipts);
    }
    const changes = candidates.map((entry, index) => ({
      schema: "replica-change/v1" as const,
      workspaceId: entry.envelope.workspaceId,
      revision: (latest?.revision ?? 0) + index + 1,
      opId: entry.envelope.opId,
      semanticDigest: entry.semanticDigest,
      commitSha,
      previousCommit: previousHead,
      changedAt: now()
    }));
    try {
      for (const change of changes) await options.replicaChangeLog.append(change);
      if (options.shadowPublicationLog) {
        const priorShadow = await options.shadowPublicationLog.list(candidates[0]!.envelope.workspaceId);
        await options.shadowPublicationLog.append({
          schema: shadowPublicationSchema,
          workspaceId: candidates[0]!.envelope.workspaceId,
          sequence: priorShadow.length + 1,
          commitSha,
          previousCommit: previousHead,
          opIds: candidates.map((entry) => entry.envelope.opId),
          observedAt: changes[0]!.changedAt
        });
      }
      for (const entry of candidates) {
        await put(entry.envelope, entry.semanticDigest, "INDEXED", undefined, commitSha);
      }
    } catch (error) {
      await settlePrepared(candidates, receipts, "INDETERMINATE", (entry) =>
        indeterminate(entry.envelope, entry.semanticDigest, `INDEX_RECOVERY_REQUIRED:${describe(error)}`, commitSha));
      return batchReceipts(admissions, receipts);
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const entry = candidates[index]!;
      const receipt = {
        tag: "COMMITTED" as const,
        workspaceId: entry.envelope.workspaceId,
        opId: entry.envelope.opId,
        semanticDigest: entry.semanticDigest,
        revision: changes[index]!.revision,
        commitSha,
        previousCommit: previousHead
      };
      await put(entry.envelope, entry.semanticDigest, "COMMITTED", receipt, commitSha);
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
      receipts.set(entry, await persistTerminal(entry.envelope, entry.semanticDigest, state, makeReceipt(entry)));
    }
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

function terminal(receipt: AuthorityOperationReceipt): TerminalAuthoritySubmission {
  return { kind: "terminal", receipt };
}

function batchReceipts(
  admissions: ReadonlyArray<AuthorityAdmission>,
  receipts: ReadonlyMap<PreparedAuthoritySubmission, AuthorityOperationReceipt>
): ReadonlyArray<AuthorityOperationReceipt> {
  return admissions.map((admission) => {
    if (admission.kind === "terminal") return admission.receipt;
    const receipt = receipts.get(admission);
    if (!receipt) throw new Error(`authority batch did not settle operation ${admission.envelope.opId}`);
    return receipt;
  });
}

class KeyedSerialAuthorityExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  run<Result>(key: string, work: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

interface AuthorityBatchItem<Input, Result> {
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
  outcome?: PromiseSettledResult<Input>;
}

class BoundedAuthorityBatcher<Input, Result> {
  private readonly queue: AuthorityBatchItem<Input, Result>[] = [];
  private draining = false;
  private drainScheduled = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly runBatch: (inputs: ReadonlyArray<Input>) => Promise<ReadonlyArray<Result>>;
  private readonly maxBatchSize: number;
  private readonly maxWaitMs: number;

  constructor(
    runBatch: (inputs: ReadonlyArray<Input>) => Promise<ReadonlyArray<Result>>,
    maxBatchSize: number,
    maxWaitMs: number
  ) {
    this.runBatch = runBatch;
    this.maxBatchSize = maxBatchSize;
    this.maxWaitMs = maxWaitMs;
  }

  run(input: Promise<Input>): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      const item: AuthorityBatchItem<Input, Result> = { resolve, reject };
      this.queue.push(item);
      void input.then(
        (value) => {
          item.outcome = { status: "fulfilled", value };
          this.scheduleIfReady();
        },
        (reason) => {
          item.outcome = { status: "rejected", reason };
          this.scheduleIfReady();
        }
      );
      this.ensureTimer();
    });
  }

  private scheduleIfReady(): void {
    if (this.draining || this.drainScheduled || this.queue.length === 0) return;
    const readyPrefix = this.readyPrefixLength();
    if (readyPrefix === 0) return;
    if (readyPrefix >= this.maxBatchSize || readyPrefix === this.queue.length) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    const count = Math.min(this.readyPrefixLength(), this.maxBatchSize);
    if (count === 0) {
      this.ensureTimer();
      return;
    }
    this.draining = true;
    this.clearTimer();
    const items = this.queue.splice(0, count);
    const fulfilled = items.filter((item): item is AuthorityBatchItem<Input, Result> & { outcome: PromiseFulfilledResult<Input> } =>
      item.outcome?.status === "fulfilled");
    for (const item of items) {
      if (item.outcome?.status === "rejected") item.reject(item.outcome.reason);
    }
    try {
      if (fulfilled.length > 0) {
        const results = await this.runBatch(fulfilled.map((item) => item.outcome.value));
        if (results.length !== fulfilled.length) throw new Error("authority batch result count mismatch");
        fulfilled.forEach((item, index) => item.resolve(results[index]!));
      }
    } catch (error) {
      for (const item of fulfilled) item.reject(error);
    } finally {
      this.draining = false;
      this.scheduleIfReady();
      this.ensureTimer();
    }
  }

  private readyPrefixLength(): number {
    let count = 0;
    while (count < this.queue.length && this.queue[count]?.outcome) count += 1;
    return count;
  }

  private ensureTimer(): void {
    if (this.timer || this.draining || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.readyPrefixLength() > 0) this.scheduleDrain();
      else this.ensureTimer();
    }, this.maxWaitMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
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
