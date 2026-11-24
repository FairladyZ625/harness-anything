import type { TaskProjectionQueries } from "@harness-anything/kernel";
import type { DecisionActionStatus } from "@harness-anything/kernel/internal/domain/operational-status.ts";
import type { ProjectionCut } from "./projection-cut.ts";

/** Host probes the application task reads never call themselves.
 * Omit every field on a stateless cloud node: absence matches a daemon that has no checkout
 * and no local Git objects. The daemon adapter always supplies the live implementations.
 */
export interface TaskGitProbe {
  readonly hasCommit: (rootDir: string, sha: string) => boolean;
  readonly isAncestor: (rootDir: string, ancestor: string, descendant: string) => boolean;
  readonly rebaseEquivalentDelivery: (
    rootDir: string,
    frozenBase: string,
    frozenCommit: string,
    rebasedBase: string,
    rebasedHead: string,
  ) => boolean;
  readonly deliveryContainment: (
    rootDir: string,
    baseline: string | null,
    deliveryCommit: string,
    mergeCommit: string,
  ) => "contained" | "missing" | "unavailable";
}

export type TaskIncidentReceipt =
  | {
      readonly status: "claimed";
      readonly decidedAt: string;
    }
  | {
      readonly status: DecisionActionStatus;
      readonly action: "resume" | "rerun" | "needs_attention" | "no_action";
      readonly attention: "question" | "guard" | null;
      readonly reason: string | null;
      readonly decidedAt: string;
    };

export interface TaskCoreQueryPorts {
  /** True only when this node has checked out that absolute worktree path. */
  readonly linkedWorktree?: (absolutePath: string) => boolean;
  /** True when the authored task_plan.md is on this node's filesystem. */
  readonly taskPlanPresent?: (rootDir: string, packagePath: string) => boolean;
  readonly readWorktreeSetupSucceeded?: (cwd: string) => readonly string[];
  readonly git?: TaskGitProbe;
  /** Unified diff text. Absent means the caller must not invent a patch. */
  readonly gitDiff?: (rootDir: string, baselineRef: string, commitSha: string) => string;
  readonly readIncidentActionReceipt?: (rootDir: string, dispatchId: string) => TaskIncidentReceipt | null;
  readonly readReckoningAgenda?: (input: {
    readonly projection: TaskProjectionQueries;
    readonly store?: { readonly readContentBlob: (sha256: string) => Uint8Array | null };
  }) => {
    readonly items: readonly {
      readonly ref: string;
      readonly title: string;
      readonly since: string;
      readonly workTaskId: null;
    }[];
    readonly reads: readonly ProjectionCut[];
  };
  /** Document-backed ruling read. The daemon passes the runtime-engine parser; cloud omits it. */
  readonly readDispatchRuling?: (
    readDocument: (relativePath: string) => string | null,
    packagePath: string,
    dispatchId: string,
  ) => {
    readonly question: string;
    readonly options: readonly string[];
    readonly path: string;
    readonly createdAt?: string;
  } | null;
  /** Exact executor ids for one execution. The daemon passes lineage; omission uses the projection. */
  readonly executorDeclarationCandidates?: (
    projection: TaskProjectionQueries,
    taskId: string,
    executionId: string,
  ) => readonly string[];
  readonly isolateRows?: <T>(rows: readonly T[]) => {
    readonly rows: readonly T[];
    readonly invalidRows: readonly {
      readonly rowIndex: number;
      readonly taskId: string;
      readonly field: string;
      readonly message: string;
    }[];
  };
  /** Receipt settlement for task-show misses. The daemon passes its write-receipt `failed`. */
  readonly failRead?: (opId: string, error: unknown) => unknown;
}

export function queryCodedError(code: string, text: string): Error & { readonly code: string } {
  return Object.assign(new Error(text), { code });
}
