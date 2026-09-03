import {
  isAvailableSquadRunSummary,
  type SquadRunInvalidSummaryDto,
  type SquadRunListRowDto,
  type SquadRunPhase,
  type SquadRunSummaryDto,
} from "./squad-run-contract.ts";

export function listQuery(payload: Readonly<Record<string, unknown>>): {
  readonly since: string | null;
  readonly tokens: readonly string[];
  readonly limit: number;
} {
  const fields = Object.keys(payload),
    since = payload.since,
    query = payload.query,
    limit = payload.limit;
  if (
    fields.some((field) => !["since", "query", "limit"].includes(field)) ||
    (since !== undefined && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) ||
    (query !== undefined && typeof query !== "string") ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1_000))
  )
    throw squadReadError("invalid_request", "Squad run lists accept ISO since, text query, and limit 1..1000.");
  return {
    since: typeof since === "string" ? new Date(since).toISOString() : null,
    tokens: typeof query === "string" ? query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean) : [],
    limit: typeof limit === "number" ? limit : 200,
  };
}

export function matchesRunQuery(run: SquadRunListRowDto, tokens: readonly string[]): boolean {
  const searchable = (
    isAvailableSquadRunSummary(run)
      ? [run.squadRunId, run.squadId, run.taskId, run.mission, run.phase]
      : [run.squadRunId, run.projectionState, run.projectionError.code, run.projectionError.hint]
  )
    .join("\n")
    .toLocaleLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

export function activePhase(phase: SquadRunPhase): boolean {
  return phase === "planning" || phase === "leader_running" || phase === "workers_running";
}

/** 小队 run 版的活动窗判定,语义对齐 kernel 的 runtimeSessionInActivityWindow:比时间
 * 瞬值而非字符串,不同毫秒精度/秒精度的 ISO 戳不会因字典序错判进出窗口。 */
export function runInActivityWindow(run: SquadRunSummaryDto, since: string): boolean {
  return Date.parse(run.latestActivityAt) >= Date.parse(since);
}

export function compareRunSummaries(left: SquadRunListRowDto, right: SquadRunListRowDto): number {
  if (!isAvailableSquadRunSummary(left))
    return isAvailableSquadRunSummary(right) ? 1 : left.squadRunId.localeCompare(right.squadRunId);
  if (!isAvailableSquadRunSummary(right)) return -1;
  const active = Number(activePhase(right.phase)) - Number(activePhase(left.phase));
  return (
    active ||
    Date.parse(right.latestActivityAt) - Date.parse(left.latestActivityAt) ||
    left.squadRunId.localeCompare(right.squadRunId)
  );
}

export function invalidSquadRunProjection(squadRunId: string): SquadRunInvalidSummaryDto {
  return {
    squadRunId,
    projectionState: "invalid",
    projectionError: {
      code: "squad_run_projection_invalid",
      hint: `Squad run projection ${squadRunId} is invalid.`,
    },
  };
}

export function squadReadError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
