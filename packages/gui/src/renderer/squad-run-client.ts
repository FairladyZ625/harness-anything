import type { SquadRunReadResult, SquadRunsListResult } from "../../../daemon/src/squad-run-contract.ts";
import type { DaemonGuiReadPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

// Renderer client for the squad-run orchestration reads. One `ha squad run` is one
// addressable unit (squadRunId); the list carries the range/query narrowing and the
// read carries the leader turns + worker attempts the expansion renders.
type SquadRunBridge = {
  readonly listSquadRuns: (payload: DaemonGuiReadPayloadMap["repo.squad.runs.list"]) => Promise<unknown>;
  readonly readSquadRun: (payload: DaemonGuiReadPayloadMap["repo.squad.runs.read"]) => Promise<unknown>;
};
const bridge = (): SquadRunBridge => {
  const value = window.harness as unknown as Partial<SquadRunBridge> | undefined;
  if (!value?.listSquadRuns || !value.readSquadRun) throw new Error("Squad run read bridge is unavailable.");
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
  read: async (repoId: string, squadRunId: string): Promise<SquadRunReadResult> => {
    const value = await bridge().readSquadRun({
      repoId,
      squadRunId,
    } as DaemonGuiReadPayloadMap["repo.squad.runs.read"] & { readonly repoId: string });
    if (!isRendererRecord(value) || value.ok !== true || !isRendererRecord(value.run))
      throw new Error(rendererErrorHint(value, "Squad run read bridge returned an invalid result."));
    return value as SquadRunReadResult;
  },
};
