import type {
  CommandReceiptEnvelope,
  CommandReceiptSettlement
} from "@harness-anything/application";
import { shellArgument } from "../shell-argument.ts";

export interface PendingCommandReceiptSettlementInput {
  readonly receiptId: string;
  readonly acceptedAt: string;
  readonly sessionId: string;
  readonly acceptedCommitSha: string;
  readonly authorityOperationIds?: ReadonlyArray<string>;
}

export function pendingCommandReceiptSettlement(
  input: PendingCommandReceiptSettlementInput
): Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "pending" }> {
  return {
    schema: "command-receipt-settlement/v1",
    receiptId: input.receiptId,
    durability: "session-durable",
    canonicalVisibility: "pending",
    acceptedAt: input.acceptedAt,
    sessionId: input.sessionId,
    acceptedCommitSha: input.acceptedCommitSha,
    ...(input.authorityOperationIds && input.authorityOperationIds.length > 0
      ? { authorityOperationIds: [...input.authorityOperationIds] }
      : {}),
    statusQuery: commandReceiptSettlementStatusQuery(input.receiptId)
  };
}

export function visibleCommandReceiptSettlement(
  pending: Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "pending" }>,
  canonicalCommitSha: string,
  settledAt: string
): Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "visible" }> {
  return {
    ...pending,
    canonicalVisibility: "visible",
    canonicalCommitSha,
    settledAt
  };
}

export function failedCommandReceiptSettlement(
  pending: Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "pending" }>,
  input: {
    readonly failedAt: string;
    readonly stage: Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "failed" }>['failure']['stage'];
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  }
): Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "failed" }> {
  return {
    ...pending,
    canonicalVisibility: "failed",
    failedAt: input.failedAt,
    failure: {
      stage: input.stage,
      code: input.code,
      message: input.message,
      retryable: input.retryable ?? true,
      recoveryCommand: "ha materializer run --json"
    }
  };
}

export function withCommandReceiptSettlement(
  receipt: CommandReceiptEnvelope,
  settlement: CommandReceiptSettlement
): CommandReceiptEnvelope {
  const suffix = settlement.canonicalVisibility === "pending"
    ? " Write is durably accepted; canonical settlement is pending."
    : settlement.canonicalVisibility === "visible"
      ? " Canonical settlement is visible."
      : " Durable acceptance is retained, but canonical settlement failed; inspect the structured settlement status before retrying."
  return {
    ...receipt,
    summary: `${receipt.summary.replace(/\s+$/u, "")}${suffix}`,
    settlement
  } satisfies CommandReceiptEnvelope;
}

export function settlementFailure(error: unknown): {
  readonly stage: Extract<CommandReceiptSettlement, { readonly canonicalVisibility: "failed" }>['failure']['stage'];
  readonly code: string;
  readonly message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const stage = /MATERIALIZATION|materializer|merge conflict/iu.test(message)
    ? "materializer"
    : /PUBLICATION_PROOF/iu.test(message)
      ? "publication-proof"
      : /EVENT_PUBLICATION|evidence/iu.test(message)
        ? "evidence"
        : /INTEGRITY|PROTOCOL_DAMAGED/iu.test(message)
          ? "integrity"
          : "unknown";
  const code = /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(message)?.[1]
    ?? (stage === "materializer" ? "SETTLEMENT_MATERIALIZATION_FAILED" : "SETTLEMENT_FAILED");
  return { stage, code, message };
}

function commandReceiptSettlementStatusQuery(receiptId: string) {
  return {
    method: "repo.write.receipt.status" as const,
    command: `ha receipt status ${shellArgument(receiptId)} --json`,
    receiptId
  };
}
