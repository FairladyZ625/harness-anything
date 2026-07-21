import { isRecord } from "../record.ts";
import type { DaemonGenerationWriteRejectionV1 } from "../authority/types.ts";

const stages = new Set([
  "before-prepare",
  "before-canonical-publish",
  "after-canonical-publish",
  "before-terminal-visibility",
  "before-terminal-journal"
]);

export function validAuthorityGenerationErrorFields(value: Record<string, unknown>): boolean {
  if (value.errorCode === undefined && value.errorContext === undefined) return true;
  return value.errorCode === "DAEMON_GENERATION_FENCED"
    && validDaemonGenerationWriteRejection(value.errorContext);
}

function validDaemonGenerationWriteRejection(value: unknown): value is DaemonGenerationWriteRejectionV1 {
  if (!isRecord(value)) return false;
  const required = ["schema", "machineId", "attemptedDaemonGeneration", "workspaceId", "stage"];
  const optional = ["currentDaemonGeneration", "runtimeRegistrationId", "connectionId", "opId"];
  if (!Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    || !required.every((key) => key in value)
    || value.schema !== "daemon-generation-write-rejection/v1"
    || typeof value.machineId !== "string" || value.machineId.length === 0
    || !positiveSafeInteger(value.attemptedDaemonGeneration)
    || typeof value.workspaceId !== "string" || value.workspaceId.length === 0
    || typeof value.stage !== "string" || !stages.has(value.stage)) return false;
  if (value.currentDaemonGeneration !== undefined && !positiveSafeInteger(value.currentDaemonGeneration)) return false;
  return ["runtimeRegistrationId", "connectionId", "opId"].every((key) =>
    value[key] === undefined || (typeof value[key] === "string" && value[key].length > 0));
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
