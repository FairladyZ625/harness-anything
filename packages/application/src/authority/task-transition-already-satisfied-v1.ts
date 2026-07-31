import type { DomainStatus } from "@harness-anything/kernel";
import type { AuthorityAlreadySatisfiedStateProofV1 } from "./semantic-mutation-envelope-v2.ts";
import type { TaskDecisionModuleAuthorityStateV2 } from "./task-decision-module-semantic-compiler-types.ts";
import { parseTaskIndex } from "./task-index-v2.ts";

export function taskTransitionAlreadySatisfiedVerifierV1(input: {
  readonly state: TaskDecisionModuleAuthorityStateV2;
  readonly taskId: string;
  readonly path: string;
  readonly requestedStatus: DomainStatus;
}): () => Promise<AuthorityAlreadySatisfiedStateProofV1 | undefined> {
  return async () => {
    const observed = await input.state.readHostedDocument(input.path);
    if (!observed) return undefined;
    const reread = parseTaskIndex(observed.body);
    if (reread.taskId !== input.taskId || reread.status !== input.requestedStatus) {
      return undefined;
    }
    return {
      schema: "authority-already-satisfied-state-proof/v1",
      entityKind: "task",
      canonicalRef: `task/${input.taskId}`,
      path: input.path,
      field: "status",
      requestedValue: input.requestedStatus,
      observedValue: reread.status,
      observedEpoch: observed.epoch,
      observedRevision: observed.revision.toString(),
      observedBlobDigest: Buffer.from(observed.blobDigest).toString("hex")
    };
  };
}
