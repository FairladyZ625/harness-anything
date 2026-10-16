import { scrubProviderValue } from "./dispatch-stream.ts";
import { runProcessTextAsync } from "./process-port.ts";

export type RunGh = (command: string, args: readonly string[], options: { readonly cwd: string }) => Promise<string>;
export type CiWorkflowRun = { readonly databaseId: number; readonly headBranch: string; readonly createdAt: string };
export type CiRunListEntry = CiWorkflowRun & {
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly event: string;
};

export interface CiArtifactMetadata {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
}

export const runCiProviderCommand: RunGh = (command, args, options) =>
  runProcessTextAsync(command, args, options.cwd, undefined, undefined, undefined, { timeoutMs: 30_000 });

export async function listTaskBranchRuns(gh: RunGh, cwd: string, branch: string): Promise<readonly CiRunListEntry[]> {
  const pages = JSON.parse(
    await gh(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/:owner/:repo/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
      ],
      { cwd },
    ),
  ) as readonly {
    readonly workflow_runs: readonly {
      readonly id: number;
      readonly head_branch: string;
      readonly head_sha: string;
      readonly created_at: string;
      readonly status: string;
      readonly conclusion: string | null;
      readonly event: string;
    }[];
  }[];
  return pages
    .flatMap((page) => page.workflow_runs)
    .map((run) => ({
      databaseId: run.id,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      createdAt: run.created_at,
      status: run.status,
      conclusion: run.conclusion,
      event: run.event,
    }));
}

export function selectCiBranchRuns(
  runs: readonly CiRunListEntry[],
  branch: string,
  limit: number,
): readonly CiWorkflowRun[] {
  return runs
    .filter((run) => run.headBranch === branch)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.databaseId - left.databaseId)
    .slice(0, limit);
}

/** Provider output crosses into durable observations only after token and key-based scrubbing. */
export function scrubCiProviderLog(log: string, explicitSecrets: readonly string[] = []): string {
  const secrets = [
    ...explicitSecrets,
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.HARNESS_GITHUB_TOKEN,
    process.env.GITLAB_TOKEN,
    process.env.HARNESS_GITLAB_TOKEN,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  let scrubbed = log;
  for (const secret of new Set(secrets)) scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
  return String(scrubProviderValue(scrubbed));
}

export async function listCiArtifacts(gh: RunGh, cwd: string, runId: number): Promise<readonly CiArtifactMetadata[]> {
  const pages = JSON.parse(
    await gh(
      "gh",
      ["api", "--paginate", "--slurp", `repos/:owner/:repo/actions/runs/${runId}/artifacts?per_page=100`],
      { cwd },
    ),
  ) as readonly {
    readonly artifacts: readonly CiArtifactMetadata[];
  }[];
  return pages.flatMap((page) => page.artifacts);
}
