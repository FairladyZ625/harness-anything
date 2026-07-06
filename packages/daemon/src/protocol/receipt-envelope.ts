import {
  commandReceiptEnvelope,
  type CommandFailureReceipt,
  type CommandReceipt,
  type CommandReceiptEnvelope
} from "../../../application/src/index.ts";

import type { JsonObject, JsonValue } from "./json-rpc-types.ts";

const legacyReceiptEnvelope = "CommandReceipt/v1" as const;

export function successReceipt(
  command: string,
  summary: string,
  data: JsonObject = {}
): CommandReceipt {
  const item = firstObject(data, ["item", "task", "decision", "session", "policy"]);
  const items = firstArray(data, ["items", "tasks", "sessions", "methods", "repos"]);
  return {
    ok: true,
    schema: commandReceiptEnvelope,
    command,
    action: actionFromMethod(command),
    summary,
    ...(item ? { item } : {}),
    ...(items ? { items } : {}),
    details: Object.keys(data).length > 0 ? { data } : {},
    meta: {
      generatedAt: new Date().toISOString(),
      compatibility: { legacyReceipt: legacyReceiptEnvelope }
    }
  };
}

export function failureReceipt(
  command: string,
  code: string,
  hint: string,
  details: JsonObject = {}
): CommandFailureReceipt {
  return {
    ok: false,
    schema: commandReceiptEnvelope,
    command,
    action: actionFromMethod(command),
    summary: hint,
    error: { code, hint },
    ...(Object.keys(details).length > 0 ? { details } : {}),
    meta: {
      generatedAt: new Date().toISOString(),
      compatibility: { legacyReceipt: legacyReceiptEnvelope }
    }
  };
}

export function serviceResultReceipt(command: string, result: JsonObject): CommandReceiptEnvelope {
  if (result.ok === false) {
    const error = result.error && typeof result.error === "object" && !Array.isArray(result.error)
      ? result.error as JsonObject
      : {};
    const code = typeof error.code === "string" ? error.code : "service_rejected";
    const hint = typeof error.hint === "string" ? error.hint : `Service method ${command} rejected the request.`;
    return failureReceipt(command, code, hint, { data: result });
  }
  return successReceipt(command, `completed ${command}`, result);
}

function actionFromMethod(method: string): string {
  const parts = method.split(".");
  return parts.slice(1).join(".") || method;
}

function firstObject(record: JsonObject, keys: ReadonlyArray<string>): JsonObject | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  }
  return undefined;
}

function firstArray(record: JsonObject, keys: ReadonlyArray<string>): ReadonlyArray<JsonValue> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}
