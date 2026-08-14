import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { secureRuntimeBaseUrl } from "./agent-runtime-instances.ts";
import { writeRuntimeCredentialReceipt, type RuntimeCredentialReceipt } from "./gui-s3-control.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";

export interface RuntimeCredentialBinding { readonly kindId: "claude" | "codex"; readonly baseUrl: string | null; readonly credentialRef: string; readonly configuredAt: string }
export function openRuntimeCredentialBindings(input: { readonly userRoot: string; readonly now?: () => string }) {
  const target = path.join(input.userRoot, "runtime-credential-bindings.json"), now = input.now ?? (() => new Date().toISOString());
  return {
    bind: (payload: JsonObject): RuntimeCredentialReceipt => { const allowed = ["authorityRepoId", "kindId", "baseUrl", "credentialRef"]; if (Object.keys(payload).some((key) => !allowed.includes(key))) throw coded("invalid_credential_binding", "Credential binding contains an unknown field."); required(payload.authorityRepoId, "authorityRepoId"); const kindId = runtimeKind(payload.kindId), credentialRef = required(payload.credentialRef, "credentialRef"); if (!/^keychain:[A-Za-z0-9._/-]{1,240}$/u.test(credentialRef)) throw coded("invalid_credential_reference", "credentialRef must be an opaque native keychain reference."); const baseUrl = payload.baseUrl === undefined || payload.baseUrl === null ? null : secureUrl(payload.baseUrl), configuredAt = now(), current = read(); current.set(kindId, { kindId, baseUrl, credentialRef, configuredAt }); persist([...current.values()]); return writeRuntimeCredentialReceipt<RuntimeCredentialReceipt>({ schema: "runtime-credential-receipt/v1", ok: true, outcome: "applied", operationId: `runtime-credential-${createHash("sha256").update(`${kindId}\0${configuredAt}`).digest("hex").slice(0, 20)}`, kindId, credentialState: "configured", baseUrlConfigured: baseUrl !== null, error: null, nextAction: null }); },
    read: (kindId: "claude" | "codex"): RuntimeCredentialBinding | null => read().get(kindId) ?? null
  };
  function read(): Map<RuntimeCredentialBinding["kindId"], RuntimeCredentialBinding> { if (!existsSync(target)) return new Map(); const value = JSON.parse(readFileSync(target, "utf8")) as { readonly schema?: unknown; readonly bindings?: unknown }; if (value.schema !== "runtime-credential-bindings/v1" || !Array.isArray(value.bindings)) throw coded("invalid_credential_store", "Runtime credential binding metadata is invalid."); const bindings = value.bindings.map((entry) => { if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw coded("invalid_credential_store", "Runtime credential binding metadata is invalid."); const row = entry as Record<string, unknown>, kindId = runtimeKind(row.kindId), credentialRef = required(row.credentialRef, "credentialRef"), configuredAt = required(row.configuredAt, "configuredAt"), baseUrl = row.baseUrl === null ? null : secureUrl(row.baseUrl); return { kindId, credentialRef, configuredAt, baseUrl }; }); return new Map(bindings.map((binding) => [binding.kindId, binding])); }
  function persist(bindings: readonly RuntimeCredentialBinding[]): void { mkdirSync(input.userRoot, { recursive: true }); const temp = `${target}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify({ schema: "runtime-credential-bindings/v1", bindings: [...bindings].sort((a, b) => a.kindId.localeCompare(b.kindId)) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temp, target); }
}
function runtimeKind(value: unknown): "claude" | "codex" { if (value === "claude" || value === "codex") return value; throw coded("invalid_credential_binding", "kindId must be claude or codex."); }
const secureUrl = secureRuntimeBaseUrl;
function required(value: unknown, field: string): string { if (typeof value === "string" && value.length) return value; throw coded("invalid_credential_binding", `${field} is required.`); }
function coded(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
