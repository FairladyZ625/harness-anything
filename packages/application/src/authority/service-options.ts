import type { DaemonAdmissionBudget } from "@harness-anything/kernel";
import type {
  AuthorityCommittedEventPublisherV2,
  AuthorityCommittedReceipt,
  AuthorityRecoveryAttemptV2,
  AttributedCoordinatorFactory,
  AuthorityFenceWitness,
  AuthorityGenerationFence,
  AuthorityOperationRegistry,
  CanonicalPublicationInspector,
  DelegationTokenVerifier,
  ReplicaChangeLog
} from "./types.ts";
import type {
  ActorAxesBindingRuntimeV2,
  ProtocolSchemaTupleV2
} from "./actor-axes-binding-v2.ts";
import type {
  AuthoritySemanticCompilerV2,
  OperationNamespaceVerifierV2
} from "./semantic-mutation-envelope-v2.ts";
import type { EntityRefPrefixMatcherV2 } from "./semantic-authorizer-v2.ts";
import type { ShadowPublicationLog } from "./shadow.ts";
import type { createWritableEntityRegistry } from "@harness-anything/kernel";

export interface AuthoritySubmissionServiceOptions {
  readonly workspaceId: string;
  readonly coordinatorFactory: AttributedCoordinatorFactory;
  readonly tokenVerifier: DelegationTokenVerifier;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly publicationInspector: CanonicalPublicationInspector;
  readonly publicationExecutor?: { readonly run: <Result>(publication: () => Promise<Result>) => Promise<Result> };
  readonly fenceWitness: AuthorityFenceWitness;
  /** Optional so legacy and Windows-degraded daemon paths retain their prior byte and write behavior. */
  readonly generationFenceWitness?: AuthorityGenerationFence;
  readonly shadowPublicationLog?: ShadowPublicationLog;
  readonly now?: () => string;
  readonly v2?: AuthoritySubmissionV2Options;
  readonly admissionBudget?: DaemonAdmissionBudget;
}

export interface AuthoritySubmissionV2Options {
  readonly schemaTuple: ProtocolSchemaTupleV2;
  readonly channelNonceDigest: Uint8Array;
  readonly bindingRuntime: ActorAxesBindingRuntimeV2;
  readonly entityRegistrations: Parameters<typeof createWritableEntityRegistry>[0];
  readonly semanticCompiler: AuthoritySemanticCompilerV2;
  readonly operationNamespaceVerifier: OperationNamespaceVerifierV2;
  readonly committedEventPublisher: AuthorityCommittedEventPublisherV2;
  readonly recoverCommittedReceipt?: (record: import("./types.ts").AuthorityStoredOperationRecord) => Promise<AuthorityCommittedReceipt>;
  /** Current repo writer ownership axes, independent of key authority generation. */
  readonly recoveryScope?: {
    readonly repoId: string;
    readonly writerGeneration: number;
  };
  /**
   * Must prove this exact attempt belongs to a durable outer PROCEEDING record.
   * Without this callback the temporal/revocation recovery API is not exposed.
   */
  readonly runAuthorizedRecoveryAttempt?: <Result>(
    recovery: AuthorityRecoveryAttemptV2,
    resume: () => Promise<Result>
  ) => Promise<Result>;
  readonly matchEntityRefPrefix?: EntityRefPrefixMatcherV2;
}
