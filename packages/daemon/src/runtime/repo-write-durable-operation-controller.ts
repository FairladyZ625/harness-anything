import type { CommandReceiptEnvelope } from "@harness-anything/application";
import {
  DurableRepoWriteOutcomeStoreV1,
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeGenerationFenceError
} from "./durable-repo-write-outcome-store.ts";
import {
  assertRepoWriteOutcomeAxesV1,
  createRepoWriteProceedingOutcomeV1,
  type RepoWriteOutcomeAxesV1,
  type RepoWriteProceedingInputV1,
  type RepoWriteProceedingOutcomeV1,
  type RepoWriteTerminalEvidenceV1,
  type RepoWriteTerminalOutcomeV1
} from "./repo-write-outcome-schema.ts";
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
}

export type RepoWriteDurableExecutionResult =
  | RepoWriteTerminalExecutionResult
  | RepoWriteAcceptedExecutionResult;

export interface RepoWriteAcceptedResult {
  readonly kind: "accepted";
  readonly outerOpId: string;
  readonly receipt: Extract<CommandReceiptEnvelope, { readonly ok: true }>;
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
    if (!result.receipt.ok) throw new Error("REPO_WRITE_DURABLE_ACCEPTANCE_REQUIRES_SUCCESS_RECEIPT");
    const pending = pendingCommandReceiptSettlement({
      receiptId: proceeding.outerOpId,
      acceptedAt: this.now().toISOString(),
      sessionId: result.acceptance.sessionId,
      acceptedCommitSha: result.acceptedCommitSha,
      authorityOperationIds: [result.acceptance.flush.watermark]
    });
    const receipt = withCommandReceiptSettlement(result.receipt, pending);
    if (!receipt.ok) throw new Error("REPO_WRITE_DURABLE_ACCEPTANCE_RECEIPT_REVERSED");
    this.settlements.accept(receipt);
    void result.settlement.then(
      (evidence) => this.completeSettlement(proceeding, receipt, pending, evidence),
      (error) => this.failSettlement(receipt, pending, error)
    );
    return { kind: "accepted", outerOpId: proceeding.outerOpId, receipt };
  }

  private completeSettlement(
    proceeding: RepoWriteProceedingOutcomeV1,
    acceptedReceipt: Extract<CommandReceiptEnvelope, { readonly ok: true }>,
    pending: Extract<NonNullable<typeof acceptedReceipt.settlement>, { readonly canonicalVisibility: "pending" }>,
    evidence: RepoWriteTerminalEvidenceV1
  ): void {
    if (evidence.tag !== "COMMITTED") {
      this.failSettlement(
        acceptedReceipt,
        pending,
        new Error(`AUTHORITY_SETTLEMENT_${evidence.tag}:${"reason" in evidence ? evidence.reason : "canonical publication was not committed"}`)
      );
      return;
    }
    try {
      const visible = visibleCommandReceiptSettlement(
        pending,
        evidence.commitSha,
        this.now().toISOString()
      );
      const receipt = withCommandReceiptSettlement(acceptedReceipt, visible);
      if (!receipt.ok) throw new Error("REPO_WRITE_VISIBLE_RECEIPT_REVERSED");
      this.store.terminalize({
        ...this.axes,
        outerOpId: proceeding.outerOpId,
        requestDigest: proceeding.requestDigest,
        receipt,
        authorityEvidence: evidence
      });
      this.settlements.visible(receipt);
    } catch (error) {
      this.failSettlement(acceptedReceipt, pending, error);
    }
  }

  private failSettlement(
    acceptedReceipt: Extract<CommandReceiptEnvelope, { readonly ok: true }>,
    pending: Extract<NonNullable<typeof acceptedReceipt.settlement>, { readonly canonicalVisibility: "pending" }>,
    error: unknown
  ): void {
    const failure = settlementFailure(error);
    const failed = failedCommandReceiptSettlement(pending, {
      failedAt: this.now().toISOString(),
      ...failure
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
