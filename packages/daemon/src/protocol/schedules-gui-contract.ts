import { SCHEDULE_MIN_EVERY_MS } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, rejectSecretKeys } from "./json-rpc-types.ts";

/** Schedule GUI wire contract(S4)。一次 `repo.schedules.list` 的 DTO 是定义 ledger +
 * 运行投影 + 本 daemon 的 mode/执行权 join;renderer 只格式化,不重算 cron/DST/nextRun,
 * 不判 repo mode,不选 node/provider(dec_9C393CDA 拓扑:定义=ledger,执行=runtime-local,
 * run view=projection)。本文件只持有线形状与校验,读侧 join 在
 * packages/daemon/src/schedules-gui-read.ts,protocol 目录不引 kernel barrel。 */
export type ScheduleExecutionAvailability = "local" | "claimed-elsewhere" | "unassigned" | "not-on-this-node";

export type ScheduleGuiTriggerDto =
  | {
      readonly kind: "interval";
      readonly everyMs: number;
      readonly expression: null;
      readonly timezone: null;
      readonly summary: string;
    }
  | {
      readonly kind: "cron";
      readonly everyMs: null;
      readonly expression: string;
      readonly timezone: string;
      readonly summary: string;
    };

export interface ScheduleGuiActionFacet {
  readonly available: boolean;
  readonly code: string | null;
  readonly nextAction: string | null;
}

export type ScheduleGuiAgentOptionDto =
  | {
      readonly agentId: string;
      readonly name: string;
      readonly runtimeType: string;
    }
  | {
      readonly agentId: string;
      readonly state: "invalid" | "missing";
      readonly error: { readonly code: string; readonly hint: string };
    };

export function isAvailableScheduleGuiAgentOption(
  option: ScheduleGuiAgentOptionDto,
): option is Extract<ScheduleGuiAgentOptionDto, { readonly name: string }> {
  return !("state" in option);
}

export interface ScheduleGuiOptionsDto {
  readonly agents: readonly ScheduleGuiAgentOptionDto[];
  readonly instances: readonly {
    readonly instanceId: string;
    readonly name: string;
    readonly kindId: string;
    readonly models: readonly string[];
    readonly efforts: readonly string[];
  }[];
}

/**
 * 健康度 rollup(最近若干次 occurrence 的 daemon 侧聚合)。`bucket` 是 daemon 的分类,
 * renderer 只渲染;`recent` 旧 → 新,运行中的 occurrence 是最后一段。
 */
export interface ScheduleGuiHealthDto {
  readonly recent: readonly ("running" | "succeeded" | "failed" | "missed" | "cancelled" | "unknown")[];
  readonly bucket: "degraded" | "clean";
  readonly failedCount: number;
  readonly lastFailureDetail: string | null;
}

export interface ScheduleGuiRowDto {
  readonly scheduleId: string;
  readonly name: string;
  readonly state: "armed" | "paused";
  readonly mode: "detect" | "remediate";
  readonly definitionResidency: "ledger";
  readonly definitionRevision: number;
  readonly trigger: ScheduleGuiTriggerDto;
  readonly target:
    | {
        readonly kind: "agent";
        readonly agentId: string;
        readonly runtimeInstanceId: string;
        readonly model: string | null;
        readonly reasoningEffort: string | null;
        readonly fast: boolean;
        readonly cwd: null;
      }
    | { readonly kind: "squad"; readonly squadId: string };
  readonly targetState?: "invalid" | "missing";
  readonly targetError?: { readonly code: string; readonly hint: string };
  readonly mission: string;
  readonly executionAvailability: ScheduleExecutionAvailability;
  readonly claim: { readonly nodeId: string | null; readonly assignmentId: string | null };
  readonly health: ScheduleGuiHealthDto;
  readonly nextRunAt: string | null;
  readonly actions: {
    readonly edit: ScheduleGuiActionFacet;
    readonly delete: ScheduleGuiActionFacet;
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

export interface ScheduleGuiInvalidRowDto {
  readonly scheduleId: string;
  readonly state: "invalid";
  readonly invalidReason: string;
  readonly definitionRevision: number;
}

export type ScheduleGuiListRowDto = ScheduleGuiRowDto | ScheduleGuiInvalidRowDto;

export interface SchedulesListResult {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  readonly repoMode: "local" | "remote-center" | "remote-edge";
  readonly viewerNodeId: string | null;
  readonly actions: { readonly create: ScheduleGuiActionFacet };
  readonly options: ScheduleGuiOptionsDto;
  readonly schedules: readonly ScheduleGuiListRowDto[];
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
  "mode",
  "definitionResidency",
  "definitionRevision",
  "trigger",
  "target",
  "targetState",
  "targetError",
  "mission",
  "executionAvailability",
  "claim",
  "health",
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

export function utcTimestamp(value: unknown, nullable = false): boolean {
  const valid = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
  return nullable ? value === null || valid : valid;
}

function scheduleNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function nullableNonEmpty(value: unknown): boolean {
  return value === null || scheduleNonEmptyText(value);
}

function validTriggerDto(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 5 &&
    ((value.kind === "interval" &&
      Number.isSafeInteger(value.everyMs) &&
      Number(value.everyMs) >= SCHEDULE_MIN_EVERY_MS &&
      value.expression === null &&
      value.timezone === null) ||
      (value.kind === "cron" &&
        value.everyMs === null &&
        scheduleNonEmptyText(value.expression) &&
        scheduleNonEmptyText(value.timezone))) &&
    scheduleNonEmptyText(value.summary)
  );
}

function validTargetDto(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  if (value.kind === "squad") return Object.keys(value).length === 2 && scheduleNonEmptyText(value.squadId);
  return (
    value.kind === "agent" &&
    Object.keys(value).length === 7 &&
    scheduleNonEmptyText(value.agentId) &&
    scheduleNonEmptyText(value.runtimeInstanceId) &&
    nullableNonEmpty(value.model) &&
    nullableNonEmpty(value.reasoningEffort) &&
    typeof value.fast === "boolean" &&
    value.cwd === null
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
  "actions",
  "options",
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
    !validRootActions(value.actions) ||
    !validOptions(value.options) ||
    !Array.isArray(value.schedules) ||
    !Number.isSafeInteger(value.watermark) ||
    !Number.isSafeInteger(value.sourceRevision)
  )
    return ["schedules list is invalid"];
  const secretErrors = rejectSecretKeys(value);
  if (secretErrors.length) return secretErrors;
  for (const row of value.schedules) {
    if (
      isJsonObject(row) &&
      Object.keys(row).length === 4 &&
      scheduleNonEmptyText(row.scheduleId) &&
      row.state === "invalid" &&
      scheduleNonEmptyText(row.invalidReason) &&
      Number.isSafeInteger(row.definitionRevision) &&
      Number(row.definitionRevision) >= 0
    )
      continue;
    if (
      !isJsonObject(row) ||
      Object.keys(row).some(
        (field) => !scheduleGuiRowFields.includes(field as (typeof scheduleGuiRowFields)[number]),
      ) ||
      !scheduleNonEmptyText(row.scheduleId) ||
      !scheduleNonEmptyText(row.name) ||
      !["armed", "paused"].includes(String(row.state)) ||
      !["detect", "remediate"].includes(String(row.mode)) ||
      row.definitionResidency !== "ledger" ||
      !Number.isSafeInteger(row.definitionRevision) ||
      Number(row.definitionRevision) < 0 ||
      !validTriggerDto(row.trigger) ||
      !validTargetDto(row.target) ||
      !validTargetProjection(row) ||
      typeof row.mission !== "string" ||
      !scheduleGuiAvailabilityWords.includes(String(row.executionAvailability)) ||
      !isJsonObject(row.claim) ||
      Object.keys(row.claim).length !== 2 ||
      !nullableNonEmpty(row.claim.nodeId) ||
      !nullableNonEmpty(row.claim.assignmentId) ||
      !validHealthRollup(row.health) ||
      !utcTimestamp(row.nextRunAt, true) ||
      !isJsonObject(row.actions) ||
      Object.keys(row.actions).length !== 5 ||
      !validActionFacet(row.actions.edit) ||
      !validActionFacet(row.actions.delete) ||
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

function validRootActions(value: unknown): boolean {
  return isJsonObject(value) && Object.keys(value).length === 1 && validActionFacet(value.create);
}

function validOptions(value: unknown): boolean {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.instances)
  )
    return false;
  return (
    value.agents.every(validAgentOption) &&
    value.instances.every(
      (instance) =>
        isJsonObject(instance) &&
        Object.keys(instance).length === 5 &&
        scheduleNonEmptyText(instance.instanceId) &&
        scheduleNonEmptyText(instance.name) &&
        typeof instance.kindId === "string" &&
        instance.kindId.length > 0 &&
        Array.isArray(instance.models) &&
        instance.models.every(scheduleNonEmptyText) &&
        Array.isArray(instance.efforts) &&
        instance.efforts.every(scheduleNonEmptyText),
    )
  );
}

function validAgentOption(agent: unknown): boolean {
  if (!isJsonObject(agent) || !scheduleNonEmptyText(agent.agentId)) return false;
  if (Object.hasOwn(agent, "state"))
    return (
      Object.keys(agent).length === 3 &&
      ["invalid", "missing"].includes(String(agent.state)) &&
      validProjectionError(agent.error)
    );
  return Object.keys(agent).length === 3 && scheduleNonEmptyText(agent.name) && scheduleNonEmptyText(agent.runtimeType);
}

function validProjectionError(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 2 &&
    scheduleNonEmptyText(value.code) &&
    scheduleNonEmptyText(value.hint)
  );
}

function validTargetProjection(row: Record<string, unknown>): boolean {
  const hasState = Object.hasOwn(row, "targetState"),
    hasError = Object.hasOwn(row, "targetError");
  if (!hasState && !hasError) return true;
  return (
    hasState &&
    hasError &&
    ["invalid", "missing"].includes(String(row.targetState)) &&
    validProjectionError(row.targetError)
  );
}

function validHealthRollup(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 4 &&
    Array.isArray(value.recent) &&
    value.recent.every((outcome) =>
      ["running", "succeeded", "failed", "missed", "cancelled", "unknown"].includes(String(outcome)),
    ) &&
    ["degraded", "clean"].includes(String(value.bucket)) &&
    Number.isSafeInteger(value.failedCount) &&
    Number(value.failedCount) >= 0 &&
    nullableNonEmpty(value.lastFailureDetail)
  );
}

export const serializeSchedulesList = (value: unknown): string => {
  const errors = validateSchedulesList(value);
  if (errors.length) throw new TypeError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
};
