import { Context } from "effect";

export interface VcsCommitAuthor {
  readonly name: string;
  readonly email: string;
}

/** Optional observability boundaries inside a scoped Git commit. */
export type VcsCommitPhase =
  | "commit-plan-start"
  | "commit-plan-done"
  | "session-checkout-start"
  | "session-checkout-done"
  | "stage-start"
  | "stage-done"
  | "unstage-logs-start"
  | "unstage-logs-done"
  | "trunk-checkout-start"
  | "trunk-checkout-done"
  | "commit-call-start"
  | "commit-call-done"
  | "staged-paths-start"
  | "staged-paths-done"
  | "staged-entries-start"
  | "staged-entries-done"
  | "worktree-verify-start"
  | "worktree-verify-done"
  | "alternate-index-start"
  | "alternate-index-ready"
  | "commit-start"
  | "commit-done"
  | "index-refresh-start"
  | "index-refresh-done"
  | "index-refresh-fallback-start"
  | "index-refresh-fallback-done"
  | "native-commit-start"
  | "native-commit-done";

export interface VcsCommitOptions {
  readonly onPhase?: (phase: VcsCommitPhase) => void;
}

export type VcsCommitResolution =
  | { readonly ok: true; readonly sha: string }
  | { readonly ok: false; readonly reason: "missing" | "non-commit"; readonly objectType?: string };

export interface VersionControlSystem {
  readonly normalizePath: (inputPath: string) => string;
  readonly topLevel: (inputPath: string) => string | null;
  readonly isIgnored: (repoRoot: string, relativePath: string) => boolean;
  readonly ignoredPaths?: (repoRoot: string, relativePaths: ReadonlyArray<string>) => ReadonlySet<string>;
  readonly add: (repoRoot: string, input: { readonly paths: ReadonlyArray<string>; readonly force?: boolean }) => void;
  readonly workingTreeFiles: (repoRoot: string, paths: ReadonlyArray<string>) => string;
  readonly stagedFiles: (repoRoot: string, paths: ReadonlyArray<string>) => string;
  readonly commit: (repoRoot: string, message: string, author?: VcsCommitAuthor, options?: VcsCommitOptions) => void;
  readonly currentHead: (repoRoot: string) => string;
  readonly currentBranch: (repoRoot: string) => string | null;
  readonly originHeadBranch: (repoRoot: string) => string | null;
  readonly refExists: (repoRoot: string, ref: string) => boolean;
  readonly commitExists: (repoRoot: string, sha: string) => boolean;
  readonly commitMessage: (repoRoot: string, ref: string) => string;
  readonly resolveCommit: (repoRoot: string, ref: string) => VcsCommitResolution;
  readonly pathExistsAtCommit: (repoRoot: string, sha: string, relativePath: string) => boolean;
  /**
   * Returns requested canonical repo-relative file paths present below one
   * canonical repo-relative root in an immutable commit tree. Inputs outside
   * the root or using path aliases are rejected; Git read failures throw.
   */
  readonly filesExistingAtCommit: (
    repoRoot: string,
    sha: string,
    input: {
      readonly relativeRoot: string;
      readonly relativePaths: ReadonlyArray<string>;
    }
  ) => ReadonlySet<string>;
  readonly checkout: (repoRoot: string, ref: string) => void;
  readonly createBranch: (repoRoot: string, branch: string) => void;
  readonly mergeNoFf: (repoRoot: string, branch: string, message: string, author?: VcsCommitAuthor) => void;
  readonly conflictedFiles: (repoRoot: string) => ReadonlyArray<string>;
  readonly readConflictStage: (repoRoot: string, stage: 2 | 3, relativePath: string) => Uint8Array | null;
  readonly checkoutConflictSide: (repoRoot: string, side: "ours" | "theirs", paths: ReadonlyArray<string>) => void;
  readonly latestCommitSubjectForPath: (repoRoot: string, baseRef: string, branch: string, relativePath: string) => string | null;
  readonly worktreePathExists: (repoRoot: string, relativePath: string) => boolean;
  readonly writeWorktreeFile: (repoRoot: string, relativePath: string, body: string | Uint8Array) => void;
  readonly removeWorktreePath: (repoRoot: string, relativePath: string) => void;
  readonly deleteBranch: (repoRoot: string, branch: string) => void;
  readonly abortMerge: (repoRoot: string) => void;
  readonly sessionBranches: (repoRoot: string) => ReadonlyArray<string>;
  readonly commitsNotInTrunk: (repoRoot: string, trunkBranch: string, branch: string) => ReadonlyArray<string>;
  readonly changedFilesBetween: (repoRoot: string, before: string, after: string) => ReadonlyArray<string>;
  readonly resetQuiet: (repoRoot: string, pathspecs: ReadonlyArray<string>) => void;
  readonly commitPathsToBranch: (
    repoRoot: string,
    input: {
      readonly branchName: string;
      readonly baseBranchName: string;
      readonly stagePaths: ReadonlyArray<string>;
      readonly excludePaths: ReadonlySet<string>;
      readonly message: string;
      readonly author?: VcsCommitAuthor;
      readonly onPhase?: (phase: VcsCommitPhase) => void;
    }
  ) => string;
  readonly resetWorktreePaths: (
    repoRoot: string,
    ref: string,
    paths: ReadonlyArray<string>,
    options?: {
      /**
       * Ref whose content the caller will restore immediately after the reset
       * (for a materializer merge, the session branch). When the worktree
       * already matches this ref the reset is content-neutral. When it differs,
       * the worktree holds an edit that no ref carries, so the reset would
       * destroy it; such paths are copied aside and reported instead.
       */
      readonly restoreRef?: string;
      readonly preserveDir?: string;
    }
  ) => ReadonlyArray<PreservedWorktreeEdit>;
}

/**
 * A worktree edit that no ref carried at reset time, copied aside so the reset
 * could proceed without destroying it.
 */
export interface PreservedWorktreeEdit {
  readonly path: string;
  readonly preservedAt: string;
}

export class VcsCommandError extends Error {
  readonly _tag = "VcsCommandError";
  readonly command: string;
  readonly cwd: string;
  readonly exitCode?: string | number;
  readonly signal?: string;
  readonly stderrSummary?: string;

  constructor(input: {
    readonly command: string;
    readonly cwd: string;
    readonly exitCode?: string | number;
    readonly signal?: string;
    readonly stderrSummary?: string;
  }) {
    super(`git ${input.command} failed${input.stderrSummary ? `: ${input.stderrSummary}` : ""}`);
    this.name = "VcsCommandError";
    this.command = input.command;
    this.cwd = input.cwd;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stderrSummary = input.stderrSummary;
  }
}

export const VersionControlSystem = Context.GenericTag<VersionControlSystem>(
  "@harness-anything/kernel/VersionControlSystem"
);
