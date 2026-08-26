import { isJsonObject, rejectSecretKeys } from "./json-rpc-types.ts";

/** Schedule GUI wire contract(S4)。一次 `repo.schedules.list` 的 DTO 是定义 ledger +
 * 运行投影 + 本 daemon 的 mode/执行权 join;renderer 只格式化,不重算 cron/DST/nextRun,
 * 不判 repo mode,不选 node/provider(dec_9C393CDA 拓扑:定义=ledger,执行=runtime-local,
 * run view=projection)。本文件只持有线形状与校验,读侧 join 在
 * packages/daemon/src/schedules-gui-read.ts,protocol 目录不引 kernel barrel。 */
export type ScheduleExecutionAvailability = "local" | "claimed-elsewhere" | "unassigned" | "not-on-this-node";

/** Kernel `ScheduleTriggerV1` only defines the interval trigger, so the wire carries
 * exactly that variant — a schedule entity with any other trigger shape is rejected
 * by the read-side join instead of being recast here. */
export type ScheduleGuiTriggerDto = {
  readonly kind: "interval";
  readonly everyMs: number;
  readonly timezone: null;
  readonly summary: string;
};

export interface ScheduleGuiActionFacet {
  readonly available: boolean;
  readonly code: string | null;
  readonly nextAction: string | null;
}

export interface ScheduleGuiRowDto {
  readonly scheduleId: string;
  readonly name: string;
  readonly state: "armed" | "paused";
  readonly definitionResidency: "ledger";
  readonly definitionRevision: number;
  readonly trigger: ScheduleGuiTriggerDto;
  readonly target: {
    readonly agentId: string;
    readonly runtimeInstanceId: string;
    readonly model: string | null;
    readonly reasoningEffort: string | null;
    readonly cwd: string | null;
  };
  readonly mission: string;
  readonly executionAvailability: ScheduleExecutionAvailability;
  readonly claim: { readonly nodeId: string | null; readonly assignmentId: string | null };
  readonly nextRunAt: string | null;
  readonly actions: {
    readonly enable: ScheduleGuiActionFacet;
    readonly disable: ScheduleGuiActionFacet;
    readonly runNow: ScheduleGuiActionFacet;
  };
  readonly activeRun: {
    readonly occurrenceId: string;
    readonly kind: "scheduled" | "manual";
    readonly scheduledFor: string;
    readonly claimedAt: string;
    readonly nodeId: string;
    readonly assignmentId: string | null;
    readonly attemptIndex: number;
    readonly dispatchId: string | null;
    readonly runtimeSessionId: string | null;
  } | null;
  readonly lastRun: {
    readonly occurrenceId: string;
    readonly scheduledFor: string;
    readonly endedAt: string;
    readonly outcome: string;
    readonly nodeId: string;
    readonly assignmentId: string | null;
    readonly attemptIndex: number;
    readonly dispatchId: string | null;
    readonly runtimeSessionId: string | null;
    readonly detail: string | null;
  } | null;
  readonly missed: {
    readonly count: number;
    readonly lastMissedAt: string | null;
    readonly lastMissedReason: string | null;
  };
  readonly automaticEvaluatedThrough: string;
  readonly updatedAt: string;
}

export interface SchedulesListResult {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  readonly repoMode: "local" | "remote-center" | "remote-edge";
  readonly viewerNodeId: string | null;
  /** How execution ownership was resolved: "roster" = the assignment authority
   * (fleet roster, or daemon-local ownership in local mode — local never consults a
   * roster, so the value is vacuously "roster" there) resolved; "unavailable" = the
   * roster could not be resolved, so claim/assignment fields degrade to null and
   * availability falls back to not-on-this-node. */
  readonly assignmentResolution: "roster" | "unavailable";
  readonly schedules: readonly ScheduleGuiRowDto[];
  readonly watermark: number;
  readonly sourceRevision: number;
}

const scheduleGuiAvailabilityWords: readonly string[] = [
  "local",
  "claimed-elsewhere",
  "unassigned",
  "not-on-this-node",
];
const scheduleGuiOutcomeWords: readonly string[] = ["succeeded", "failed", "unknown", "cancelled"];
const scheduleGuiMissedReasonWords: readonly string[] = ["scheduler_unavailable", "single_flight"];
const scheduleGuiRowFields = [
  "scheduleId",
  "name",
  "state",
  "definitionResidency",
  "definitionRevision",
  "trigger",
  "target",
  "mission",
  "executionAvailability",
  "claim",
  "nextRunAt",
  "actions",
  "activeRun",
  "lastRun",
  "missed",
  "automaticEvaluatedThrough",
  "updatedAt",
] as const;
const activeRunFields = [
  "occurrenceId",
  "kind",
  "scheduledFor",
  "claimedAt",
  "nodeId",
  "assignmentId",
  "attemptIndex",
  "dispatchId",
  "runtimeSessionId",
] as const;
const lastRunFields = [
  "occurrenceId",
  "scheduledFor",
  "endedAt",
  "outcome",
  "nodeId",
  "assignmentId",
  "attemptIndex",
  "dispatchId",
  "runtimeSessionId",
  "detail",
] as const;

function utcTimestamp(value: unknown, nullable = false): boolean {
  const valid = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
  return nullable ? value === null || valid : valid;
}

function scheduleNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableNonEmpty(value: unknown): boolean {
  return value === null || scheduleNonEmptyText(value);
}

function validTriggerDto(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.kind === "interval" &&
    Object.keys(value).length === 4 &&
    Number.isSafeInteger(value.everyMs) &&
    Number(value.everyMs) >= 60_000 &&
    value.timezone === null &&
    scheduleNonEmptyText(value.summary)
  );
}

function validActionFacet(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 3 &&
    typeof value.available === "boolean" &&
    nullableNonEmpty(value.code) &&
    (value.available
      ? value.code === null && value.nextAction === null
      : scheduleNonEmptyText(value.code) && scheduleNonEmptyText(value.nextAction))
  );
}

function validAttemptSummary(value: unknown, fields: readonly string[]): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).every((field) => fields.includes(field)) &&
    fields.every((field) => Object.hasOwn(value, field)) &&
    scheduleNonEmptyText(value.occurrenceId) &&
    scheduleNonEmptyText(value.nodeId) &&
    (value.kind === undefined || ["scheduled", "manual"].includes(String(value.kind))) &&
    (value.outcome === undefined || scheduleGuiOutcomeWords.includes(String(value.outcome))) &&
    utcTimestamp(value.scheduledFor) &&
    (value.claimedAt === undefined || utcTimestamp(value.claimedAt)) &&
    (value.endedAt === undefined || utcTimestamp(value.endedAt)) &&
    // The join always emits these three link fields; before a run links its dispatch
    // or session they are null, so the wire shape is nullable non-empty — never absent
    // and never blank.
    ["dispatchId", "runtimeSessionId", "detail"].every(
      (field) => !Object.hasOwn(value, field) || nullableNonEmpty(value[field]),
    ) &&
    nullableNonEmpty(value.assignmentId) &&
    Number.isSafeInteger(value.attemptIndex) &&
    Number(value.attemptIndex) >= 0
  );
}

const schedulesListFields = [
  "ok",
  "status",
  "repoId",
  "repoMode",
  "viewerNodeId",
  "assignmentResolution",
  "schedules",
  "watermark",
  "sourceRevision",
] as const;

export function validateSchedulesList(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((field) => !schedulesListFields.includes(field as (typeof schedulesListFields)[number])) ||
    value.ok !== true ||
    !["ready", "pending"].includes(String(value.status)) ||
    !scheduleNonEmptyText(value.repoId) ||
    !["local", "remote-center", "remote-edge"].includes(String(value.repoMode)) ||
    !nullableNonEmpty(value.viewerNodeId) ||
    !["roster", "unavailable"].includes(String(value.assignmentResolution)) ||
    !Array.isArray(value.schedules) ||
    !Number.isSafeInteger(value.watermark) ||
    !Number.isSafeInteger(value.sourceRevision)
  )
    return ["schedules list is invalid"];
  const secretErrors = rejectSecretKeys(value);
  if (secretErrors.length) return secretErrors;
  for (const row of value.schedules) {
    if (
      !isJsonObject(row) ||
      Object.keys(row).some(
        (field) => !scheduleGuiRowFields.includes(field as (typeof scheduleGuiRowFields)[number]),
      ) ||
      !scheduleNonEmptyText(row.scheduleId) ||
      !scheduleNonEmptyText(row.name) ||
      !["armed", "paused"].includes(String(row.state)) ||
      row.definitionResidency !== "ledger" ||
      !Number.isSafeInteger(row.definitionRevision) ||
      Number(row.definitionRevision) < 0 ||
      !validTriggerDto(row.trigger) ||
      !isJsonObject(row.target) ||
      Object.keys(row.target).length !== 5 ||
      !scheduleNonEmptyText(row.target.agentId) ||
      !scheduleNonEmptyText(row.target.runtimeInstanceId) ||
      !nullableNonEmpty(row.target.model) ||
      !nullableNonEmpty(row.target.reasoningEffort) ||
      !nullableNonEmpty(row.target.cwd) ||
      typeof row.mission !== "string" ||
      !scheduleGuiAvailabilityWords.includes(String(row.executionAvailability)) ||
      !isJsonObject(row.claim) ||
      Object.keys(row.claim).length !== 2 ||
      !nullableNonEmpty(row.claim.nodeId) ||
      !nullableNonEmpty(row.claim.assignmentId) ||
      !utcTimestamp(row.nextRunAt, true) ||
      !isJsonObject(row.actions) ||
      Object.keys(row.actions).length !== 3 ||
      !validActionFacet(row.actions.enable) ||
      !validActionFacet(row.actions.disable) ||
      !validActionFacet(row.actions.runNow) ||
      !(row.activeRun === null || validAttemptSummary(row.activeRun, activeRunFields)) ||
      !(row.lastRun === null || validAttemptSummary(row.lastRun, lastRunFields)) ||
      !isJsonObject(row.missed) ||
      Object.keys(row.missed).length !== 3 ||
      !Number.isSafeInteger(row.missed.count) ||
      Number(row.missed.count) < 0 ||
      !utcTimestamp(row.missed.lastMissedAt, true) ||
      !(
        row.missed.lastMissedReason === null ||
        scheduleGuiMissedReasonWords.includes(String(row.missed.lastMissedReason))
      ) ||
      !utcTimestamp(row.automaticEvaluatedThrough) ||
      !utcTimestamp(row.updatedAt)
    )
      return ["schedule row is invalid"];
  }
  return [];
}

export const serializeSchedulesList = (value: unknown): string => {
  const errors = validateSchedulesList(value);
  if (errors.length) throw new TypeError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
};
