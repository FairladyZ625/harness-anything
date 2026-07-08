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
  TaskWorkKind
} from "../../../kernel/src/index.ts";
import type { DecisionAmendField, DecisionAmendOperation } from "../../../kernel/src/index.ts";
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

export interface DocmapFilters {
  readonly moduleKey?: string;
  readonly productLine?: string;
}

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
  readonly report?: unknown;
  readonly snapshot?: unknown;
  readonly profile?: CheckProfile;
  readonly generated?: ReadonlyArray<string>;
  readonly reviewContract?: unknown;
  readonly completionGate?: unknown;
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
  readonly branches: ReadonlyArray<unknown>;
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
  readonly json: boolean;
  readonly action:
    | { readonly kind: "init"; readonly addNpmScripts: boolean; readonly projectName?: string }
    | { readonly kind: "new-task"; readonly taskId?: string; readonly title: string; readonly parent?: string; readonly slug: string; readonly allowManualId: boolean; readonly fromLegacyId?: string; readonly titleProvided: boolean; readonly slugProvided: boolean; readonly workKind?: TaskWorkKind; readonly riskTier?: PriorityTier; readonly urgency?: PriorityTier; readonly vertical?: string; readonly preset?: string; readonly profile?: string; readonly moduleKey?: string; readonly registerModule?: { readonly key: string; readonly title: string; readonly prefix?: string; readonly scope: string }; readonly longRunning: boolean; readonly dryRun: boolean; readonly locale?: "zh-CN" | "en-US" }
    | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus; readonly force: boolean; readonly reason?: string }
    | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string; readonly evidence?: EvidenceAppendInput }
    | { readonly kind: "task-amend"; readonly taskId: string; readonly patches: ReadonlyArray<{ readonly field: string; readonly value: string }> }
    | { readonly kind: "task-archive"; readonly taskId?: string; readonly ids?: ReadonlyArray<string>; readonly filter?: string; readonly before?: string; readonly reason: string; readonly archivedBy?: string; readonly archiveField?: string }
    | { readonly kind: "task-supersede"; readonly oldTaskId: string; readonly title?: string; readonly slug?: string; readonly reason: string; readonly byTaskId?: string; readonly confirm?: string; readonly allowOpenFindings: boolean; readonly deletedBy?: string }
    | { readonly kind: "task-delete"; readonly taskId: string; readonly mode: "soft" | "hard"; readonly reason: string; readonly confirm?: string; readonly deletedBy?: string }
    | { readonly kind: "task-reopen"; readonly taskId: string; readonly reason: string }
    | { readonly kind: "task-review"; readonly taskId: string; readonly reviewerId: string }
    | { readonly kind: "task-complete"; readonly taskId: string; readonly ciGate: "passed" | "failed"; readonly reviewerId: string }
    | { readonly kind: "task-show"; readonly taskId: string }
    | { readonly kind: "task-tree"; readonly taskId: string }
    | { readonly kind: "task-relate"; readonly sourceTaskId: string; readonly relationType: "depends-on"; readonly targetTaskId: string; readonly rationale: string; readonly dryRun: boolean }
    | { readonly kind: "relation-list"; readonly filters: RelationListFilters }
    | { readonly kind: "decision-list"; readonly search?: string; readonly legacyId?: string; readonly legacyRange?: string; readonly state?: string; readonly moduleKey?: string; readonly productLine?: string; readonly compact?: boolean }
    | { readonly kind: "decision-show"; readonly selector: string }
    | { readonly kind: "decision-propose"; readonly decisionId?: string; readonly title: string; readonly question: string; readonly chosen: string; readonly rejected: string; readonly whyNot: string; readonly claim?: string; readonly claims: ReadonlyArray<DecisionClaimInput>; readonly claimLoadBearing: boolean; readonly riskTier: "low" | "medium" | "high"; readonly urgency: "low" | "medium" | "high"; readonly proposedBy?: string; readonly arbiter?: string; readonly modules: ReadonlyArray<string>; readonly productLines: ReadonlyArray<string>; readonly evidenceRelations: ReadonlyArray<DecisionEvidenceRelationInput>; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "decision-accept" | "decision-reject" | "decision-defer" | "decision-supersede" | "decision-retire"; readonly decisionId: string; readonly arbiter?: string; readonly decidedAt?: string; readonly judgmentOnlyRationale?: string; readonly body?: string; readonly dryRun: boolean }
    | { readonly kind: "decision-reckon"; readonly decisionId: string; readonly taskId: string; readonly dryRun: boolean }
    | { readonly kind: "decision-amend"; readonly decisionId: string; readonly title?: string; readonly body?: string; readonly patches: ReadonlyArray<DecisionAmendPatchInput>; readonly dryRun: boolean }
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
    | { readonly kind: "session-export"; readonly sessionId?: string; readonly runtime?: SessionExportRuntime; readonly source?: SessionExportSource; readonly detectedAt?: string; readonly user?: string }
    | { readonly kind: "session-backfill"; readonly runtime?: SessionExportRuntime; readonly limit?: number }
    | { readonly kind: "session-sync" }
    | { readonly kind: "doc-list"; readonly filters: DocmapFilters }
    | { readonly kind: "doc-map"; readonly filters: DocmapFilters }
    | { readonly kind: "doc-generate"; readonly filters: DocmapFilters; readonly write: boolean }
    | { readonly kind: "task-list"; readonly filters: TaskListFilters }
    | { readonly kind: "status" }
    | { readonly kind: "version" }
    | { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }
    | { readonly kind: "governance-rebuild"; readonly mode: GovernanceRebuildMode }
    | { readonly kind: "lesson-promote"; readonly taskId: string; readonly candidateId: string; readonly mode: LessonCommandMode }
    | { readonly kind: "lesson-sediment"; readonly taskId: string; readonly candidateId: string; readonly mode: "dry-run"; readonly title: string }
    | { readonly kind: "adopt-multica"; readonly taskId: string; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "snapshot-multica"; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "migrate-plan"; readonly limit: number }
    | { readonly kind: "migrate-structure"; readonly mode: "plan" | "apply"; readonly confirmPlan: boolean }
    | { readonly kind: "migrate-anchors"; readonly mode: AnchorBackfillMode }
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
    | { readonly kind: "preset-uninstall"; readonly presetId: string; readonly layer: "project" | "user" }
    | { readonly kind: "preset-run"; readonly presetId: string; readonly entrypoint: "plan" | "scaffold" | "check"; readonly taskId: string; readonly allowScripts: boolean; readonly inputs: Record<string, string> }
    | { readonly kind: "preset-action"; readonly presetId: string; readonly actionName: string; readonly taskId: string; readonly allowScripts: boolean; readonly inputs: Record<string, string> }
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
