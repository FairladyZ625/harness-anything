import type { RegistryMutationPlanInput, WriteOp } from "@harness-anything/kernel";
import type { HostedDocumentSnapshotV2, SemanticEntityBaseV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type { AuthorityAlreadySatisfiedStateProofV1, RegistryEntityRefV2 } from "./semantic-mutation-envelope-v2.ts";
import type { TaskExecutionAdmissionPortsV1 } from "./task-execution-admission-policy.ts";
import type { ReadTaskReturnToIdeaSnapshotV1 } from "./task-return-to-idea-policy.ts";

export interface TaskDecisionModuleAuthorityStateV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<SemanticEntityBaseV2 | null>;
  readonly readHostedDocument: (path: string) => Promise<HostedDocumentSnapshotV2 | null>;
}

export interface TaskDecisionModuleSemanticCompilerV2Options extends TaskExecutionAdmissionPortsV1 {
  readonly state: TaskDecisionModuleAuthorityStateV2;
  readonly taskReturnToIdeaSnapshot?: ReadTaskReturnToIdeaSnapshotV1;
}

export interface CompiledTaskDecisionModuleCommandV2 {
  readonly mutationPlan: RegistryMutationPlanInput;
  readonly operation: WriteOp;
  readonly requiredBaseRefs: ReadonlyArray<RegistryEntityRefV2>;
  readonly requiredPathSnapshots: ReadonlyArray<{ readonly path: string; readonly snapshot: HostedDocumentSnapshotV2 }>;
  readonly publicationRevalidation?: () => Promise<void>;
  readonly alreadySatisfied?: {
    readonly verify: () => Promise<AuthorityAlreadySatisfiedStateProofV1 | undefined>;
  };
}
