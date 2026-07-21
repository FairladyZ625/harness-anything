import type {
  AuthorityFenceWitness,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityRetryableReceipt
} from "./types.ts";
import type { PreparedAuthoritySubmission } from "./service-admission-types.ts";

export async function rejectStaleGeneration(
  witness: AuthorityFenceWitness | undefined,
  identity: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  semanticDigest: string
): Promise<AuthorityRetryableReceipt | undefined> {
  try {
    await witness?.assertHeld("before-prepare", identity);
    return undefined;
  } catch (error) {
    if (!isDaemonGenerationFenced(error)) throw error;
    return retryableGenerationReceipt(identity, semanticDigest, daemonGenerationFenceReason(error));
  }
}

export async function rejectGenerationFencedBatch(
  witness: AuthorityFenceWitness | undefined,
  entries: ReadonlyArray<PreparedAuthoritySubmission>,
  receipts: Map<PreparedAuthoritySubmission, AuthorityOperationReceipt>
): Promise<boolean> {
  let lost = false;
  for (const entry of entries) {
    try {
      await witness?.assertHeld("before-canonical-publish", entry);
    } catch (error) {
      if (!isDaemonGenerationFenced(error)) throw error;
      lost = true;
      receipts.set(entry, retryableGenerationReceipt(entry, entry.semanticDigest, daemonGenerationFenceReason(error)));
    }
  }
  if (!lost) return false;
  for (const entry of entries) {
    if (!receipts.has(entry)) {
      receipts.set(entry, retryableGenerationReceipt(
        entry,
        entry.semanticDigest,
        "DAEMON_GENERATION_FENCED:batch generation fence lost"
      ));
    }
  }
  return true;
}

export function isDaemonGenerationFenced(
  error: unknown
): error is Error & { readonly code: "DAEMON_GENERATION_FENCED" } {
  return error instanceof Error && "code" in error && error.code === "DAEMON_GENERATION_FENCED";
}

export function daemonGenerationFenceReason(error: Error): string {
  return `DAEMON_GENERATION_FENCED:${error.message}`;
}

function retryableGenerationReceipt(
  identity: Pick<AuthorityOperationEnvelope, "workspaceId" | "opId">,
  semanticDigest: string,
  reason: string
): AuthorityRetryableReceipt {
  return {
    tag: "RETRYABLE_NOT_COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest,
    reason
  };
}
