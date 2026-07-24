import type {
  ConsentAction,
  CurrentSessionRef,
  DecisionClaimFulfillment,
  DomainStatus,
  FactMemoryClass,
  FactMemoryTag,
  HarnessLayoutInput,
  HarnessLayoutOverrides,
  PriorityTier,
  RelationType,
  ReviewVerdict,
  SemanticDiffDocumentPolicy,
  OperationalActor,
  TaskWorkKind,
  TaskHolderExecutor,
  TaskHolderPersonPrincipal,
  VcsCommitAuthor,
  WriteAttribution,
  WriteCoordinator
} from "@harness-anything/kernel";
import type * as EffectNamespace from "effect";
import type { ProvenanceSessionExporterRejected, ProvenanceSessionExportResult } from "../provenance-session-exporter.ts";
import type { LocalControllerServiceOptions } from "../local-controller-runtime-options.ts";
import type { DaemonLogService } from "../daemon-log-contract.ts";
import type { DaemonStatusResultV2 } from "../daemon-status-contract.ts";

export interface AuthorityHostEvidenceInput {
  readonly type: string;
  readonly path: string;
  readonly summary: string;
}

export interface AuthorityHostDecisionChoiceInput {
  readonly id?: string;
  readonly text: string;
  readonly load_bearing?: boolean;
}

export interface AuthorityHostDecisionRejectedInput {
  readonly id?: string;
  readonly text: string;
  readonly why_not?: string;
}

export interface AuthorityHostDecisionClaimInput {
  readonly id?: string;
  readonly text: string;
  readonly load_bearing?: boolean;
  readonly fulfillment?: DecisionClaimFulfillment;
}

export interface AuthorityHostDecisionClaimFulfillmentInput {
  readonly claimId: string;
  readonly fulfillment: DecisionClaimFulfillment;
}

export interface AuthorityHostDecisionEvidenceRelationInput {
  readonly anchor: string;
  readonly type: RelationType;
  readonly target: string;
  readonly rationale: string;
}

export type AuthorityHostNewTaskAction = {
  readonly kind: "new-task";
  readonly taskId?: string;
  readonly title: string;
  readonly parent?: string;
  readonly slug: string;
  readonly allowManualId: boolean;
  readonly fromLegacyId?: string;
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly vertical?: string;
  readonly preset?: string;
  readonly profile?: string;
  readonly moduleKey?: string;
  readonly registerModule?: { readonly key: string; readonly title: string; readonly prefix?: string; readonly scope: string };
  readonly longRunning: boolean;
  readonly dryRun: boolean;
  readonly locale?: "zh-CN" | "en-US";
};

export type AuthorityHostDecisionProposeAction = {
  readonly kind: "decision-propose";
  readonly decisionId: string;
  readonly decisionIdProvided?: boolean;
  readonly proposedAt: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: ReadonlyArray<AuthorityHostDecisionChoiceInput>;
  readonly rejected: ReadonlyArray<AuthorityHostDecisionRejectedInput>;
  readonly claim?: string;
  readonly claims: ReadonlyArray<AuthorityHostDecisionClaimInput>;
  readonly claimLoadBearing: boolean;
  readonly fulfillments: ReadonlyArray<AuthorityHostDecisionClaimFulfillmentInput>;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly modules: ReadonlyArray<string>;
  readonly productLines: ReadonlyArray<string>;
  readonly evidenceRelations: ReadonlyArray<AuthorityHostDecisionEvidenceRelationInput>;
  readonly body?: string;
  readonly dryRun: boolean;
};

export type AuthorityHostCommandAction =
  | AuthorityHostNewTaskAction
  | { readonly kind: "task-claim"; readonly taskId: string; readonly executionId?: string }
  | { readonly kind: "task-retire-execution"; readonly taskId: string; readonly executionId: string; readonly reason: string; readonly retiredAt: string }
  | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus; readonly force: boolean; readonly reason?: string; readonly executionSubmission?: { readonly executionId?: string; readonly leaseToken?: string; readonly completionClaim: string; readonly deliverables: ReadonlyArray<string>; readonly verificationNotes: ReadonlyArray<string>; readonly knownGaps: ReadonlyArray<string>; readonly residualRisks: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> } }
  | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string; readonly evidence?: ReadonlyArray<AuthorityHostEvidenceInput> }
  | { readonly kind: "task-amend"; readonly taskId: string; readonly patches: ReadonlyArray<{ readonly field: string; readonly value: string }> }
  | { readonly kind: "task-archive"; readonly taskId?: string; readonly ids?: ReadonlyArray<string>; readonly reason: string }
  | { readonly kind: "task-supersede"; readonly oldTaskId: string; readonly byTaskId?: string }
  | { readonly kind: "task-delete"; readonly taskId: string; readonly mode: "soft" | "hard"; readonly reason: string }
  | { readonly kind: "task-reopen"; readonly taskId: string; readonly reason: string }
  | { readonly kind: "task-code-doc-reconcile"; readonly taskId: string; readonly sha: string; readonly paths: ReadonlyArray<string>; readonly prRef?: string; readonly force: boolean }
  | { readonly kind: "task-consent-record"; readonly taskId: string; readonly executionId: string; readonly utterance?: string; readonly standingPolicyDecisionId?: string; readonly assertedRationale?: string; readonly consentActions: ReadonlyArray<ConsentAction> }
  | { readonly kind: "task-review-execution"; readonly taskId: string; readonly executionId?: string; readonly verdict: ReviewVerdict; readonly findings: string; readonly evidenceChecked: ReadonlyArray<string>; readonly rationale: string; readonly archiveWarningsAcknowledged: boolean; readonly consentId?: string; readonly generatedConsentId?: string; readonly consentUtterance?: string; readonly consentStandingPolicyDecisionId?: string; readonly consentAssertedRationale?: string; readonly consentActions?: ReadonlyArray<ConsentAction> }
  | {
      readonly kind: "task-complete";
      readonly taskId: string;
      readonly completionContractBodySha256?: string | null;
    }
  | { readonly kind: "task-relate"; readonly sourceTaskId: string; readonly relationType: "depends-on"; readonly targetTaskId: string; readonly rationale: string }
  | AuthorityHostDecisionProposeAction
  | { readonly kind: "decision-transition"; readonly transition: "accept" | "reject" | "defer" | "supersede" | "retire"; readonly decisionId: string }
  | { readonly kind: "decision-amend"; readonly decisionId: string }
  | { readonly kind: "decision-relate"; readonly decisionId: string; readonly anchor: string; readonly relationType: RelationType; readonly target: string; readonly rationale: string }
  | { readonly kind: "decision-relation-retire"; readonly decisionId: string; readonly relationId: string }
  | { readonly kind: "decision-relation-replace"; readonly decisionId: string; readonly relationId: string }
  | { readonly kind: "record-fact"; readonly taskId: string; readonly factId: string; readonly factIdProvided?: boolean; readonly statement: string; readonly source?: string; readonly observedAt: string; readonly confidence: "low" | "medium" | "high"; readonly memoryClass: FactMemoryClass; readonly memoryTags: ReadonlyArray<FactMemoryTag>; readonly dryRun: boolean }
  | { readonly kind: "fact-invalidate"; readonly taskId: string; readonly factId: string; readonly invalidatedByFactId: string; readonly rationale: string }
  | { readonly kind: "session-export"; readonly sessionId?: string; readonly runtime?: "claude-code" | "codex" | "zcode" | "antigravity"; readonly source?: "runtime" | "manual"; readonly detectedAt?: string; readonly user?: string; readonly transcriptFile?: string }
  | { readonly kind: "preset-entrypoint"; readonly presetId: string; readonly taskId: string }
  | { readonly kind: "script-run"; readonly scriptId: string; readonly taskId?: string }
  | { readonly kind: "module-register"; readonly moduleKey: string; readonly title: string; readonly scope: string; readonly prefix?: string; readonly status?: string; readonly branch?: string; readonly owner?: string; readonly currentStep?: string; readonly shared: ReadonlyArray<string>; readonly dependsOn: ReadonlyArray<string> }
  | { readonly kind: "module-unregister"; readonly moduleKey: string }
  | { readonly kind: "module-step"; readonly moduleKey: string; readonly stepId: string; readonly state: "planned" | "in-progress" | "blocked" | "done" };

/** The normalized command fields consumed by the daemon authority host; CLI grammar stays CLI-owned. */
export interface AuthorityHostCommand {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly action: AuthorityHostCommandAction;
}

export interface AuthorityHostAttribution {
  readonly writeAttribution: WriteAttribution;
  readonly commitAuthor: VcsCommitAuthor;
  readonly taskHolderPrincipal: TaskHolderPersonPrincipal;
  readonly executor: TaskHolderExecutor | null;
}

export interface AuthorityHostCommandContext {
  readonly command: AuthorityHostCommand;
  readonly attribution: AuthorityHostAttribution;
  readonly currentSession: CurrentSessionRef;
}

export type AuthorityIngressAdapter = "generic" | "decision-transition" | "task-claim" | "observed-write";

export interface MaterializerCommandReport {
  readonly dryRun: boolean;
  readonly merged: number;
  readonly considered: number;
  readonly branches: ReadonlyArray<{
    readonly branch: string;
    readonly commitCount: number;
    readonly status: "merged" | "would_merge" | "skipped" | "conflict";
    readonly commits: ReadonlyArray<string>;
    readonly warning?: string;
    readonly nextCommand?: string;
    readonly conflictPaths?: ReadonlyArray<string>;
    readonly preservedArtifacts?: ReadonlyArray<{
      readonly originalPath: string;
      readonly preservedPath: string;
      readonly sourceBranch: string;
      readonly sha256: string;
    }>;
  }>;
  readonly warnings: ReadonlyArray<unknown>;
}

/** Minimal normalized command shape consumed by the daemon command host. CLI grammar stays CLI-owned. */
export interface DaemonHostCommand {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly action: {
    readonly kind: string;
    readonly dryRun?: boolean;
  };
}

/** Minimal result shape the daemon augments with materialization warnings before CLI receipt encoding. */
export interface DaemonHostCommandResult {
  readonly ok: boolean;
  readonly command: string;
  readonly warnings?: ReadonlyArray<unknown>;
}

export interface DaemonHostCommandExecutionOptions {
  readonly requireProvidedActorAttribution: true;
  /** Child-writer pilot admission must not renew/write a v1 holder lease. */
  readonly taskLeaseGuardMode?: "read-only";
  readonly actorAttribution?: AuthorityHostAttribution;
  readonly currentSession?: CurrentSessionRef;
  readonly inlineCreateProvenanceOnly?: true;
  readonly syncExportedSession: (
    result: ProvenanceSessionExportResult
  ) => EffectNamespace.Effect.Effect<void, ProvenanceSessionExporterRejected>;
  readonly makeWriteCoordinator: (actor: OperationalActor) => WriteCoordinator;
  readonly makeMigrationWriteCoordinator: (
    actor: OperationalActor,
    evidenceRef: string
  ) => WriteCoordinator;
  readonly makeOperationalWriteCoordinator: (
    actor: OperationalActor
  ) => WriteCoordinator;
}

export type DaemonCommandHostError =
  | { readonly code: "invalid_session"; readonly context: { readonly cause: string } }
  | { readonly code: "auth_missing"; readonly context: { readonly cause: string } };

/** CLI-owned parser/executor/error/receipt adapters consumed by the daemon command service. */
export interface DaemonCommandHostServices<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult,
  Actor = unknown
> {
  readonly parseCommandPayload: (payload: Readonly<Record<string, unknown>> | undefined) => Command;
  readonly normalizeCommand: (command: Command, currentSession: CurrentSessionRef) => Promise<Command>;
  readonly authorityCommand: (command: Command) => AuthorityHostCommand | undefined;
  readonly authorityIngressFor: (kind: string) => AuthorityIngressAdapter | undefined;
  readonly actorAttribution: (
    actor: Actor,
    command: Command,
    executor: TaskHolderExecutor | null
  ) => AuthorityHostAttribution;
  readonly migrationWriteAttribution: (attribution: WriteAttribution, evidenceRef: string) => WriteAttribution;
  readonly isActorAttributionError: (error: unknown) => boolean;
  readonly isDryRunAction: (command: Command) => boolean;
  readonly executeCommand: (command: Command, options: DaemonHostCommandExecutionOptions) => Promise<Result>;
  readonly materializerCommandResult: (report: MaterializerCommandReport) => Result;
  readonly toReceipt: (result: DaemonHostCommandResult) => import("../command-receipt.ts").CommandReceiptEnvelope;
  readonly toErrorReceipt: (input: {
    readonly command: string;
    readonly error: DaemonCommandHostError;
  }) => import("../command-receipt.ts").CommandReceiptEnvelope;
}

export type DaemonControlHostError =
  | { readonly code: "daemon_refresh_build_failed"; readonly context: { readonly cause: string } }
  | { readonly code: "daemon_queue_drain_timeout"; readonly context: { readonly kind: "restart" | "refresh" | "upgrade" } };

/** CLI presents structured daemon errors; the shared contract carries no hint text. */
export interface DaemonControlErrorHostServices<PresentedError> {
  readonly present: (error: DaemonControlHostError) => PresentedError;
}

export interface DaemonDocSyncHostServices {
  readonly resolveManagedSectionPolicy: (
    rootInput: HarnessLayoutInput,
    relativePath: string
  ) => SemanticDiffDocumentPolicy | null;
}

export interface DaemonServiceHostServices<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult,
  Actor,
  Runtime,
  Identity,
  PresentedControlError = unknown
> {
  readonly command: DaemonCommandHostServices<Command, Result, Actor>;
  readonly errors: DaemonControlErrorHostServices<PresentedControlError>;
  readonly docSync: DaemonDocSyncHostServices;
  readonly loadDaemonIdentity: (
    rootDir: string,
    layoutOverrides: { readonly authoredRoot?: string } | undefined,
    endpoint?: string,
    userRoot?: string
  ) => Identity;
  readonly daemonActorAttribution: (
    actor: Actor,
    executor: TaskHolderExecutor | null
  ) => AuthorityHostAttribution;
  readonly makeGuiControllerOptions: (
    runtime: Runtime,
    rootInput: Exclude<HarnessLayoutInput, string>,
    commandOptions: { readonly onCommandStart: () => void; readonly onCommandSettled: () => void }
  ) => Pick<LocalControllerServiceOptions, "catalogSnapshotReader" | "decisionMutationPort">;
  readonly leaseEnforcementEnabled: (rootInput: HarnessLayoutInput) => boolean;
  readonly version: () => string;
}

/** CLI-owned launch persistence/projection and authority composition injected into the daemon serve root. */
export interface DaemonServeHostServices<LaunchConfiguration, AuthorityLifecycle> {
  readonly persistLaunchConfiguration: (
    userRoot: string,
    configuration: LaunchConfiguration,
    effectiveOptions: { readonly authorityManifest?: string; readonly authoredRoot?: string }
  ) => void;
  readonly createAuthorityLifecycle: (input: {
    readonly manifestPath: string;
    readonly daemonLogService: DaemonLogService;
    readonly backgroundRecovery: true;
    readonly layoutOverrides?: HarnessLayoutOverrides;
  }) => AuthorityLifecycle;
  readonly projectStartedStatus: (status: DaemonStatusResultV2) => Record<string, unknown>;
}
