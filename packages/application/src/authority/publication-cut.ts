import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { AuthorityOperationReceipt } from "./types.ts";
import type {
  AuthorityAdmission,
  PreparedAuthoritySubmission
} from "./service-admission-types.ts";

export interface AuthorityPublicationCut {
  readonly settle: () => Promise<ReadonlyArray<AuthorityOperationReceipt>>;
}

export function completedPublicationCut(
  receipts: ReadonlyArray<AuthorityOperationReceipt>
): AuthorityPublicationCut {
  return { settle: async () => receipts };
}

export async function settleAuthorityPublicationCut(
  cut: AuthorityPublicationCut
): Promise<ReadonlyArray<AuthorityOperationReceipt>> {
  // Durable acceptance is reported at the replica cut. Give its transport
  // continuation one turn before synchronous Git proof work begins.
  await nextEventLoopTurn();
  return cut.settle();
}

export function segmentedPublicationCut(
  admissions: ReadonlyArray<AuthorityAdmission>,
  cuts: ReadonlyArray<{
    readonly segment: ReadonlyArray<PreparedAuthoritySubmission>;
    readonly cut: AuthorityPublicationCut;
  }>
): AuthorityPublicationCut {
  return { settle: async () => {
    const settled = new Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>();
    for (const { segment, cut } of cuts) {
      const segmentReceipts = await cut.settle();
      segment.forEach((candidate, index) => settled.set(candidate, segmentReceipts[index]!));
    }
    return admissions.map((admission) => admission.kind === "terminal"
      ? admission.receipt
      : settled.get(admission)!);
  } };
}
