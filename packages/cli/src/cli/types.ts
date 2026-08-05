import type {
  ConsentAction,
  DomainStatus,
  PriorityTier,
  RelationType,
  TaskWorkKind
} from "@harness-anything/kernel";
import type { HarnessLayoutOverrides } from "@harness-anything/kernel";
import type {
  DeprecatedCommandInvocation,
  RepoWriteCommandAction,
  RepoWriteCommandActionFor,
  TaskCompleteTransitionCommand,
  TaskSubmitTransitionCommand
} from "@harness-anything/application";
import type { CliError } from "./error-codes.ts";
import type { CommandDisplayTier } from "./command-spec/types.ts";

export type CheckProfile = "source-package" | "private-harness" | "target-project";
export type CheckScope =
  | { readonly kind: "task-tree"; readonly taskId: string }
  | { readonly kind: "path"; readonly path: string };
export type GovernanceRebuildMode = "dry-run" | "archive" | "apply";
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
  readonly treeRoot?: string;
  readonly parent?: string;
  readonly liveness?: "in_flight" | "stale";
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

export type EvidenceAppendInput = NonNullable<
  RepoWriteCommandActionFor<"progress-append">["evidence"]
>[number];
export type DecisionEvidenceRelationInput =
  RepoWriteCommandActionFor<"decision-propose">["evidenceRelations"][number];
export type DecisionClaimInput =
  RepoWriteCommandActionFor<"decision-propose">["claims"][number];
export type DecisionClaimFulfillmentInput =
  RepoWriteCommandActionFor<"decision-propose">["fulfillments"][number];
export type DecisionChoiceInput =
  RepoWriteCommandActionFor<"decision-propose">["chosen"][number];
export type DecisionRejectedInput =
  RepoWriteCommandActionFor<"decision-propose">["rejected"][number];
export type DecisionAmendPatchInput =
  RepoWriteCommandActionFor<"decision-amend">["patches"][number];

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
  readonly mode?: GovernanceRebuildMode | "soft" | "hard";
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
  readonly completionEvidence?: unknown;
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
    readonly source: "installed-product" | "source-checkout";
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
  readonly display?: CommandDisplayTier;
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
  readonly rootResolutionSource?: "explicit-override" | "local-cwd";
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly daemonRepoId?: string;
  readonly actor?: string;
  readonly daemonModeOverride?: "direct" | "local" | "remote";
  readonly daemonProfileOverride?: "default" | "isolated";
  readonly json: boolean;
  readonly deprecatedInvocation?: DeprecatedCommandInvocation;
  readonly action:
    | RepoWriteCommandAction
    | { readonly kind: "task-holder"; readonly taskId: string }
    | { readonly kind: "task-submit"; readonly taskId: string; readonly submission: { readonly completionClaim: string; readonly deliverables: ReadonlyArray<string>; readonly verificationNotes: ReadonlyArray<string>; readonly knownGaps: ReadonlyArray<string>; readonly residualRisks: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> }; readonly executionId?: string; readonly leaseToken?: string; readonly dryRun: boolean }
    | TaskSubmitTransitionCommand
    | { readonly kind: "task-complete"; readonly taskId: string; readonly executionId?: string; readonly ciGate?: "passed" | "failed" | "not-applicable"; readonly reviewerId: string; readonly evidenceMode: "execution-review" | "commit-anchor"; readonly commitRef?: string; readonly judgment?: string; readonly approval?: { readonly executionId?: string; readonly findings: string; readonly evidenceChecked: ReadonlyArray<string>; readonly rationale: string; readonly archiveWarningsAcknowledged: boolean; readonly consentId?: string; readonly consentUtterance?: string; readonly consentStandingPolicyDecisionId?: string; readonly consentAssertedRationale?: string; readonly consentActions?: ReadonlyArray<ConsentAction>; readonly paths: ReadonlyArray<string>; readonly prRef?: string }; readonly externalCheckpointRefs?: ReadonlyArray<import("@harness-anything/application").TaskCompleteExternalCheckpointRef>; readonly dryRun?: boolean }
    | TaskCompleteTransitionCommand
    | { readonly kind: "task-show"; readonly taskId: string; readonly view: "summary" | "trace" | "tree" }
    | { readonly kind: "session-show"; readonly sessionId: string; readonly view: "summary" | "trace" }
    | { readonly kind: "execution-show"; readonly executionId: string }
    | { readonly kind: "execution-list"; readonly taskId: string }
    | { readonly kind: "review-show"; readonly reviewId: string }
    | { readonly kind: "audit-provenance"; readonly taskId: string }
    | { readonly kind: "relation-list"; readonly filters: RelationListFilters }
    | { readonly kind: "decision-list"; readonly search?: string; readonly legacyId?: string; readonly legacyRange?: string; readonly state?: string; readonly moduleKey?: string; readonly productLine?: string; readonly compact?: boolean }
    | { readonly kind: "decision-show"; readonly selector: string }
    | { readonly kind: "decision-verify"; readonly decisionIds?: ReadonlyArray<string> }
    | { readonly kind: "fact-list"; readonly taskId: string }
    | { readonly kind: "fact-show"; readonly taskId: string; readonly factId: string }
    | { readonly kind: "runtime-event-list"; readonly sessionId: string }
    | { readonly kind: "doc-status" }
    | { readonly kind: "doc-sync"; readonly mode: "dry-run" | "submit"; readonly paths: ReadonlyArray<string> }
    | { readonly kind: "task-list"; readonly filters: TaskListFilters }
    | { readonly kind: "status" }
    | { readonly kind: "version" }
    | { readonly kind: "completion"; readonly shell: "bash" | "zsh" }
    | { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean; readonly scope?: CheckScope }
    | { readonly kind: "external-snapshot"; readonly provider: "github"; readonly ref: string }
    | { readonly kind: "external-snapshot"; readonly provider: "multica"; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "external-list"; readonly provider: "github"; readonly repository: string; readonly rawStatus?: string; readonly label?: string }
    | { readonly kind: "migrate-plan"; readonly limit: number }
    | { readonly kind: "migrate-verify"; readonly sessionPath?: string; readonly fullCutover: boolean }
    | { readonly kind: "legacy-scan"; readonly sourcePath: string }
    | { readonly kind: "legacy-verify" }
    | { readonly kind: "doctor"; readonly repair?: boolean }
    | { readonly kind: "diagnostics-command-usage" }
    | { readonly kind: "authority-cutover-status" }
    | { readonly kind: "authority-cutover-drain"; readonly classifications: ReadonlyArray<{ readonly opId: string; readonly disposition: "retryable-not-committed" | "indeterminate"; readonly recordedTupleDigest: string; readonly evidenceRef: string }> }
    | { readonly kind: "authority-cutover-scan"; readonly profileId: "production-final-scan/v1" }
    | { readonly kind: "authority-cutover-confirm"; readonly firstScanId: string; readonly secondScanId: string }
    | { readonly kind: "authority-cutover-boundary"; readonly boundaryId: string; readonly equalityReceiptId: string; readonly expectedSelectedSchemaTupleDigest: string }
    | { readonly kind: "authority-cutover-freeze"; readonly reason: string; readonly expectedBoundaryReceiptDigest: string }
    | { readonly kind: "authority-cutover-re-enable"; readonly boundaryId: string; readonly expectedFreezeReceiptDigest: string; readonly equalityReceiptId: string; readonly forwardFixRef: string }
    | { readonly kind: "authority-repo-enroll"; readonly repoId: string; readonly repoRoot: string; readonly manifestPath: string; readonly serviceStateRoot: string; readonly keyRegistryPath?: string; readonly namespaceTtlMs?: number; readonly allowedExecutorAgentIds: ReadonlyArray<string> }
    | { readonly kind: "authority-repo-resign"; readonly repoId: string; readonly manifestPath: string; readonly keyRegistryPath?: string; readonly switchRecordPath?: string; readonly namespaceTtlMs?: number }
    | { readonly kind: "worktree-status"; readonly taskId: string }
    | { readonly kind: "help"; readonly commandKind?: string; readonly commandPrefix?: ReadonlyArray<string> }
    | { readonly kind: "entity-list" }
    | { readonly kind: "capabilities"; readonly entityKind?: string }
    | { readonly kind: "template-list"; readonly catalogPath?: string }
    | { readonly kind: "template-render"; readonly templateRef: string; readonly catalogPath?: string; readonly locale: "zh-CN" | "en-US" }
    | { readonly kind: "preset-validate"; readonly manifestPath: string; readonly kernelVersion: string }
    | { readonly kind: "preset-list" }
    | { readonly kind: "preset-inspect"; readonly presetId: string }
    | { readonly kind: "preset-check"; readonly presetId: string }
    | { readonly kind: "preset-audit" }
    | { readonly kind: "script-list"; readonly source?: "user" | "vertical" | "preset"; readonly purpose?: "scaffold" | "generate" | "transform" | "audit"; readonly scriptKind?: "action" | "check" }
    | { readonly kind: "script-inspect"; readonly scriptId: string }
    | { readonly kind: "module-list" }
    | { readonly kind: "module-inspect"; readonly moduleKey: string }
    | { readonly kind: "vertical-validate"; readonly definitionPath?: string };
}

export type CliTaskCompleteAction = Exclude<
  Extract<ParsedCommand["action"], { readonly kind: "task-complete" }>,
  TaskCompleteTransitionCommand
>;

export type CliTaskSubmitAction = Exclude<
  Extract<ParsedCommand["action"], { readonly kind: "task-submit" }>,
  TaskSubmitTransitionCommand
>;
