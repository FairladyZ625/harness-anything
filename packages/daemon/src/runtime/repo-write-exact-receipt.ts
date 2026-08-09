import type { AuthorityOperationReceipt, CommandReceiptEnvelope } from "@harness-anything/application";
import type { RepoWriteJsonValue } from "./repo-write-protocol.ts";
import type { RepoWriteProceedingOutcomeV1 } from "./repo-write-outcome-schema.ts";

export function exactRepoWriteReceipt(
  receipt: CommandReceiptEnvelope,
  proceeding: RepoWriteProceedingOutcomeV1,
  authorityEvidence: AuthorityOperationReceipt | undefined
): CommandReceiptEnvelope {
  const alreadySatisfied = authorityEvidence?.tag === "ALREADY_SATISFIED"
    ? { kind: "already-satisfied", message: authorityEvidence.message }
    : undefined;
  return {
    ...receipt,
    ...(alreadySatisfied ? { summary: alreadySatisfied.message } : {}),
    command: proceeding.receiptSeed.command,
    action: proceeding.receiptSeed.action,
    details: {
      ...(receipt.details ?? {}),
      data: {
        ...receiptDetailsData(receipt),
        ...(alreadySatisfied ? { authorityOutcome: alreadySatisfied } : {}),
        repoWrite: {
          schema: "repo-write-recovery/v1",
          repoId: proceeding.repoId,
          generation: proceeding.generation,
          outerOpId: proceeding.outerOpId
        }
      },
      actor: proceeding.canonicalCommand.actor
    },
    meta: {
      ...receipt.meta,
      generatedAt: proceeding.receiptSeed.generatedAt
    }
  };
}

function receiptDetailsData(receipt: CommandReceiptEnvelope): Record<string, RepoWriteJsonValue> {
  const data = receipt.details?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, RepoWriteJsonValue>
    : {};
}
