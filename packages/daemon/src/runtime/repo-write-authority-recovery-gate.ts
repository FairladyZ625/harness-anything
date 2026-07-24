import type { ProductionAuthorityOuterRecoveryWitnessV1 } from "../authority/production/production-authority-attempt-plan.ts";
import {
  DurableRepoWriteOutcomeStoreV1,
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeGenerationFenceError
} from "./durable-repo-write-outcome-store.ts";
import type {
  RepoWriteOutcomeAxesV1,
  RepoWriteProceedingOutcomeV1
} from "./repo-write-outcome-schema.ts";

export interface RepoWriteAuthorityRecoveryGateOptions
  extends RepoWriteOutcomeAxesV1 {
  readonly store: DurableRepoWriteOutcomeStoreV1;
  readonly assertCurrentWriterFence: () => void | Promise<void>;
}

export interface RepoWriteAuthorityRecoveryAttemptWitness {
  readonly witness: {
    readonly repoId: string;
    readonly outerOpId: string;
    readonly outerRequestDigest: string;
    readonly outerGeneration: number;
    readonly workspaceId: string;
    readonly opId: string;
    readonly semanticDigest: string;
  };
}

/**
 * Binds both recovery admission stages to the same child-owned, fsynced outer
 * PROCEEDING row. Temporal or revocation drift is deliberately absent here;
 * repo/workspace/writer-generation identity and the live writer fence are not.
 */
export class RepoWriteAuthorityRecoveryGate {
  private readonly axes: RepoWriteOutcomeAxesV1;
  private readonly store: DurableRepoWriteOutcomeStoreV1;
  private readonly assertCurrentWriterFence: RepoWriteAuthorityRecoveryGateOptions["assertCurrentWriterFence"];

  constructor(options: RepoWriteAuthorityRecoveryGateOptions) {
    this.axes = {
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation
    };
    this.store = options.store;
    this.assertCurrentWriterFence = options.assertCurrentWriterFence;
  }

  runPlannedRecovery<Result>(
    witness: ProductionAuthorityOuterRecoveryWitnessV1,
    useDurableProceeding: (
      outcome: RepoWriteProceedingOutcomeV1
    ) => Result
  ): Promise<Result> {
    return this.authorize(witness, useDurableProceeding);
  }

  runAttemptRecovery<Result>(
    recovery: RepoWriteAuthorityRecoveryAttemptWitness,
    useDurableProceeding: () => Promise<Result>
  ): Promise<Result> {
    const witness = recovery.witness;
    return this.authorize({
      outerOpId: witness.outerOpId,
      outerRequestDigest: witness.outerRequestDigest,
      outerGeneration: witness.outerGeneration
    }, async (outcome) => {
      if (witness.repoId !== outcome.repoId
        || witness.workspaceId !== outcome.workspaceId
        || witness.opId !== outcome.innerOpId
        || witness.semanticDigest !== outcome.authoritySemanticDigest) {
        throw new RepoWriteOutcomeConflictError(
          `authority recovery witness does not bind the durable outer operation: ${witness.outerOpId}`
        );
      }
      return useDurableProceeding();
    });
  }

  private async authorize<Result>(
    witness: ProductionAuthorityOuterRecoveryWitnessV1,
    useDurableProceeding: (
      outcome: RepoWriteProceedingOutcomeV1
    ) => Result | Promise<Result>
  ): Promise<Result> {
    const current = this.store.lookup(witness.outerOpId);
    if (current.state === "not-found" || current.state === "terminal") {
      throw new RepoWriteOutcomeConflictError(
        `authority recovery requires durable outer PROCEEDING: ${witness.outerOpId}`
      );
    }
    if (current.state === "outcome-unknown") {
      throw new RepoWriteOutcomeGenerationFenceError(
        `authority recovery cannot consume historical outer PROCEEDING: ${witness.outerOpId}`
      );
    }
    const outcome = current.outcome;
    if (outcome.repoId !== this.axes.repoId
      || outcome.workspaceId !== this.axes.workspaceId
      || outcome.generation !== this.axes.generation
      || witness.outerGeneration !== outcome.generation
      || witness.outerRequestDigest !== outcome.requestDigest) {
      throw new RepoWriteOutcomeConflictError(
        `authority recovery outer witness mismatch: ${witness.outerOpId}`
      );
    }
    await this.assertCurrentWriterFence();
    return useDurableProceeding(outcome);
  }
}
