import { isJsonObject, type JsonValue } from "./json-rpc-types.ts";

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isJsonObject(value)) return value;
  return String(value);
}
