import { getExecutableEntityAction, validateEntityActionInput } from "../../../kernel/src/index.ts";
import { isJsonObject, unknownFieldViolation, type JsonObject } from "./json-rpc-types.ts";

export function validateCatalogActionPayload(value: JsonObject): readonly string[] {
  const action = (value.payload as JsonObject).action;
  return isJsonObject(action) &&
    typeof action.kind === "string" &&
    getExecutableEntityAction(action.kind)?.target.kind === "task"
    ? validateEntityActionInput(action.kind, action)
    : [];
}

export function validateSessionEnvironment(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return ["session environment must be an object"];
  const allowed = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"],
    unknown = unknownFieldViolation(value, allowed);
  if (unknown) return [`session environment contains an ${unknown}`];
  return Object.values(value).every((item) => typeof item === "string" && item.trim().length > 0)
    ? []
    : ["session environment values must be non-empty strings"];
}
