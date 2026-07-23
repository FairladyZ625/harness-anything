import { Effect } from "effect";
import type { AuthorityOperationIntegrity } from "@harness-anything/kernel";
import type {
  AuthorityGenerationFence,
  AuthorityIndeterminateReceipt,
  AuthorityOperationReceipt,
  AuthorityOperationState
} from "./types.ts";
import type { PreparedAuthoritySubmission } from "./service-admission-types.ts";
import { indeterminate } from "./receipt-builders.ts";

const journalEnqueueOutcomeUnknown = "JOURNAL_ENQUEUE_OUTCOME_UNKNOWN";

type PersistOperationRecord = (
  entry: PreparedAuthoritySubmission,
  semanticDigest: string,
  state: AuthorityOperationState,
  receipt?: AuthorityOperationReceipt,
  commitSha?: string,
  authorityIntegrity?: AuthorityOperationIntegrity,
  canonicalRequestEnvelope?: string
) => Promise<void>;

/**
 * V2 persists an operation recovery handle before journal enqueue. Once that
 * marker is durable, any enqueue-path failure is outcome-unknown: the journal
 * may already contain the operation, so the caller must recover by opId rather
 * than replay it. PREPARED is only persisted after enqueue returns.
 *
 * V1 has no recoverable semantic envelope, so it retains the existing thrown
 * error path.
 */
export async function enqueueWithPreEnqueueRecovery(
  entry: PreparedAuthoritySubmission,
  generationFence: AuthorityGenerationFence | undefined,
  persist: PersistOperationRecord
): Promise<AuthorityOperationReceipt | undefined> {
  const recoveryReceipt = recoveryReceiptFor(entry);
  if (recoveryReceipt) {
    await persistOperationState(entry, persist, "INDETERMINATE", recoveryReceipt);
  }

  try {
    await Effect.runPromise(entry.coordinator.enqueue(entry.operation));
    await generationFence?.assertHeld("before-prepare", entry);
    await persistOperationState(entry, persist, "PREPARED");
    return undefined;
  } catch (error) {
    if (!recoveryReceipt) throw error;
    return recoveryReceipt;
  }
}

function recoveryReceiptFor(
  entry: PreparedAuthoritySubmission
): AuthorityIndeterminateReceipt | undefined {
  if (entry.recordedProtocol.kind !== "semantic-mutation-envelope/v2") {
    return undefined;
  }
  return indeterminate(entry, entry.semanticDigest, journalEnqueueOutcomeUnknown);
}

function persistOperationState(
  entry: PreparedAuthoritySubmission,
  persist: PersistOperationRecord,
  state: Extract<AuthorityOperationState, "INDETERMINATE" | "PREPARED">,
  receipt?: AuthorityIndeterminateReceipt
): Promise<void> {
  return persist(
    entry,
    entry.semanticDigest,
    state,
    receipt,
    undefined,
    entry.authorityIntegrity,
    entry.canonicalRequestEnvelope
  );
}
