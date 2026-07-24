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

export interface RepoWriteDurableExecutionResult {
  readonly receipt: CommandReceiptEnvelope;
  readonly authorityEvidence: RepoWriteTerminalEvidenceV1;
}

export interface RepoWriteDurableOperationControllerOptions
  extends RepoWriteOutcomeAxesV1 {
  readonly store: DurableRepoWriteOutcomeStoreV1;
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

  constructor(options: RepoWriteDurableOperationControllerOptions) {
    this.axes = {
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation
    };
    this.store = options.store;
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

  async resume(outerOpId: string): Promise<RepoWriteTerminalOutcomeV1> {
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
  ): Promise<RepoWriteTerminalOutcomeV1> {
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
  ): Promise<RepoWriteTerminalOutcomeV1> {
    const result = await execute(proceeding);
    return this.store.terminalize({
      ...this.axes,
      outerOpId: proceeding.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: result.receipt,
      authorityEvidence: result.authorityEvidence
    });
  }
}
