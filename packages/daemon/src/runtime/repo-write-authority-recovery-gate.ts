import {
  isCompleteAuthorityCommittedReceiptV2,
  type AuthorityCommittedReceipt,
  type CommandReceiptEnvelope
} from "@harness-anything/application";
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
  readonly resolveHistoricalPublication?: (
    outcome: RepoWriteProceedingOutcomeV1
  ) => Promise<{
    readonly commitSha: string;
    readonly semanticDigest: string;
  }>;
  readonly recoverHistoricalCommittedReceipt?: (
    outcome: RepoWriteProceedingOutcomeV1
  ) => Promise<AuthorityCommittedReceipt>;
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

export type RepoWriteHistoricalProceedingRecoveryResult =
  | { readonly disposition: "committed" }
  | {
      readonly disposition: "permanently-rejected";
      readonly code: string;
    };

/**
 * Binds both recovery admission stages to the same child-owned, fsynced outer
 * PROCEEDING row. Temporal or revocation drift is deliberately absent here;
 * repo/workspace/writer-generation identity and the live writer fence are not.
 */
export class RepoWriteAuthorityRecoveryGate {
  private readonly axes: RepoWriteOutcomeAxesV1;
  private readonly store: DurableRepoWriteOutcomeStoreV1;
  private readonly assertCurrentWriterFence: RepoWriteAuthorityRecoveryGateOptions["assertCurrentWriterFence"];
  private readonly resolveHistoricalPublication:
    RepoWriteAuthorityRecoveryGateOptions["resolveHistoricalPublication"];
  private readonly recoverHistoricalCommittedReceipt:
    RepoWriteAuthorityRecoveryGateOptions["recoverHistoricalCommittedReceipt"];

  constructor(options: RepoWriteAuthorityRecoveryGateOptions) {
    this.axes = {
      repoId: options.repoId,
      workspaceId: options.workspaceId,
      generation: options.generation
    };
    this.store = options.store;
    this.assertCurrentWriterFence = options.assertCurrentWriterFence;
    this.resolveHistoricalPublication = options.resolveHistoricalPublication;
    this.recoverHistoricalCommittedReceipt = options.recoverHistoricalCommittedReceipt;
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
    }, async (outcome, historicalPublication) => {
      if (witness.repoId !== outcome.repoId
        || witness.workspaceId !== outcome.workspaceId
        || witness.opId !== outcome.innerOpId
        || witness.semanticDigest !== outcome.authoritySemanticDigest) {
        throw new RepoWriteOutcomeConflictError(
          `authority recovery witness does not bind the durable outer operation: ${witness.outerOpId}`
        );
      }
      const result: Result = historicalPublication
        ? await this.recoverHistorical(outcome, historicalPublication) as Result
        : await useDurableProceeding();
      if (historicalPublication) {
        const committed = result as AuthorityCommittedReceipt;
        if (!committed || committed.tag !== "COMMITTED"
          || !isCompleteAuthorityCommittedReceiptV2(committed)
          || committed.workspaceId !== outcome.workspaceId
          || committed.opId !== outcome.innerOpId
          || committed.semanticDigest !== outcome.authoritySemanticDigest
          || committed.commitSha !== historicalPublication.commitSha) {
          throw new RepoWriteOutcomeGenerationFenceError(
            `historical authority recovery did not return exact committed publication evidence: ${witness.outerOpId}`
          );
        }
        this.terminalizeHistorical(outcome, historicalPublication, committed);
      }
      return result;
    });
  }

  async recoverHistoricalProceeding(
    outcome: RepoWriteProceedingOutcomeV1
  ): Promise<RepoWriteHistoricalProceedingRecoveryResult> {
    if (outcome.generation >= this.axes.generation
      || outcome.repoId !== this.axes.repoId
      || outcome.workspaceId !== this.axes.workspaceId
      || !this.resolveHistoricalPublication) {
      throw new RepoWriteOutcomeGenerationFenceError(
        `historical authority recovery cannot admit outer PROCEEDING: ${outcome.outerOpId}`
      );
    }
    try {
      const publication = await this.resolveHistoricalPublication(outcome);
      if (publication.semanticDigest !== outcome.authoritySemanticDigest) {
        throw new RepoWriteOutcomeGenerationFenceError(
          `historical publication semantic digest does not match outer PROCEEDING: ${outcome.outerOpId}`
        );
      }
      await this.assertCurrentWriterFence();
      const committed = await this.recoverHistorical(outcome, publication);
      this.terminalizeHistorical(outcome, publication, committed);
      return { disposition: "committed" };
    } catch (error) {
      const permanentCode = permanentHistoricalRecoveryRejectionCode(error);
      if (!permanentCode) throw error;
      await this.assertCurrentWriterFence();
      this.store.rejectHistoricalRecovery({
        ...this.axes,
        outerOpId: outcome.outerOpId,
        requestDigest: outcome.requestDigest,
        code: permanentCode
      });
      return {
        disposition: "permanently-rejected",
        code: permanentCode
      };
    }
  }

  private async recoverHistorical(
    outcome: RepoWriteProceedingOutcomeV1,
    publication: { readonly commitSha: string; readonly semanticDigest: string }
  ): Promise<AuthorityCommittedReceipt> {
    if (!this.recoverHistoricalCommittedReceipt) {
      throw new RepoWriteOutcomeGenerationFenceError(
        `historical authority committed receipt recovery is unavailable: ${outcome.outerOpId}`
      );
    }
    const committed = await this.recoverHistoricalCommittedReceipt(outcome);
    if (committed.tag !== "COMMITTED"
      || !isCompleteAuthorityCommittedReceiptV2(committed)
      || committed.workspaceId !== outcome.workspaceId
      || committed.opId !== outcome.innerOpId
      || committed.semanticDigest !== outcome.authoritySemanticDigest
      || committed.commitSha !== publication.commitSha) {
      throw new RepoWriteOutcomeGenerationFenceError(
        `historical authority recovery did not return exact committed publication evidence: ${outcome.outerOpId}`
      );
    }
    return committed;
  }

  private terminalizeHistorical(
    outcome: RepoWriteProceedingOutcomeV1,
    publication: { readonly commitSha: string },
    committed: AuthorityCommittedReceipt
  ): void {
    this.store.terminalize({
      ...this.axes,
      outerOpId: outcome.outerOpId,
      requestDigest: outcome.requestDigest,
      historicalPublicationCommitSha: publication.commitSha,
      receipt: historicalRecoveryReceipt(outcome, publication.commitSha),
      authorityEvidence: committed
    });
  }

  private async authorize<Result>(
    witness: ProductionAuthorityOuterRecoveryWitnessV1,
    useDurableProceeding: (
      outcome: RepoWriteProceedingOutcomeV1,
      historicalPublication?: {
        readonly commitSha: string;
        readonly semanticDigest: string;
      }
    ) => Result | Promise<Result>
  ): Promise<Result> {
    const current = this.store.lookup(witness.outerOpId);
    if (current.state === "not-found" || current.state === "terminal") {
      throw new RepoWriteOutcomeConflictError(
        `authority recovery requires durable outer PROCEEDING: ${witness.outerOpId}`
      );
    }
    if (current.state === "outcome-unknown") {
      const outcome = current.outcome;
      if (witness.outerGeneration !== outcome.generation
        || witness.outerRequestDigest !== outcome.requestDigest
        || !this.resolveHistoricalPublication) {
        throw new RepoWriteOutcomeGenerationFenceError(
          `authority recovery cannot consume historical outer PROCEEDING: ${witness.outerOpId}`
        );
      }
      const publication = await this.resolveHistoricalPublication(outcome);
      if (publication.semanticDigest !== outcome.authoritySemanticDigest) {
        throw new RepoWriteOutcomeGenerationFenceError(
          `historical publication semantic digest does not match outer PROCEEDING: ${witness.outerOpId}`
        );
      }
      await this.assertCurrentWriterFence();
      return useDurableProceeding(outcome, publication);
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

const permanentHistoricalRecoveryRejectionCodes = new Set([
  "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR",
  "AUTHORITY_CANONICAL_PUBLICATION_NOT_FOUND",
  "AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH"
]);

function permanentHistoricalRecoveryRejectionCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]*)(?=[:;]|$)/u.exec(message)?.[1];
  return code && permanentHistoricalRecoveryRejectionCodes.has(code) ? code : undefined;
}

function historicalRecoveryReceipt(
  outcome: RepoWriteProceedingOutcomeV1,
  publicationCommitSha: string
): CommandReceiptEnvelope {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: outcome.receiptSeed.command,
    action: outcome.receiptSeed.action,
    summary: "Recovered committed outcome from canonical publication.",
    details: {
      actor: outcome.canonicalCommand.actor,
      data: {
        repoWrite: {
          schema: "repo-write-recovery/v1",
          repoId: outcome.repoId,
          generation: outcome.generation,
          outerOpId: outcome.outerOpId,
          recoveryEvidence: `cross-generation-publication:${publicationCommitSha}`
        }
      }
    },
    meta: {
      generatedAt: outcome.receiptSeed.generatedAt,
      compatibility: {}
    }
  };
}
