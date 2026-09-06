export { validateWriteReceipt } from "../../src/domain/receipt-domain-registry.ts";
import type { ReceiptAcceptanceFields } from "../../src/domain/receipt-acceptance.ts";
const pending = { state: "pending", cut: null } as const;
export const rejectedAcceptance: ReceiptAcceptanceFields = {
  status: "rejected",
  acceptance: null,
  projection: pending,
  git: { ...pending, commitSha: null },
  worktree: pending,
  replica: { state: "not_configured", cut: null },
};
export function committedAcceptance(opId: string, revision: number): ReceiptAcceptanceFields {
  const cut = { repoId: "fixture-repo", generation: 1, revision, headDigest: `sha256:${"a".repeat(64)}` } as const;
  return {
    ...rejectedAcceptance,
    status: "accepted_durable",
    acceptance: {
      storage: "sqlite",
      durability: "local_fsync",
      recordedAt: "2026-09-06T00:00:00Z",
      revisionFrom: revision,
      revisionTo: revision,
      memberOpIds: [opId],
      cut,
    },
    projection: { state: "verified", cut },
  };
}
