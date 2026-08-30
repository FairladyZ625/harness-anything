import {
  validateScheduleV1,
  type ScheduleMode,
  type ScheduleTriggerV1,
  type ScheduleV1,
} from "../../kernel/src/index.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

type ProjectedScheduleRow = {
  readonly id: string;
  readonly workspaceRevision: number;
  readonly value: Readonly<Record<string, unknown>>;
};

export type InvalidScheduleProjection = {
  readonly scheduleId: string;
  readonly state: "invalid";
  readonly invalidReason: string;
  readonly definitionRevision: number;
};

export type InspectedScheduleProjection =
  | {
      readonly valid: true;
      readonly schedule: ScheduleV1;
      readonly revision: number;
    }
  | {
      readonly valid: false;
      readonly value: Readonly<Record<string, unknown>>;
      readonly revision: number;
      readonly errors: readonly string[];
      readonly invalid: InvalidScheduleProjection;
    };

export function inspectScheduleProjection(row: ProjectedScheduleRow): InspectedScheduleProjection {
  const errors = validateScheduleV1(row.value);
  if (errors.length === 0)
    return { valid: true, schedule: row.value as unknown as ScheduleV1, revision: row.workspaceRevision };
  return {
    valid: false,
    value: row.value,
    revision: row.workspaceRevision,
    errors,
    invalid: {
      scheduleId: row.id,
      state: "invalid",
      invalidReason: errors.join("; "),
      definitionRevision: row.workspaceRevision,
    },
  };
}

export function mergeProjectedScheduleUpdate(input: {
  readonly value: Readonly<Record<string, unknown>>;
  readonly action: RepoTaskAction;
  readonly occurredAt: string;
  readonly requiredText: (value: unknown, name: string) => string;
}): { readonly schedule: ScheduleV1 | null; readonly errors: readonly string[] } {
  const { value, action, occurredAt, requiredText } = input,
    currentSpec = asRecord(value.spec),
    currentTarget = asRecord(currentSpec?.target),
    trigger = scheduleTriggerFromUpdate(action, currentSpec?.trigger, occurredAt),
    optionalTarget = (field: "model" | "reasoningEffort" | "cwd"): string | undefined =>
      Object.hasOwn(action, field)
        ? action[field] === null
          ? undefined
          : requiredText(action[field], field)
        : currentTarget?.kind === "agent" && typeof currentTarget[field] === "string"
          ? currentTarget[field]
          : undefined,
    model = optionalTarget("model"),
    reasoningEffort = optionalTarget("reasoningEffort"),
    cwd = optionalTarget("cwd"),
    fast: boolean | undefined = Object.hasOwn(action, "fast")
      ? action.fast === true
      : currentTarget?.kind === "agent" && typeof currentTarget.fast === "boolean"
        ? currentTarget.fast
        : undefined,
    target: unknown =
      currentTarget?.kind === "agent" || Object.hasOwn(action, "agentId") || Object.hasOwn(action, "runtimeInstanceId")
        ? {
            kind: "agent",
            agentId: Object.hasOwn(action, "agentId")
              ? requiredText(action.agentId, "agentId")
              : currentTarget?.agentId,
            runtimeInstanceId: Object.hasOwn(action, "runtimeInstanceId")
              ? requiredText(action.runtimeInstanceId, "runtimeInstanceId")
              : currentTarget?.runtimeInstanceId,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(fast === undefined ? {} : { fast }),
            ...(cwd ? { cwd } : {}),
          }
        : currentSpec?.target,
    candidate = {
      ...value,
      name: Object.hasOwn(action, "name") ? requiredText(action.name, "name").trim() : value.name,
      mode: Object.hasOwn(action, "mode") ? requiredScheduleMode(action.mode) : value.mode,
      spec: {
        ...(currentSpec ?? {}),
        trigger,
        target,
        mission: Object.hasOwn(action, "mission")
          ? requiredText(action.mission, "mission").trim()
          : currentSpec?.mission,
      },
      updatedAt: occurredAt,
    },
    errors = validateScheduleV1(candidate);
  return errors.length === 0 ? { schedule: candidate as unknown as ScheduleV1, errors } : { schedule: null, errors };
}

export function requiredScheduleMode(value: unknown): ScheduleMode {
  if (value === "detect" || value === "remediate") return value;
  throw Object.assign(new Error("Schedule mode must be detect or remediate."), { code: "invalid_command" });
}

export function scheduleTriggerFromCreate(action: RepoTaskAction, occurredAt: string): ScheduleTriggerV1 {
  if (Object.hasOwn(action, "everyMs") === Object.hasOwn(action, "cronExpression"))
    throw Object.assign(new Error("Schedule creation requires exactly one interval or cron trigger."), {
      code: "invalid_command",
    });
  return Object.hasOwn(action, "everyMs")
    ? { kind: "interval", everyMs: Number(action.everyMs), anchorAt: occurredAt }
    : {
        kind: "cron",
        expression: String(action.cronExpression),
        timezone: String(action.timezone),
      };
}

function scheduleTriggerFromUpdate(
  action: RepoTaskAction,
  current: unknown,
  occurredAt: string,
): ScheduleTriggerV1 | unknown {
  if (
    Object.hasOwn(action, "everyMs") &&
    (Object.hasOwn(action, "cronExpression") || Object.hasOwn(action, "timezone"))
  )
    throw Object.assign(new Error("Schedule update cannot combine interval and cron trigger fields."), {
      code: "invalid_command",
    });
  if (Object.hasOwn(action, "everyMs"))
    return { kind: "interval", everyMs: Number(action.everyMs), anchorAt: occurredAt };
  if (Object.hasOwn(action, "cronExpression"))
    return {
      kind: "cron",
      expression: String(action.cronExpression),
      timezone: String(action.timezone),
    };
  if (Object.hasOwn(action, "timezone")) {
    const currentTrigger = asRecord(current);
    if (currentTrigger?.kind !== "cron")
      throw Object.assign(new Error("Schedule timezone can only update a cron trigger."), { code: "invalid_command" });
    return { ...currentTrigger, timezone: String(action.timezone) };
  }
  return current;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
