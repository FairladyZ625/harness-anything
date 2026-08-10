import type { CommandReceiptEnvelope } from "@harness-anything/application";
import {
  DurableRepoWriteOutcomeStoreV1,
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeGenerationFenceError
} from "./durable-repo-write-outcome-store.ts";
import {
  createRepoWriteCanonicalPublicationEvidenceV1,
  assertRepoWriteOutcomeAxesV1,
  createRepoWriteProceedingOutcomeV1,
  type RepoWriteOutcomeAxesV1,
  type RepoWriteProceedingInputV1,
  type RepoWriteProceedingOutcomeV1,
  type RepoWriteTerminalEvidenceV1,
  type RepoWriteTerminalOutcomeV1
} from "./repo-write-outcome-schema.ts";
import { RepoWriteOutcomeValidationError } from "./repo-write-outcome-errors.ts";
import type { RepoWritePreparedOperation } from "./repo-write-child-host.ts";
import type { AuthorityDurableAcceptance } from "./authority-durable-acceptance-context.ts";
import {
  failedCommandReceiptSettlement,
  pendingCommandReceiptSettlement,
  settlementFailure,
  visibleCommandReceiptSettlement,
  withCommandReceiptSettlement
} from "./command-receipt-settlement.ts";
import { ReceiptSettlementStore } from "./receipt-settlement-store.ts";

export interface RepoWriteTerminalExecutionResult {
  readonly kind: "terminal";
  readonly receipt: CommandReceiptEnvelope;
  readonly authorityEvidence: RepoWriteTerminalEvidenceV1;
}

export interface RepoWriteAcceptedExecutionResult {
  readonly kind: "accepted";
  readonly receipt: CommandReceiptEnvelope;
  readonly acceptance: AuthorityDurableAcceptance;
  readonly acceptedCommitSha: string;
  readonly settlement: Promise<RepoWriteTerminalEvidenceV1>;
  readonly releaseSettlement?: () => void;
}

export type RepoWriteDurableExecutionResult =
  | RepoWriteTerminalExecutionResult
  | RepoWriteAcceptedExecutionResult;

export interface RepoWriteAcceptedResult {
  readonly kind: "accepted";
  readonly outerOpId: string;
  readonly receipt: CommandReceiptEnvelope;
  readonly releaseSettlement?: () => void;
}

export type RepoWriteExecutionOutcome = RepoWriteTerminalOutcomeV1 | RepoWriteAcceptedResult;

export interface RepoWriteDurableOperationControllerOptions
  extends RepoWriteOutcomeAxesV1 {
  readonly store: DurableRepoWriteOutcomeStoreV1;
  readonly settlements: ReceiptSettlementStore;
  readonly now?: () => Date;
  readonly recover: (
    proceeding: RepoWriteProceedingOutcomeV1
  ) => Promise<RepoWriteDurableExecutionResult>;
}

export interface RepoWriteDurablePrepareInput {
  readonly proceeding: RepoWriteProceedingInputV1;
  readonly executeFresh: (
    proceeding: RepoWriteProceedingOutcomeV1
  ) => Promise<RepoWriteDurableExecutionResult>;
}

/**
 * Owns the only transition from a pure prepared attempt into canonical write
 * side effects. The outer PROCEEDING publication completes its directory
 * fsync before either fresh activation or fixed-attempt recovery is invoked.
 */
export class RepoWriteDurableOperationController {
  private readonly axes: RepoWriteOutcomeAxesV1;
  private readonly store: DurableRepoWriteOutcomeStoreV1;
  private readonly recoverOperation: RepoWriteDurableOperationControllerOptions["recover"];
  private readonly settlements: ReceiptSettlementStore;
  private readonly now: () => Date;
  private executionTail: Promise<void> = Promise.resolve();
  private readonly activeSettlements = new Map<string, Promise<void>>();

  constructor(options: RepoWriteDurableOperationControllerOptions) {
    this.axes = {
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation
    };
    this.store = options.store;
    this.settlements = options.settlements;
    this.now = options.now ?? (() => new Date());
    this.recoverOperation = options.recover;
  }

  prepare(input: RepoWriteDurablePrepareInput): RepoWritePreparedOperation {
    const candidate = createRepoWriteProceedingOutcomeV1(input.proceeding);
    assertRepoWriteOutcomeAxesV1(candidate, this.axes);
    return {
      opId: candidate.outerOpId,
      execute: () => this.executePrepared(candidate, input.executeFresh)
    };
  }

  resume(outerOpId: string): Promise<RepoWriteExecutionOutcome> {
    return this.serialize(() => this.resumeExclusive(outerOpId));
  }

  async settlementIdle(): Promise<void> {
    while (this.activeSettlements.size > 0) {
      await Promise.all([...this.activeSettlements.values()]);
    }
  }

  async recoverCanonicalPublicationSettlement(input: {
    readonly outerOpId: string;
    readonly canonicalCommitSha: string;
  }): Promise<"live-owner" | "recovered" | "terminal" | "blocked"> {
    const active = this.activeSettlements.get(input.outerOpId);
    if (active) {
      await active;
      return "live-owner";
    }
    return this.serialize(async () => this.recoverCanonicalPublicationExclusive(input));
  }

  private async resumeExclusive(
    outerOpId: string
  ): Promise<RepoWriteExecutionOutcome> {
    const current = this.store.lookup(outerOpId);
    if (current.state === "not-found") {
      throw new RepoWriteOutcomeConflictError(
        `cannot resume repo-write operation without durable PROCEEDING: ${outerOpId}`
      );
    }
    if (current.state === "terminal") return current.outcome;
    if (current.state === "outcome-unknown") {
      throw new RepoWriteOutcomeGenerationFenceError(
        `historical repo-write PROCEEDING requires an explicit generation migration: ${outerOpId}`
      );
    }
    return this.finish(current.outcome, this.recoverOperation);
  }

  private async executePrepared(
    candidate: RepoWriteProceedingOutcomeV1,
    executeFresh: RepoWriteDurablePrepareInput["executeFresh"]
  ): Promise<RepoWriteExecutionOutcome> {
    return this.serialize(() => this.executePreparedExclusive(
      candidate,
      executeFresh
    ));
  }

  private async executePreparedExclusive(
    candidate: RepoWriteProceedingOutcomeV1,
    executeFresh: RepoWriteDurablePrepareInput["executeFresh"]
  ): Promise<RepoWriteExecutionOutcome> {
    const existing = this.store.lookup(candidate.outerOpId);
    if (existing.state === "terminal") return existing.outcome;
    if (existing.state === "outcome-unknown") {
      throw new RepoWriteOutcomeGenerationFenceError(
        `historical repo-write PROCEEDING cannot execute in the current generation: ${candidate.outerOpId}`
      );
    }
    const durable = this.store.begin(candidate);
    if (durable.phase === "TERMINAL") return durable;
    return this.finish(
      durable,
      existing.state === "proceeding" ? this.recoverOperation : executeFresh
    );
  }

  private async finish(
    proceeding: RepoWriteProceedingOutcomeV1,
    execute: (
      proceeding: RepoWriteProceedingOutcomeV1
    ) => Promise<RepoWriteDurableExecutionResult>
  ): Promise<RepoWriteExecutionOutcome> {
    const result = await execute(proceeding);
    if (result.kind === "accepted") return this.accept(proceeding, result);
    return this.store.terminalize({
      ...this.axes,
      outerOpId: proceeding.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: result.receipt,
      authorityEvidence: result.authorityEvidence
    });
  }

  private accept(
    proceeding: RepoWriteProceedingOutcomeV1,
    result: RepoWriteAcceptedExecutionResult
  ): RepoWriteAcceptedResult {
    try {
      const pending = pendingCommandReceiptSettlement({
        receiptId: proceeding.outerOpId,
        acceptedAt: this.now().toISOString(),
        sessionId: result.acceptance.sessionId,
        acceptedCommitSha: result.acceptedCommitSha,
        authorityOperationIds: [result.acceptance.flush.watermark]
      });
      const receipt = withCommandReceiptSettlement(result.receipt, pending);
      this.settlements.accept(receipt);
      const completion = result.settlement.then(
        (evidence) => this.completeSettlement(proceeding, receipt, pending, evidence),
        (error) => this.failSettlement(receipt, pending, error)
      );
      this.activeSettlements.set(proceeding.outerOpId, completion);
      void completion.finally(() => {
        if (this.activeSettlements.get(proceeding.outerOpId) === completion) {
          this.activeSettlements.delete(proceeding.outerOpId);
        }
      });
      return {
        kind: "accepted",
        outerOpId: proceeding.outerOpId,
        receipt,
        ...(result.releaseSettlement ? {
          releaseSettlement: result.releaseSettlement
        } : {})
      };
    } catch (error) {
      result.releaseSettlement?.();
      void result.settlement.catch(() => undefined);
      throw error;
    }
  }

  private recoverCanonicalPublicationExclusive(input: {
    readonly outerOpId: string;
    readonly canonicalCommitSha: string;
  }): "recovered" | "terminal" | "blocked" {
    const current = this.store.lookup(input.outerOpId);
    if (current.state === "terminal") return "terminal";
    if (current.state !== "proceeding") {
      throw new RepoWriteOutcomeConflictError(
        `canonical publication recovery requires current PROCEEDING: ${input.outerOpId}`
      );
    }
    const settlement = this.settlements.lookup(input.outerOpId);
    if (settlement?.state === "failed"
      && settlement.receipt.settlement?.canonicalVisibility === "failed"
      && settlement.receipt.settlement.failure.retryable === false) {
      return "blocked";
    }
    const accepted = this.settlements.listUnsettled()
      .find((record) => record.receiptId === input.outerOpId)?.receipt;
    const pending = accepted?.settlement;
    if (!accepted || !pending || pending.canonicalVisibility !== "pending") {
      throw new RepoWriteOutcomeConflictError(
        `canonical publication recovery requires durable acceptance: ${input.outerOpId}`
      );
    }
    const recovery = current.outcome.recoveryContext;
    const previousCommit = recovery.schema === "repo-write-doc-sync-recovery/v1"
      && typeof recovery.baseLedgerSha === "string"
      ? recovery.baseLedgerSha
      : null;
    const evidence = createRepoWriteCanonicalPublicationEvidenceV1({
      workspaceId: current.outcome.workspaceId,
      opId: current.outcome.innerOpId,
      semanticDigest: current.outcome.authoritySemanticDigest,
      revision: 0,
      commitSha: input.canonicalCommitSha,
      previousCommit,
      acceptedCommitSha: pending.acceptedCommitSha
    });
    this.completeSettlement(current.outcome, accepted, pending, evidence);
    return this.store.lookup(input.outerOpId).state === "terminal" ? "recovered" : "blocked";
  }

  private completeSettlement(
    proceeding: RepoWriteProceedingOutcomeV1,
    acceptedReceipt: CommandReceiptEnvelope,
    pending: Extract<NonNullable<typeof acceptedReceipt.settlement>, { readonly canonicalVisibility: "pending" }>,
    evidence: RepoWriteTerminalEvidenceV1
  ): void {
    if (evidence.tag !== "COMMITTED" && evidence.tag !== "CANONICAL_PUBLICATION") {
      this.failSettlement(
        acceptedReceipt,
        pending,
        new Error(`AUTHORITY_SETTLEMENT_${evidence.tag}:${"reason" in evidence ? evidence.reason : "canonical publication was not committed"}`)
      );
      return;
    }
    let terminalized = false;
    try {
      if (evidence.tag === "CANONICAL_PUBLICATION"
        && evidence.canonicalAncestry.acceptedCommitSha !== pending.acceptedCommitSha) {
        throw new RepoWriteOutcomeValidationError(
          "canonical publication proof is not bound to the accepted doc-sync commit"
        );
      }
      const visible = visibleCommandReceiptSettlement(
        pending,
        evidence.commitSha,
        this.now().toISOString()
      );
      const receipt = withCommandReceiptSettlement(acceptedReceipt, visible);
      this.store.terminalize({
        ...this.axes,
        outerOpId: proceeding.outerOpId,
        requestDigest: proceeding.requestDigest,
        receipt,
        authorityEvidence: evidence
      });
      terminalized = true;
      this.settlements.visible(receipt);
    } catch (error) {
      // The canonical terminal outcome is already the stronger durable truth.
      // Keep the accepted sidecar pending for startup reconciliation instead
      // of manufacturing a false failed-while-visible successor.
      if (terminalized) return;
      this.failSettlement(
        acceptedReceipt,
        pending,
        error,
        !(error instanceof RepoWriteOutcomeValidationError)
      );
    }
  }

  private failSettlement(
    acceptedReceipt: CommandReceiptEnvelope,
    pending: Extract<NonNullable<typeof acceptedReceipt.settlement>, { readonly canonicalVisibility: "pending" }>,
    error: unknown,
    retryable = true
  ): void {
    if (this.store.lookup(pending.receiptId).state === "terminal"
      || this.settlements.lookup(pending.receiptId)?.state === "canonical-visible") {
      return;
    }
    const failure = settlementFailure(error);
    const failed = failedCommandReceiptSettlement(pending, {
      failedAt: this.now().toISOString(),
      ...failure,
      retryable
    });
    const receipt = withCommandReceiptSettlement(acceptedReceipt, failed);
    this.settlements.fail(receipt);
  }

  private async serialize<Result>(
    execute: () => Promise<Result>
  ): Promise<Result> {
    const predecessor = this.executionTail;
    let release: (() => void) | undefined;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await execute();
    } finally {
      release!();
    }
  }
}
