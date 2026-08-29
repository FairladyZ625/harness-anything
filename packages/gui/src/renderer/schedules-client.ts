import type { ScheduleGuiRowDto, SchedulesListResult } from "../../../daemon/src/protocol/schedules-gui-contract.ts";
import type { DaemonGuiReadPayloadMap } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";

type RepoScope = { readonly repoId: string };

// Renderer client for the Schedule plane (S4). One `repo.schedules.list` read returns
// the complete joined DTO — cadence/timezone/nextRun/mode/availability are daemon
// facts, and this file never recomputes them. The three actions return command
// receipts; enablement comes from the DTO facets, not from local mode branching.
type SchedulesBridge = {
  readonly listSchedules: (payload: DaemonGuiReadPayloadMap["repo.schedules.list"]) => Promise<unknown>;
  readonly createSchedule: (payload: unknown) => Promise<unknown>;
  readonly updateSchedule: (payload: unknown) => Promise<unknown>;
  readonly deleteSchedule: (payload: unknown) => Promise<unknown>;
  readonly enableSchedule: (payload: unknown) => Promise<unknown>;
  readonly disableSchedule: (payload: unknown) => Promise<unknown>;
  readonly runScheduleNow: (payload: unknown) => Promise<unknown>;
};
const bridge = (): SchedulesBridge => {
  const value = window.harness as unknown as Partial<SchedulesBridge> | undefined;
  if (
    !value?.listSchedules ||
    !value.createSchedule ||
    !value.updateSchedule ||
    !value.deleteSchedule ||
    !value.enableSchedule ||
    !value.disableSchedule ||
    !value.runScheduleNow
  )
    throw new Error("Schedules bridge is unavailable.");
  return value as SchedulesBridge;
};

// ---------------------------------------------------------------------------
// Forward read-projection contract (design.html §6 / backend task
// task_57be99e9e287dc4626be1ade09). The daemon will expose `repo.schedules.runs`
// and extend the list row with `mode` / target kind / health rollup; the shapes
// below follow that table so the UI skeleton can be built before the read side
// lands. Everything stays optional from the renderer's point of view: a missing
// field renders as an explicit "pending projection" state, never as a fabricated
// fact. When the backend lands, align field names here first, then delete the
// fallbacks that depended on absence.
// ---------------------------------------------------------------------------

/** Outcome vocabulary for one occurrence row; `missed` rows are visible history. */
export type ScheduleRunOutcomeWord = "running" | "succeeded" | "failed" | "missed" | "cancelled" | "unknown";
/** Purpose dimension (design §4 A): detect = read-only boundary, remediate = write/PR boundary. */
export type ScheduleModeWord = "detect" | "remediate";

/** One occurrence in the run-history timeline (M3): daemon-formatted facts only. */
export interface ScheduleGuiRunRowDto {
  readonly occurrenceId: string;
  readonly kind: "scheduled" | "manual" | null;
  readonly scheduledFor: string;
  readonly claimedAt: string | null;
  readonly endedAt: string | null;
  /** Daemon-computed; null when the occurrence has not settled (or was missed). */
  readonly durationMs: number | null;
  readonly nodeId: string | null;
  readonly attemptIndex: number | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  /** Set when the occurrence executed as a squad; the M4 lanes then read `SquadRunReadResult`. */
  readonly squadRunId: string | null;
  readonly outcome: ScheduleRunOutcomeWord;
  /** Populated on `missed` rows (`scheduler_unavailable` / `single_flight`). */
  readonly missedReason: string | null;
  /** Artifact ref of the occurrence report (`runs/<occurrence>/report.md`). */
  readonly reportRef: string | null;
  readonly detail: string | null;
}

export type ScheduleRunsResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  readonly scheduleId: string;
  readonly runs: readonly ScheduleGuiRunRowDto[];
  readonly totals: { readonly runs: number; readonly missed: number; readonly failed: number };
  readonly watermark: number;
  readonly sourceRevision: number;
};

/**
 * Health rollup the daemon aggregates over recent occurrences (design §6 M1:
 * derived from the runs read so the list never fans out N+1). `bucket` is the
 * daemon's classification — the renderer never re-derives degraded/clean from
 * outcomes (dec_8DCD52E98BAB268B0194B1E399: status judgments are daemon-side).
 */
export interface ScheduleHealthRollup {
  readonly recent: readonly ScheduleRunOutcomeWord[];
  readonly bucket: "degraded" | "clean";
}

/** List-row projection fields the backend task will add; absent until it lands. */
export type ScheduleRowProjection = ScheduleGuiRowDto & {
  readonly mode?: ScheduleModeWord;
  readonly targetKind?: "agent" | "squad";
  readonly health?: ScheduleHealthRollup;
};

/** null = the mode field has not landed yet; the UI must not guess a default. */
export const scheduleRowMode = (row: ScheduleGuiRowDto): ScheduleModeWord | null =>
  (row as ScheduleRowProjection).mode ?? null;

/**
 * Today every schedule target is a single agent (kernel hardcodes it), so the
 * absence of `targetKind` is a present fact, not a guess: "agent".
 */
export const scheduleRowTargetKind = (row: ScheduleGuiRowDto): "agent" | "squad" =>
  (row as ScheduleRowProjection).targetKind ?? "agent";

/** null = the health rollup has not landed yet; the spark renders a pending state. */
export const scheduleRowHealth = (row: ScheduleGuiRowDto): ScheduleHealthRollup | null =>
  (row as ScheduleRowProjection).health ?? null;

export interface ScheduleActionReceipt {
  readonly ok: boolean;
  readonly command: string;
  readonly outcome: string;
  readonly opId: string;
  readonly code: string | null;
  readonly nextAction: string | null;
  readonly scheduleId: string | null;
}

export interface ScheduleDefinitionInput {
  readonly scheduleId: string;
  readonly name: string;
  readonly everyMs: number;
  readonly agentId: string;
  readonly runtimeInstanceId: string;
  readonly mission: string;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly cwd?: string | null;
}

export const schedulesClient = {
  list: async (repoId: string): Promise<SchedulesListResult> => {
    const value = await bridge().listSchedules({ repoId } as DaemonGuiReadPayloadMap["repo.schedules.list"] &
      RepoScope);
    if (
      !isRendererRecord(value) ||
      value.ok !== true ||
      !Array.isArray(value.schedules) ||
      typeof value.watermark !== "number" ||
      typeof value.sourceRevision !== "number"
    )
      throw new Error(rendererErrorHint(value, "Schedules list bridge returned an invalid result."));
    return value as unknown as SchedulesListResult;
  },
  /**
   * `repo.schedules.runs(id)` — the occurrence run-history read (M3). The bridge
   * method only exists once the backend task lands the projection; until then
   * this throws and the Runs surface falls back to the occurrences the list read
   * already projects (activeRun / lastRun / missed aggregate), with the boundary
   * labeled in the UI instead of fabricated rows.
   */
  runs: async (repoId: string, scheduleId: string): Promise<ScheduleRunsResult> => {
    const method = (
      window.harness as unknown as Partial<{ listScheduleRuns: (payload: unknown) => Promise<unknown> }> | undefined
    )?.listScheduleRuns;
    if (!method) throw new Error("Schedule runs bridge is unavailable.");
    const value = await method({ repoId, scheduleId });
    if (
      !isRendererRecord(value) ||
      value.ok !== true ||
      !Array.isArray(value.runs) ||
      !isRendererRecord(value.totals) ||
      typeof value.watermark !== "number" ||
      typeof value.sourceRevision !== "number"
    )
      throw new Error(rendererErrorHint(value, "Schedule runs bridge returned an invalid result."));
    return value as unknown as ScheduleRunsResult;
  },
  create: (repoId: string, input: ScheduleDefinitionInput, idempotencyKey: string): Promise<ScheduleActionReceipt> =>
    invokeSchedule("createSchedule", { repoId, ...input, idempotencyKey }),
  update: (repoId: string, input: ScheduleDefinitionInput, idempotencyKey: string): Promise<ScheduleActionReceipt> =>
    invokeSchedule("updateSchedule", { repoId, ...input, idempotencyKey }),
  delete: (
    repoId: string,
    scheduleId: string,
    idempotencyKey: string,
    reason?: string,
  ): Promise<ScheduleActionReceipt> =>
    invokeSchedule("deleteSchedule", { repoId, scheduleId, ...(reason ? { reason } : {}), idempotencyKey }),
  enable: (repoId: string, scheduleId: string, idempotencyKey: string): Promise<ScheduleActionReceipt> =>
    scheduleAction("enableSchedule", repoId, scheduleId, idempotencyKey),
  disable: (repoId: string, scheduleId: string, idempotencyKey: string): Promise<ScheduleActionReceipt> =>
    scheduleAction("disableSchedule", repoId, scheduleId, idempotencyKey),
  runNow: (repoId: string, scheduleId: string, idempotencyKey: string): Promise<ScheduleActionReceipt> =>
    scheduleAction("runScheduleNow", repoId, scheduleId, idempotencyKey),
};

async function scheduleAction(
  method: "enableSchedule" | "disableSchedule" | "runScheduleNow",
  repoId: string,
  scheduleId: string,
  idempotencyKey: string,
): Promise<ScheduleActionReceipt> {
  return invokeSchedule(method, { repoId, scheduleId, idempotencyKey });
}

async function invokeSchedule(
  method:
    | "createSchedule"
    | "updateSchedule"
    | "deleteSchedule"
    | "enableSchedule"
    | "disableSchedule"
    | "runScheduleNow",
  payload: Readonly<Record<string, unknown>>,
): Promise<ScheduleActionReceipt> {
  const value = await bridge()[method](payload);
  if (
    !isRendererRecord(value) ||
    typeof value.command !== "string" ||
    typeof value.outcome !== "string" ||
    typeof value.opId !== "string"
  )
    throw new Error(rendererErrorHint(value, "Schedule action bridge returned an invalid receipt."));
  const error = isRendererRecord(value.error) ? value.error : null;
  return {
    ok: value.ok === true,
    command: value.command,
    outcome: value.outcome,
    opId: value.opId,
    code:
      typeof value.code === "string"
        ? value.code
        : error !== null && typeof error.code === "string"
          ? error.code
          : null,
    nextAction:
      typeof value.nextAction === "string"
        ? value.nextAction
        : error !== null && typeof error.hint === "string"
          ? error.hint
          : null,
    scheduleId: typeof value.scheduleId === "string" ? value.scheduleId : null,
  };
}

/** Deep-link ref for one schedule row; consumed by the Schedules view focus state. */
export const scheduleRef = (scheduleId: string): string => `schedule/${scheduleId}`;

export const scheduleRefId = (focusedEntityRef: string | null): string | null =>
  focusedEntityRef !== null && focusedEntityRef.startsWith("schedule/")
    ? (focusedEntityRef.slice("schedule/".length).split("/")[0] ?? null) || null
    : null;

/** Deep-link ref for one embedded run inside the schedule detail hub (M4). */
export const scheduleRunRef = (scheduleId: string, occurrenceId: string): string =>
  `schedule/${scheduleId}/runs/${occurrenceId}`;

/**
 * `schedule/<id>/runs/<occurrenceId>` → the occurrence id; anything else (the hub
 * ref `schedule/<id>` included) → null, meaning "render the hub, not a run".
 */
export const scheduleRunRefOccurrence = (focusedEntityRef: string | null): string | null => {
  if (focusedEntityRef === null || !focusedEntityRef.startsWith("schedule/")) return null;
  const segments = focusedEntityRef.slice("schedule/".length).split("/");
  return segments.length === 3 && segments[1] === "runs" && segments[2] !== "" ? (segments[2] ?? null) : null;
};

export const scheduleRowById = (
  rows: readonly ScheduleGuiRowDto[],
  scheduleId: string | null,
): ScheduleGuiRowDto | null =>
  scheduleId === null ? null : (rows.find((row) => row.scheduleId === scheduleId) ?? null);
