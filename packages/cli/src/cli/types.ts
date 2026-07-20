import type { DomainStatus } from "@harness-anything/kernel";
import type { CliError } from "./error-codes.ts";
import type {
  AnchorBackfillMode,
  CheckProfile,
  DecisionAmendPatchInput,
  DecisionChoiceInput,
  DecisionClaimFulfillmentInput,
  DecisionClaimInput,
  DecisionEvidenceRelationInput,
  DecisionRejectedInput,
  EvidenceAppendInput,
  GovernanceRebuildMode,
  LessonCommandMode,
  MaterializerCommandReport,
  ParsedCommand,
  ProvenanceBackfillMode,
  RelationListFilters,
  SessionExportRuntime,
  SessionExportSource,
  TaskListFilters,
  TaskListLessonFilter
} from "@harness-anything/daemon";

export type {
  AnchorBackfillMode,
  CheckProfile,
  DecisionAmendPatchInput,
  DecisionChoiceInput,
  DecisionClaimFulfillmentInput,
  DecisionClaimInput,
  DecisionEvidenceRelationInput,
  DecisionRejectedInput,
  EvidenceAppendInput,
  GovernanceRebuildMode,
  LessonCommandMode,
  MaterializerCommandReport,
  ParsedCommand,
  ProvenanceBackfillMode,
  RelationListFilters,
  SessionExportRuntime,
  SessionExportSource,
  TaskListFilters,
  TaskListLessonFilter
} from "@harness-anything/daemon";

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
