import type {
  CurrentSessionRef,
  HarnessLayoutOverrides,
  ReviewVerdict,
  TaskHolderExecutor,
  TaskHolderPersonPrincipal,
  VcsCommitAuthor,
  WriteAttribution
} from "@harness-anything/kernel";

/** The command fields consumed by the daemon authority host; CLI grammar stays CLI-owned. */
export interface AuthorityHostCommand {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly action: {
    readonly kind: string;
    readonly taskId?: string;
    readonly sessionId?: string;
    readonly verdict?: ReviewVerdict;
    readonly executionSubmission?: { readonly executionId?: string };
  };
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
