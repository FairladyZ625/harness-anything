import type {
  DomainStatus,
  FactMemoryClass,
  FactMemoryTag,
  PriorityTier,
  RelationType,
  RuntimeEventApprovalDecision,
  RuntimeEventInterruptAction,
  RuntimeEventKind,
  RuntimeEventRuntime,
  RuntimeEventResultStatus,
  ReviewVerdict,
  ConsentAction,
  TaskWorkKind
} from "../../../kernel/src/index.ts";
import type { DecisionAmendField, DecisionAmendOperation } from "../../../kernel/src/index.ts";
import type { DecisionClaimFulfillment } from "../../../kernel/src/index.ts";
import type { HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import type { CliError } from "./error-codes.ts";

export type CheckProfile = "source-package" | "private-harness" | "target-project";
export type GovernanceRebuildMode = "dry-run" | "archive" | "apply";
export type LessonCommandMode = "dry-run" | "apply";
export type AnchorBackfillMode = "dry-run" | "apply";
export type ProvenanceBackfillMode = "dry-run" | "apply";
export type TaskListLessonFilter = "present" | "missing";
export type SessionExportRuntime = "claude-code" | "codex" | "zcode" | "antigravity";
export type SessionExportSource = "runtime" | "manual";

export interface TaskListFilters {
  readonly state?: string;
  readonly moduleKey?: string;
  readonly queue?: string;
  readonly preset?: string;
  readonly workKind?: TaskWorkKind;
  readonly riskTier?: PriorityTier;
  readonly urgency?: PriorityTier;
  readonly review?: string;
  readonly lesson?: TaskListLessonFilter;
  readonly missingMaterials: boolean;
  readonly includeArchived: boolean;
  readonly search?: string;
  readonly fieldExtensions?: ReadonlyArray<{
    readonly field: string;
    readonly column: string;
    readonly value: string;
  }>;
}

export interface RelationListFilters {
  readonly entity?: string;
  readonly source?: string;
  readonly target?: string;
  readonly type?: RelationType;
  readonly state?: "active" | "retired";
}

export interface EvidenceAppendInput {
  readonly type: string;
  readonly path: string;
  readonly summary: string;
}

export interface DecisionEvidenceRelationInput {
  readonly anchor: string;
  readonly type: RelationType;
  readonly target: string;
  readonly rationale: string;
}

export interface DecisionClaimInput {
  readonly id?: string;
  readonly text: string;
  readonly load_bearing?: boolean;
  readonly fulfillment?: DecisionClaimFulfillment;
}

export interface DecisionClaimFulfillmentInput {
  readonly claimId: string;
  readonly fulfillment: DecisionClaimFulfillment;
}

export interface DecisionChoiceInput {
  readonly id?: string;
  readonly text: string;
  readonly load_bearing?: boolean;
}

export interface DecisionRejectedInput {
  readonly id?: string;
  readonly text: string;
  readonly why_not?: string;
}

export interface DecisionAmendPatchInput {
  readonly field: DecisionAmendField;
  readonly operation: DecisionAmendOperation;
  readonly value: string;
}

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
  readonly decisionId?: string;
  readonly executionId?: string;
  readonly reviewId?: string;
  readonly consentId?: string;
  readonly sessionId?: string;
  readonly factId?: string;
  readonly factRef?: string;
  readonly decisionState?: string;
  readonly slug?: string;
  readonly status?: DomainStatus;
  readonly path?: string;
  readonly packagePath?: string;
  readonly projectionPath?: string;
  readonly mode?: GovernanceRebuildMode | LessonCommandMode | "soft" | "hard";
  readonly migrationMode?: "plan" | "apply";
  readonly tasks?: ReadonlyArray<unknown>;
  readonly templates?: ReadonlyArray<unknown>;
  readonly presets?: ReadonlyArray<unknown>;
  readonly preset?: unknown;
  readonly scripts?: ReadonlyArray<unknown>;
  readonly script?: unknown;
  readonly runId?: string;
  readonly modules?: ReadonlyArray<unknown>;
  readonly module?: unknown;
  readonly document?: unknown;
  readonly evidenceBundle?: string;
  readonly issues?: ReadonlyArray<unknown>;
  readonly rows?: number;
  readonly warnings?: ReadonlyArray<unknown>;
  readonly version?: string;
  readonly shell?: "bash" | "zsh";
  readonly completionScript?: string;
  readonly report?: unknown;
  readonly snapshot?: unknown;
  readonly profile?: CheckProfile;
  readonly generated?: ReadonlyArray<string>;
  readonly reviewContract?: unknown;
  readonly completionGate?: unknown;
  readonly capabilityReceipt?: unknown;
  readonly forced?: boolean;
  readonly forceAudit?: {
    readonly path: string;
    readonly marker: string;
  };
  readonly summary?: {
    readonly taskCount: number;
    readonly byPackageDisposition: Record<string, number>;
    readonly byCoordinationStatus: Record<string, number>;
  };
  readonly commands?: ReadonlyArray<CommandRegistryEntry>;
  readonly launchPlan?: {
    readonly packageName: "@harness-anything/gui";
    readonly mode: "local-desktop-controller";
    readonly apiHost: "127.0.0.1";
    readonly delegated: true;
    readonly dryRun: boolean;
    readonly command: readonly string[];
    readonly pid?: number;
  };
  readonly error?: CliError;
}

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

export type CommandReceiptEnvelope = "command-receipt/v2";

export interface CommandRegistryEntry {
  readonly kind: string;
  readonly primary: string;
  readonly aliases: ReadonlyArray<string>;
  readonly commandPath: ReadonlyArray<string>;
  readonly summary: string;
  readonly options: ReadonlyArray<CommandHelpOption>;
  readonly examples: ReadonlyArray<string>;
  readonly resultEnvelope: CommandReceiptEnvelope;
}

export interface CommandHelpOption {
  readonly flag: string;
  readonly description: string;
}

export interface ParsedCommand {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly daemonRepoId?: string;
  readonly actor?: string;
  readonly daemonModeOverride?: "direct" | "local" | "remote";
  readonly daemonProfileOverride?: "default" | "isolated";
  readonly json: boolean;
  readonly action:
    | { readonly kind: "init"; readonly addNpmScripts: boolean; readonly projectName?: string }
    | { readonly kind: "new-task"; readonly taskId?: string; readonly title: string; readonly parent?: string; readonly slug: string; readonly allowManualId: boolean; readonly fromLegacyId?: string; readonly titleProvided: boolean; readonly slugProvided: boolean; readonly workKind?: TaskWorkKind; readonly riskTier?: PriorityTier; readonly urgency?: PriorityTier; readonly vertical?: string; readonly preset?: string; readonly profile?: string; readonly moduleKey?: string; readonly registerModule?: { readonly key: string; readonly title: string; readonly prefix?: string; readonly scope: string }; readonly longRunning: boolean; readonly dryRun: boolean; readonly locale?: "zh-CN" | "en-US" }
    | { readonly kind: "task-claim"; readonly taskId: string; readonly ttlMs?: number; readonly execution?: boolean; readonly executionId?: string }
    | { readonly kind: "task-holder"; readonly taskId: string }
    | { readonly kind: "task-release"; readonly taskId: string }
    | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus; readonly force: boolean; readonly reason?: string; readonly executionSubmission?: { readonly executionId?: string; readonly leaseToken?: string; readonly completionClaim: string; readonly deliverables: ReadonlyArray<string>; readonly verificationNotes: ReadonlyArray<string>; readonly knownGaps: ReadonlyArray<string>; readonly residualRisks: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> } }
    | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string; readonly evidence?: ReadonlyArray<EvidenceAppendInput> }
    | { readonly kind: "task-amend"; readonly taskId: string; readonly patches: ReadonlyArray<{ readonly field: string; readonly value: string }> }
    | { readonly kind: "task-contract-migrate"; readonly mode: "dry-run" | "apply"; readonly taskId?: string }
    | { readonly kind: "task-archive"; readonly taskId?: string; readonly ids?: ReadonlyArray<string>; readonly filter?: string; readonly before?: string; readonly reason: string; readonly archivedBy?: string; readonly archiveField?: string }
    | { readonly kind: "task-supersede"; readonly oldTaskId: string; readonly title?: string; readonly slug?: string; readonly reason: string; readonly byTaskId?: string; readonly confirm?: string; readonly allowOpenFindings: boolean; readonly deletedBy?: string }
    | { readonly kind: "task-delete"; readonly taskId: string; readonly mode: "soft" | "hard"; readonly reason: string; readonly confirm?: string; readonly deletedBy?: string }
    | { readonly kind: "task-reopen"; readonly taskId: string; readonly reason: string }
    | { readonly kind: "task-code-doc-reconcile"; readonly taskId: string; readonly sha: string; readonly paths: ReadonlyArray<string>; readonly prRef?: string; readonly force: boolean }
    | { readonly kind: "task-review"; readonly taskId: string; readonly reviewerId: string }
    | { readonly kind: "task-consent-record"; readonly taskId: string; readonly executionId: string; readonly utterance: string; readonly consentActions?: ReadonlyArray<ConsentAction> }
    | { readonly kind: "task-review-execution"; readonly taskId: string; readonly executionId: string; readonly verdict: ReviewVerdict; readonly findings: string; readonly evidenceChecked: ReadonlyArray<string>; readonly rationale: string; readonly archiveWarningsAcknowledged: boolean; readonly consentId?: string; readonly consentUtterance?: string; readonly consentActions?: ReadonlyArray<ConsentAction> }
    | { readonly kind: "task-complete"; readonly taskId: string; readonly ciGate?: "passed" | "failed"; readonly reviewerId: string }
    | { readonly kind: "task-show"; readonly taskId: string; readonly view: "summary" | "trace" | "tree" }
    | { readonly kind: "session-show"; readonly sessionId: string; readonly view: "summary" | "trace" }
    | { readonly kind: "execution-show"; readonly executionId: string }
    | { readonly kind: "execution-list"; readonly taskId: string }
    | { readonly kind: "review-show"; readonly reviewId: string }
    | { readonly kind: "audit-provenance"; readonly taskId: string }
    | { readonly kind: "task-relate"; readonly sourceTaskId: string; readonly relationType: "depends-on"; readonly targetTaskId: string; readonly rationale: string; readonly dryRun: boolean }
    | { readonly kind: "relation-list"; readonly filters: RelationListFilters }
    | { readonly kind: "decision-list"; readonly search?: string; readonly legacyId?: string; readonly legacyRange?: string; readonly state?: string; readonly moduleKey?: string; readonly productLine?: string; readonly compact?: boolean }
    | { readonly kind: "decision-show"; readonly selector: string }
    | { readonly kind: "decision-verify"; readonly decisionIds?: ReadonlyArray<string> }
    | { readonly kind: "decision-repin"; readonly decisionId: string; readonly migrationEvidence: string }
    | { readonly kind: "decision-propose"; readonly decisionId?: string; readonly title: string; readonly question: string; readonly chosen: ReadonlyArray<DecisionChoiceInput>; readonly rejected: ReadonlyArray<DecisionRejectedInput>; readonly claim?: string; readonly claims: ReadonlyArray<DecisionClaimInput>; readonly claimLoadBearing: boolean; readonly fulfillments: ReadonlyArray<DecisionClaimFulfillmentInput>; readonly riskTier: "low" | "medium" | "high"; readonly urgency: "low" | "medium" | "high"; readonly modules: ReadonlyArray<string>; readonly productLines: ReadonlyArray<string>; readonly evidenceRelations: ReadonlyArray<DecisionEvidenceRelationInput>; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "decision-transition"; readonly transition: "accept" | "reject" | "defer" | "supersede" | "retire"; readonly decisionId: string; readonly decidedAt?: string; readonly judgmentOnlyRationale?: string; readonly standingPolicy?: boolean; readonly fulfillments: ReadonlyArray<DecisionClaimFulfillmentInput>; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "decision-reckon"; readonly decisionId: string; readonly taskId: string; readonly dryRun: boolean }
    | { readonly kind: "decision-amend"; readonly decisionId: string; readonly title?: string; readonly standingPolicy?: boolean; readonly fulfillments: ReadonlyArray<DecisionClaimFulfillmentInput>; readonly body?: string; readonly patches: ReadonlyArray<DecisionAmendPatchInput>; readonly dryRun: boolean }
    | { readonly kind: "decision-relate"; readonly decisionId: string; readonly anchor: string; readonly relationType: RelationType; readonly target: string; readonly rationale: string; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "decision-relation-retire"; readonly decisionId: string; readonly relationId: string; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "decision-relation-replace"; readonly decisionId: string; readonly relationId: string; readonly anchor: string; readonly relationType: RelationType; readonly target: string; readonly rationale: string; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "fact-list"; readonly taskId: string }
    | { readonly kind: "fact-show"; readonly taskId: string; readonly factId: string }
    | { readonly kind: "record-fact"; readonly taskId: string; readonly factId?: string; readonly statement: string; readonly source: string; readonly observedAt?: string; readonly confidence: "low" | "medium" | "high"; readonly memoryClass: FactMemoryClass; readonly memoryTags: ReadonlyArray<FactMemoryTag>; readonly dryRun: boolean }
    | { readonly kind: "fact-invalidate"; readonly taskId: string; readonly factId: string; readonly invalidatedByFactId: string; readonly rationale: string; readonly dryRun: boolean }
    | { readonly kind: "distill-candidate"; readonly taskId: string; readonly inputPath: string }
    | { readonly kind: "distill-commit"; readonly taskId: string; readonly candidatePath: string; readonly claim: string; readonly factId?: string; readonly observedAt?: string; readonly confidence: "low" | "medium" | "high"; readonly memoryClass: FactMemoryClass; readonly memoryTags: ReadonlyArray<FactMemoryTag> }
    | { readonly kind: "runtime-event-append"; readonly sessionId: string; readonly eventKind: RuntimeEventKind; readonly runtime: RuntimeEventRuntime | "unknown"; readonly eventId?: string; readonly recordedAt?: string; readonly taskId?: string; readonly turnId?: string; readonly stepId?: string; readonly toolName?: string; readonly approval?: RuntimeEventApprovalDecision; readonly interrupt?: RuntimeEventInterruptAction; readonly result?: RuntimeEventResultStatus; readonly summary?: string; readonly totalTokens?: number }
    | { readonly kind: "runtime-event-list"; readonly sessionId: string }
    | { readonly kind: "materializer-run"; readonly dryRun: boolean }
    | { readonly kind: "session-export"; readonly sessionId?: string; readonly runtime?: SessionExportRuntime; readonly source?: SessionExportSource; readonly detectedAt?: string; readonly user?: string; readonly transcriptFile?: string }
    | { readonly kind: "session-backfill"; readonly runtime?: SessionExportRuntime; readonly limit?: number }
    | { readonly kind: "session-sync"; readonly mode: "dry-run" | "apply" }
    | { readonly kind: "doc-status" }
    | { readonly kind: "doc-sync"; readonly mode: "dry-run" | "submit"; readonly paths: ReadonlyArray<string> }
    | { readonly kind: "task-list"; readonly filters: TaskListFilters }
    | { readonly kind: "status" }
    | { readonly kind: "version" }
    | { readonly kind: "completion"; readonly shell: "bash" | "zsh" }
    | { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }
    | { readonly kind: "governance-rebuild"; readonly mode: GovernanceRebuildMode }
    | { readonly kind: "lesson-promote"; readonly taskId: string; readonly candidateId: string; readonly mode: LessonCommandMode }
    | { readonly kind: "lesson-sediment"; readonly taskId: string; readonly candidateId: string; readonly mode: "dry-run"; readonly title: string }
    | { readonly kind: "adopt-multica"; readonly taskId: string; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "external-snapshot"; readonly provider: "github"; readonly ref: string }
    | { readonly kind: "external-snapshot"; readonly provider: "multica"; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "external-list"; readonly provider: "github"; readonly repository: string; readonly rawStatus?: string; readonly label?: string }
    | { readonly kind: "migrate-plan"; readonly limit: number }
    | { readonly kind: "migrate-structure"; readonly mode: "plan" | "apply"; readonly confirmPlan: boolean }
    | { readonly kind: "migrate-anchors"; readonly mode: AnchorBackfillMode }
    | { readonly kind: "migrate-fact-execution"; readonly mode: "dry-run" | "apply"; readonly batchSize: number; readonly batch: number; readonly sampleSize: number; readonly confirmPlan?: string; readonly manualListFile?: string }
    | { readonly kind: "migrate-retired-attribution-fields"; readonly mode: "dry-run" | "apply"; readonly batchSize: number; readonly confirmPlan?: string; readonly evidenceRef?: string }
    | { readonly kind: "migrate-provenance"; readonly mode: ProvenanceBackfillMode }
    | { readonly kind: "migrate-run"; readonly planOnly: boolean; readonly outDir: string; readonly locale?: "zh-CN" | "en-US"; readonly assumeLocale?: "zh-CN" | "en-US"; readonly allowDirty: boolean; readonly sessionDir?: string }
    | { readonly kind: "migrate-verify"; readonly sessionPath?: string; readonly fullCutover: boolean }
    | { readonly kind: "legacy-scan"; readonly sourcePath: string }
    | { readonly kind: "legacy-intake-plan"; readonly sourcePath: string; readonly outPath?: string }
    | { readonly kind: "legacy-copy-safe-docs"; readonly sourcePath: string; readonly apply: boolean }
    | { readonly kind: "legacy-index"; readonly sourcePath: string; readonly apply: boolean }
    | { readonly kind: "legacy-verify" }
    | { readonly kind: "git-diff"; readonly baseRef?: string }
    | { readonly kind: "doctor" }
    | { readonly kind: "diagnostics-command-usage" }
    | { readonly kind: "authority-cutover-status" }
    | { readonly kind: "authority-cutover-drain"; readonly classifications: ReadonlyArray<{ readonly opId: string; readonly disposition: "retryable-not-committed" | "indeterminate"; readonly recordedTupleDigest: string; readonly evidenceRef: string }> }
    | { readonly kind: "authority-cutover-scan"; readonly profileId: "production-final-scan/v1" }
    | { readonly kind: "authority-cutover-confirm"; readonly firstScanId: string; readonly secondScanId: string }
    | { readonly kind: "authority-cutover-boundary"; readonly boundaryId: string; readonly equalityReceiptId: string; readonly expectedSelectedSchemaTupleDigest: string }
    | { readonly kind: "authority-cutover-freeze"; readonly reason: string; readonly expectedBoundaryReceiptDigest: string }
    | { readonly kind: "authority-cutover-re-enable"; readonly boundaryId: string; readonly expectedFreezeReceiptDigest: string; readonly equalityReceiptId: string; readonly forwardFixRef: string }
    | { readonly kind: "worktree-create"; readonly taskId: string; readonly agent?: string; readonly branchPrefix?: string; readonly baseRef?: string; readonly worktreePath?: string }
    | { readonly kind: "worktree-status"; readonly taskId: string }
    | { readonly kind: "graph"; readonly outputPath?: string; readonly focus?: string; readonly projectionPath?: string; readonly includeArchived: boolean }
    | { readonly kind: "help"; readonly commandKind?: string; readonly commandPrefix?: ReadonlyArray<string> }
    | { readonly kind: "entity-list" }
    | { readonly kind: "capabilities"; readonly entityKind?: string }
    | { readonly kind: "gui" }
    | { readonly kind: "template-list"; readonly catalogPath?: string }
    | { readonly kind: "template-render"; readonly templateRef: string; readonly catalogPath?: string; readonly locale: "zh-CN" | "en-US" }
    | { readonly kind: "preset-validate"; readonly manifestPath: string; readonly kernelVersion: string }
    | { readonly kind: "preset-list" }
    | { readonly kind: "preset-inspect"; readonly presetId: string }
    | { readonly kind: "preset-check"; readonly presetId: string }
    | { readonly kind: "preset-install"; readonly sourcePath: string; readonly layer: "project" | "user" }
    | { readonly kind: "preset-seed" }
    | { readonly kind: "preset-audit" }
    | { readonly kind: "preset-uninstall"; readonly presetId: string; readonly layer: "project" | "user"; readonly dryRun: boolean }
    | { readonly kind: "preset-entrypoint"; readonly presetId: string; readonly entrypointName: string; readonly entrypointType: "run" | "action"; readonly taskId: string; readonly allowScripts: boolean; readonly inputs: Record<string, string> }
    | { readonly kind: "script-list"; readonly source?: "user" | "vertical" | "preset"; readonly purpose?: "scaffold" | "generate" | "transform" | "audit"; readonly scriptKind?: "action" | "check" }
    | { readonly kind: "script-inspect"; readonly scriptId: string }
    | { readonly kind: "script-run"; readonly scriptId: string; readonly taskId?: string; readonly dryRun: boolean; readonly inputs: Record<string, string> }
    | { readonly kind: "module-list" }
    | { readonly kind: "module-inspect"; readonly moduleKey: string }
    | { readonly kind: "module-register"; readonly moduleKey: string; readonly title: string; readonly scope: string; readonly prefix?: string; readonly status?: string; readonly branch?: string; readonly owner?: string; readonly currentStep?: string; readonly shared: ReadonlyArray<string>; readonly dependsOn: ReadonlyArray<string> }
    | { readonly kind: "module-scaffold"; readonly moduleKey: string }
    | { readonly kind: "module-unregister"; readonly moduleKey: string }
    | { readonly kind: "module-step"; readonly moduleKey: string; readonly stepId: string; readonly state: "planned" | "in-progress" | "blocked" | "done" }
    | { readonly kind: "vertical-validate"; readonly definitionPath?: string };
}
