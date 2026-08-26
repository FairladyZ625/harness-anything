import type { SquadRunsListResult } from "../../../daemon/src/squad-run-contract.ts";
import type { DaemonGuiReadPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

// Renderer client for the squad-run orchestration list. One `ha squad run` is one
// list unit; range and query narrowing stay daemon-side.
type SquadRunBridge = {
  readonly listSquadRuns: (payload: DaemonGuiReadPayloadMap["repo.squad.runs.list"]) => Promise<unknown>;
};
const bridge = (): SquadRunBridge => {
  const value = window.harness as unknown as Partial<SquadRunBridge> | undefined;
  if (!value?.listSquadRuns) throw new Error("Squad run list bridge is unavailable.");
  return value as SquadRunBridge;
};
type SquadRunsListQuery = {
  readonly since?: string;
  readonly query?: string;
  readonly limit?: number;
};
export const squadRunsClient = {
  list: async (repoId: string, query: SquadRunsListQuery = {}): Promise<SquadRunsListResult> => {
    const value = await bridge().listSquadRuns({
      repoId,
      ...query,
    } as DaemonGuiReadPayloadMap["repo.squad.runs.list"]);
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
};
