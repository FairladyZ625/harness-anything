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
  readonly enableSchedule: (payload: unknown) => Promise<unknown>;
  readonly disableSchedule: (payload: unknown) => Promise<unknown>;
  readonly runScheduleNow: (payload: unknown) => Promise<unknown>;
};
const bridge = (): SchedulesBridge => {
  const value = window.harness as unknown as Partial<SchedulesBridge> | undefined;
  if (!value?.listSchedules || !value.enableSchedule || !value.disableSchedule || !value.runScheduleNow)
    throw new Error("Schedules bridge is unavailable.");
  return value as SchedulesBridge;
};

export interface ScheduleActionReceipt {
  readonly ok: boolean;
  readonly command: string;
  readonly outcome: string;
  readonly opId: string;
  readonly code: string | null;
  readonly nextAction: string | null;
  readonly scheduleId: string | null;
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
  const value = await bridge()[method]({ repoId, scheduleId, idempotencyKey });
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

export const scheduleRowById = (
  rows: readonly ScheduleGuiRowDto[],
  scheduleId: string | null,
): ScheduleGuiRowDto | null =>
  scheduleId === null ? null : (rows.find((row) => row.scheduleId === scheduleId) ?? null);
