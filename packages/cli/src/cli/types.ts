import type { DomainStatus } from "../../../kernel/src/domain/index.ts";

export type CheckProfile = "source-package" | "private-harness" | "target-project";
export type GovernanceRebuildMode = "dry-run" | "archive" | "apply";
export type LessonCommandMode = "dry-run" | "apply";
export type TaskListLessonFilter = "present" | "missing";

export interface TaskListFilters {
  readonly state?: string;
  readonly moduleKey?: string;
  readonly queue?: string;
  readonly preset?: string;
  readonly review?: string;
  readonly lesson?: TaskListLessonFilter;
  readonly missingMaterials: boolean;
  readonly includeArchived: boolean;
  readonly search?: string;
}

export interface EvidenceAppendInput {
  readonly type: string;
  readonly path: string;
  readonly summary: string;
}

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly taskId?: string;
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
  readonly modules?: ReadonlyArray<unknown>;
  readonly module?: unknown;
  readonly document?: unknown;
  readonly evidenceBundle?: string;
  readonly issues?: ReadonlyArray<unknown>;
  readonly rows?: number;
  readonly warnings?: ReadonlyArray<unknown>;
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
  readonly error?: {
    readonly code: string;
    readonly hint: string;
  };
}

export interface CommandRegistryEntry {
  readonly kind: string;
  readonly primary: string;
  readonly aliases: ReadonlyArray<string>;
  readonly commandPath: ReadonlyArray<string>;
  readonly summary: string;
  readonly options: ReadonlyArray<CommandHelpOption>;
  readonly examples: ReadonlyArray<string>;
  readonly resultEnvelope: "CliResult/v1";
}

export interface CommandHelpOption {
  readonly flag: string;
  readonly description: string;
}

export interface ParsedCommand {
  readonly rootDir: string;
  readonly json: boolean;
  readonly action:
    | { readonly kind: "init"; readonly addNpmScripts: boolean }
    | { readonly kind: "new-task"; readonly taskId?: string; readonly title: string; readonly slug: string; readonly allowManualId: boolean; readonly fromLegacyId?: string; readonly titleProvided: boolean; readonly slugProvided: boolean; readonly vertical?: string; readonly preset?: string; readonly profile?: string; readonly moduleKey?: string; readonly registerModule?: { readonly key: string; readonly title: string; readonly prefix?: string; readonly scope: string }; readonly longRunning: boolean; readonly dryRun: boolean; readonly locale?: "zh-CN" | "en-US" }
    | { readonly kind: "status-set"; readonly taskId: string; readonly status: DomainStatus; readonly force: boolean; readonly reason?: string }
    | { readonly kind: "progress-append"; readonly taskId: string; readonly text: string; readonly evidence?: EvidenceAppendInput }
    | { readonly kind: "task-archive"; readonly taskId: string; readonly reason: string; readonly archivedBy?: string; readonly archiveField?: string }
    | { readonly kind: "task-supersede"; readonly oldTaskId: string; readonly title?: string; readonly slug?: string; readonly reason: string; readonly byTaskId?: string; readonly confirm?: string; readonly allowOpenFindings: boolean; readonly deletedBy?: string }
    | { readonly kind: "task-delete"; readonly taskId: string; readonly mode: "soft" | "hard"; readonly reason: string; readonly confirm?: string; readonly deletedBy?: string }
    | { readonly kind: "task-reopen"; readonly taskId: string; readonly reason: string }
    | { readonly kind: "task-review"; readonly taskId: string; readonly reviewerId: string }
    | { readonly kind: "task-complete"; readonly taskId: string; readonly ciGate: "passed" | "failed"; readonly reviewerId: string }
    | { readonly kind: "task-list"; readonly filters: TaskListFilters }
    | { readonly kind: "status" }
    | { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean }
    | { readonly kind: "governance-rebuild"; readonly mode: GovernanceRebuildMode }
    | { readonly kind: "lesson-promote"; readonly taskId: string; readonly candidateId: string; readonly mode: LessonCommandMode }
    | { readonly kind: "lesson-sediment"; readonly taskId: string; readonly candidateId: string; readonly mode: "dry-run"; readonly title: string }
    | { readonly kind: "adopt-multica"; readonly taskId: string; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "snapshot-multica"; readonly ref: string; readonly title: string; readonly status: string; readonly url: string }
    | { readonly kind: "migrate-plan"; readonly limit: number }
    | { readonly kind: "migrate-structure"; readonly mode: "plan" | "apply"; readonly confirmPlan: boolean }
    | { readonly kind: "migrate-run"; readonly planOnly: boolean; readonly outDir: string; readonly locale?: "zh-CN" | "en-US"; readonly assumeLocale?: "zh-CN" | "en-US"; readonly allowDirty: boolean; readonly sessionDir?: string }
    | { readonly kind: "migrate-verify"; readonly sessionPath?: string; readonly fullCutover: boolean }
    | { readonly kind: "legacy-scan"; readonly sourcePath: string }
    | { readonly kind: "legacy-intake-plan"; readonly sourcePath: string; readonly outPath?: string }
    | { readonly kind: "legacy-copy-safe-docs"; readonly sourcePath: string; readonly apply: boolean }
    | { readonly kind: "legacy-index"; readonly sourcePath: string; readonly apply: boolean }
    | { readonly kind: "legacy-verify" }
    | { readonly kind: "git-diff"; readonly baseRef?: string }
    | { readonly kind: "doctor" }
    | { readonly kind: "help"; readonly commandKind?: string; readonly commandPrefix?: ReadonlyArray<string> }
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
    | { readonly kind: "preset-run"; readonly presetId: string; readonly entrypoint: "plan" | "scaffold" | "check"; readonly taskId: string; readonly allowScripts: boolean }
    | { readonly kind: "preset-action"; readonly presetId: string; readonly actionName: string; readonly taskId: string; readonly allowScripts: boolean }
    | { readonly kind: "module-list" }
    | { readonly kind: "module-inspect"; readonly moduleKey: string }
    | { readonly kind: "module-register"; readonly moduleKey: string; readonly title: string; readonly scope: string; readonly prefix?: string; readonly status?: string; readonly branch?: string; readonly owner?: string; readonly currentStep?: string; readonly shared: ReadonlyArray<string>; readonly dependsOn: ReadonlyArray<string> }
    | { readonly kind: "module-scaffold"; readonly moduleKey: string }
    | { readonly kind: "module-unregister"; readonly moduleKey: string }
    | { readonly kind: "module-step"; readonly moduleKey: string; readonly stepId: string; readonly state: "planned" | "in-progress" | "blocked" | "done" }
    | { readonly kind: "vertical-validate"; readonly definitionPath?: string };
}
