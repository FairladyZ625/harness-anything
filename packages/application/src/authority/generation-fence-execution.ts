import type {
  AuthorityFenceStage,
  AuthorityGenerationFence
} from "./types.ts";
import type { PreparedAuthoritySubmission } from "./service-admission-types.ts";
import type { PutAuthorityOperationRecord } from "./operation-record-persistence.ts";

type AuthorityFenceContext = {
  readonly workspaceId: string;
  readonly opId: string;
};

export async function runWithAuthorityGenerationFence<Result>(
  fence: AuthorityGenerationFence | undefined,
  stage: AuthorityFenceStage,
  context: AuthorityFenceContext,
  operation: () => Promise<Result>
): Promise<Result> {
  return fence ? fence.runExclusive(stage, context, operation) : operation();
}

export async function persistPreparedAuthorityEntry(
  fence: AuthorityGenerationFence | undefined,
  entry: PreparedAuthoritySubmission,
  put: PutAuthorityOperationRecord
): Promise<void> {
  await runWithAuthorityGenerationFence(fence, "before-prepare", entry, async () => {
    await fence?.assertHeld("before-prepare", entry);
    await put(
      entry,
      entry.semanticDigest,
      "PREPARED",
      undefined,
      undefined,
      entry.authorityIntegrity,
      entry.canonicalRequestEnvelope,
      entry.operation,
      entry.recoveryPublicationPolicy,
      entry.fixedOperationBinding
    );
  });
}

export async function startAuthorityCommitAtDurableCut<Result>(input: {
  readonly fence: AuthorityGenerationFence | undefined;
  readonly context: AuthorityFenceContext;
  readonly durableAcceptance: Promise<void> | undefined;
  readonly commit: () => Promise<Result>;
}): Promise<Result> {
  let pendingCommit: Promise<Result> | undefined;
  await runWithAuthorityGenerationFence(
    input.fence,
    "before-canonical-publish",
    input.context,
    async () => {
      pendingCommit = input.commit();
      await (input.durableAcceptance
        ? Promise.race([input.durableAcceptance, pendingCommit.then(() => undefined)])
        : pendingCommit);
    }
  );
  return pendingCommit!;
}
