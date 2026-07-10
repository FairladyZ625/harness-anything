import { Context } from "effect";

export interface VcsCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface VersionControlSystem {
  readonly normalizePath: (inputPath: string) => string;
  readonly topLevel: (inputPath: string) => string | null;
  readonly isIgnored: (repoRoot: string, relativePath: string) => boolean;
  readonly add: (repoRoot: string, input: { readonly paths: ReadonlyArray<string>; readonly force?: boolean }) => void;
  readonly stagedFiles: (repoRoot: string, paths: ReadonlyArray<string>) => string;
  readonly commit: (repoRoot: string, message: string, author?: VcsCommitAuthor) => void;
  readonly currentHead: (repoRoot: string) => string;
  readonly currentBranch: (repoRoot: string) => string | null;
  readonly originHeadBranch: (repoRoot: string) => string | null;
  readonly refExists: (repoRoot: string, ref: string) => boolean;
  readonly commitExists: (repoRoot: string, sha: string) => boolean;
  readonly pathExistsAtCommit: (repoRoot: string, sha: string, relativePath: string) => boolean;
  readonly checkout: (repoRoot: string, ref: string) => void;
  readonly createBranch: (repoRoot: string, branch: string) => void;
  readonly mergeNoFf: (repoRoot: string, branch: string, message: string) => void;
  readonly deleteBranch: (repoRoot: string, branch: string) => void;
  readonly abortMerge: (repoRoot: string) => void;
  readonly sessionBranches: (repoRoot: string) => ReadonlyArray<string>;
  readonly commitsNotInTrunk: (repoRoot: string, trunkBranch: string, branch: string) => ReadonlyArray<string>;
  readonly changedFilesBetween: (repoRoot: string, before: string, after: string) => ReadonlyArray<string>;
  readonly resetQuiet: (repoRoot: string, pathspecs: ReadonlyArray<string>) => void;
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
