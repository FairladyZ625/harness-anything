export type JsonRpcId = string | number | null;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export interface JsonObject { readonly [key: string]: JsonValue }
export interface JsonRpcRequest { readonly jsonrpc: "2.0"; readonly method: string; readonly params?: JsonObject; readonly id?: JsonRpcId }
export interface JsonRpcSuccessResponse<Result = unknown> { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly result: Result }
export interface JsonRpcErrorObject { readonly code: number; readonly message: string; readonly data?: JsonValue }
export interface JsonRpcErrorResponse { readonly jsonrpc: "2.0"; readonly id: JsonRpcId; readonly error: JsonRpcErrorObject }
export type JsonRpcResponse<Result = unknown> = JsonRpcSuccessResponse<Result> | JsonRpcErrorResponse;
export function isJsonObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function rejectSecretKeys(value: unknown): readonly string[] { return hasSensitiveKey(value) ? ["payload contains a forbidden secret-like key"] : []; }
function hasSensitiveKey(value: unknown): boolean { if (Array.isArray(value)) return value.some(hasSensitiveKey); if (!isJsonObject(value)) return false; return Object.entries(value).some(([key, nested]) => /(?:secret|token|password|passphrase)/iu.test(key) || /^(?:api[-_]?key|credentialvalue)$/iu.test(key) || hasSensitiveKey(nested)); }
