import type { SquadRunReadResult, SquadRunsListResult } from "../../../daemon/src/squad-run-contract.ts";
import type { DaemonGuiReadPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { invoke } from "./api-client-invoke.ts";

type RepoScope = { readonly repoId: string };

// Renderer client for the squad-run orchestration reads. One `ha squad run` is one
// list unit; range and query narrowing stay daemon-side, and the per-run detail
// (leader turns / worker attempts) is the GUI projection of `ha squad status`.
type SquadRunsListQuery = {
  readonly since?: string;
  readonly query?: string;
  readonly limit?: number;
};
export const squadRunsClient = {
  list: async (repoId: string, query: SquadRunsListQuery = {}): Promise<SquadRunsListResult> => {
    const value = await invoke(
      "repo.squad.runs.list",
      {
        repoId,
        ...query,
      } as DaemonGuiReadPayloadMap["repo.squad.runs.list"] & RepoScope,
      "listSquadRuns",
    );
    if (
      !isRendererRecord(value) ||
      value.ok !== true ||
      !Array.isArray(value.runs) ||
      !isRendererRecord(value.totals) ||
      typeof value.truncated !== "boolean"
    )
      throw new Error(rendererErrorHint(value, "Squad run list bridge returned an invalid result."));
    return value as SquadRunsListResult;
  },
  read: async (repoId: string, squadRunId: string): Promise<SquadRunReadResult> => {
    const value = await invoke(
      "repo.squad.run.read",
      {
        repoId,
        squadRunId,
      } as DaemonGuiReadPayloadMap["repo.squad.run.read"] & RepoScope,
      "readSquadRun",
    );
    if (!isRendererRecord(value) || value.ok !== true || !isRendererRecord(value.run))
      throw new Error(rendererErrorHint(value, "Squad run read bridge returned an invalid result."));
    return value as SquadRunReadResult;
  },
};
