export type JsonRpcId = string | number | null;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: JsonObject;
  readonly id?: JsonRpcId;
}
export interface JsonRpcSuccessResponse<Result = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: Result;
}
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonValue;
}
export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: JsonRpcErrorObject;
}
export type JsonRpcResponse<Result = unknown> = JsonRpcSuccessResponse<Result> | JsonRpcErrorResponse;
export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
  if (match === null) return false;
  const date = new Date(value),
    parts = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ];
  return Number.isFinite(date.getTime()) && parts.every((part, index) => part === Number(match[index + 1]));
}
export function unknownFieldViolation(
  value: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
): string | null {
  const field = Object.keys(value).find((candidate) => !allowedFields.includes(candidate));
  return field === undefined
    ? null
    : `unknown field ${JSON.stringify(field)}; allowed fields: ${allowedFields.map((candidate) => JSON.stringify(candidate)).join(", ")}.`;
}
export function rejectSecretKeys(value: unknown): readonly string[] {
  return hasSensitiveKey(value) ? ["payload contains a forbidden secret-like key"] : [];
}
function hasSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  if (!isJsonObject(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      /(?:secret|token|password|passphrase)/iu.test(key) ||
      /^(?:api[-_]?key|credentialvalue)$/iu.test(key) ||
      hasSensitiveKey(nested),
  );
}

export class DaemonProtocolContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DaemonProtocolContractError";
    this.code = code;
  }
}
