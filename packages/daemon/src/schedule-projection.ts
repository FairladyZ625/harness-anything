import { validateScheduleV1, type ScheduleV1 } from "../../kernel/src/index.ts";

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
