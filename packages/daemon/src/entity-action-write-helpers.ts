import type { AuthorizationDecision, WriteReceiptDraft } from "../../kernel/src/index.ts";

export function noChanges(input: {
  readonly opId: string;
  readonly revision: number;
  readonly evidence: string;
  readonly headRevision?: number;
  readonly authorizationDecision?: AuthorizationDecision;
  readonly relationId?: string;
}): WriteReceiptDraft {
  return {
    outcome: "no_changes",
    opId: input.opId,
    revision: input.revision,
    evidence: input.evidence,
    visibility: "center",
    proof: {
      committedRevision: input.revision,
      appliedCut: input.headRevision ?? input.revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: input.relationId ? null : true,
    },
    ...(input.authorizationDecision ? { authorizationDecision: input.authorizationDecision } : {}),
    ...(input.relationId ? { relationId: input.relationId } : {}),
  } as WriteReceiptDraft;
}

export function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
