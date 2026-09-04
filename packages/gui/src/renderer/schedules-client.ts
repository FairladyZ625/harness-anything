import type {
  ScheduleGuiHealthDto,
  ScheduleGuiListRowDto,
  ScheduleGuiRowDto,
  SchedulesListResult,
} from "../../../daemon/src/protocol/schedules-gui-contract.ts";
import type {
  ScheduleRunOutputsDto,
  ScheduleRunsResult as DaemonScheduleRunsResult,
} from "../../../daemon/src/protocol/schedule-runs-contract.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
import { readUseCaseProjection } from "./use-case-projection-client.ts";

// Renderer client for the Schedule plane (S4). The `schedule-plane` use-case projection returns
// the complete joined DTO — cadence/timezone/nextRun/mode/availability are daemon
// facts, and this file never recomputes them. The three actions return command
// receipts; enablement comes from the DTO facets, not from local mode branching.
type SchedulesBridge = {
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
    !value?.createSchedule ||
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
// Read-projection contract(design.html §6):`schedule-run-history` 读已落地,列表行
// 带 mode/target/健康度 rollup——这里只复述 daemon 形状,不再保留「后端未投影」的
// 可选字段垫层;没有数据就是 daemon 投影的空值,不是渲染层的猜测。
// ---------------------------------------------------------------------------

/** Outcome vocabulary for one occurrence row; `missed` rows are visible history. */
export type ScheduleRunOutcomeWord = "running" | "succeeded" | "failed" | "missed" | "cancelled" | "unknown";
/** Purpose dimension (design §4 A): detect = read-only boundary, remediate = write/PR boundary. */
export type ScheduleModeWord = "detect" | "remediate";

/** One occurrence in the run-history timeline: daemon-formatted facts only. */
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
  readonly outcome: ScheduleRunOutcomeWord;
  /** Populated on `missed` rows (`scheduler_unavailable` / `single_flight`). */
  readonly missedReason: string | null;
  /** Artifact ref of the occurrence report (runtime-result)。 */
  readonly reportRef: string | null;
  /** report artifact 的完整正文;无报告/未就绪为 null,由 daemon 原样给出(不截断)。 */
  readonly reportText: string | null;
  /** settle detail 中非报告引用的部分——失败原因等真实细节。 */
  readonly detail: string | null;
  /** 该 occurrence 的 runtime session 写入的 fact/decision/task 产出。 */
  readonly outputs: ScheduleRunOutputsDto;
}

export type ScheduleRunsResult = Omit<DaemonScheduleRunsResult, "runs"> & {
  readonly runs: readonly ScheduleGuiRunRowDto[];
};

/**
 * Health rollup the daemon aggregates over recent occurrences. `bucket` is the
 * daemon's classification — the renderer never re-derives degraded/clean from
 * outcomes (dec_8DCD52E98BAB268B0194B1E399: status judgments are daemon-side).
 */
export type ScheduleHealthRollup = ScheduleGuiHealthDto;

/** mode 是 daemon 列表行的必有事实(detect/remediate),渲染层不再保留 pending 态。 */
export const scheduleRowMode = (row: ScheduleGuiRowDto): ScheduleModeWord => row.mode;

/** 执行体种类来自 target 判别式(agent/squad),不是本地默认。 */
export const scheduleRowTargetKind = (row: ScheduleGuiRowDto): "agent" | "squad" => row.target.kind;

/** 健康度 rollup 由 daemon 投影;无效行(invalid)没有该字段,调用方先行过滤。 */
export const scheduleRowHealth = (row: ScheduleGuiRowDto): ScheduleHealthRollup => row.health;

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
  readonly fast?: boolean;
}

export const schedulesClient = {
  list: async (repoId: string): Promise<SchedulesListResult> => {
    const value = await readUseCaseProjection({ repoId, name: "schedule-plane" });
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
   * The `schedule-run-history` use-case projection: the occurrence run history (M3), including
   * each occurrence's report artifact text and the fact/decision/task outputs its runtime
   * session wrote. Read failures surface as errors (the hub then shows the occurrences the
   * plane projection still carries, with the failure labeled).
   */
  runs: async (repoId: string, scheduleId: string): Promise<ScheduleRunsResult> => {
    const value = await readUseCaseProjection({ repoId, name: "schedule-run-history", scheduleId });
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
  rows: readonly ScheduleGuiListRowDto[],
  scheduleId: string | null,
): ScheduleGuiRowDto | null =>
  scheduleId === null
    ? null
    : (rows.find((row): row is ScheduleGuiRowDto => row.scheduleId === scheduleId && row.state !== "invalid") ?? null);
