import { stablePayloadHash, type DaemonAdmissionBudget } from "../../../kernel/src/index.ts";
import type { AuthorityOperationEnvelope, AuthorityOperationReceipt } from "./types.ts";

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

export async function runWithAuthorityAdmission(input: {
  readonly budget?: DaemonAdmissionBudget;
  readonly identity: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">;
  readonly semanticDigest: string;
  readonly bytes: number;
  readonly work: () => Promise<AuthorityOperationReceipt>;
}): Promise<AuthorityOperationReceipt> {
  if (!input.budget) return input.work();
  const admission = input.budget.reserve({ plane: "authority", operations: 1, bytes: input.bytes });
  if (!admission.ok) {
    const reason = admission.error._tag === "WriteRejected"
      ? admission.error.reason
      : "Shared daemon admission failed. Run 'ha daemon status --json', wait for current writes to settle, then retry the exact command.";
    return {
      tag: "RETRYABLE_NOT_COMMITTED",
      workspaceId: input.identity.workspaceId,
      opId: input.identity.opId,
      semanticDigest: input.semanticDigest,
      reason
    };
  }
  try {
    return await input.work();
  } finally {
    admission.reservation.release();
  }
}
