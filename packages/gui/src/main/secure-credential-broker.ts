import { randomUUID } from "node:crypto";
import { credentialPort, type CredentialPort } from "../../../daemon/src/agent-runtime-credential-port.ts";

// GUI 创作面凭据通道(产品决策:本地工具,用户想放 key 就让他放)。用户在创建
// 表单里亲手输入 API key,主进程把它存进本机凭据库(macOS keychain / Linux
// secret service / Windows Credential Manager),转发给 daemon 的只有 opaque
// `credential:v1:` 引用。key 不落盘、不进日志、不进任何回执;表单提交后立即
// 清空,不回填。绝不由本进程代替用户输入 key —— key 只能来自表单输入。
type Kind = "claude" | "codex" | "agy"; type CreatePayload = { readonly instanceId: string; readonly name: string; readonly kindId: Kind; readonly installationId: string; readonly providerId: string; readonly models: readonly string[]; readonly defaultModel?: string; readonly permissionMode?: "bypass" | "workspace-write" | "read-only"; readonly isolationState?: "enforced" | "operator-environment"; readonly claude?: { readonly baseUrl?: string }; readonly codex?: { readonly reasoningEffort?: string; readonly baseUrl?: string; readonly wireApi?: string; readonly requiresOpenAiAuth?: boolean; readonly httpHeaders?: Readonly<Record<string, string>> }; readonly agy?: { readonly effort?: "low" | "medium" | "high" }; readonly authMode: "subscription" | "api-key"; readonly apiKey?: string }; type Receipt = Readonly<Record<string, unknown>>;
export function createRuntimeInstanceCredentialController(input: { readonly port?: CredentialPort; readonly create: (payload: Record<string, unknown>) => Promise<Receipt> }) { const port = input.port ?? credentialPort(); return { create: async (payload: CreatePayload): Promise<Receipt> => {
  if (payload.authMode === "subscription") return payload.apiKey === undefined ? input.create(payload) : unavailable("invalid_field", "Subscription runtime instances cannot include an API key.");
  if (payload.kindId === "agy") return unavailable("runtime_auth_mode_mismatch", "agy runtime instances support subscription OAuth only.");
  if (typeof payload.apiKey !== "string" || payload.apiKey.trim().length === 0) return unavailable("api_key_required", "Enter the provider API key in the create form; it is stored only in the local credential vault.");
  const { apiKey, ...rest } = payload;
  let credentialRef: string;
  try { credentialRef = port.issue(); await port.store(credentialRef, apiKey.trim()); } catch { return unavailable("runtime_credential_unavailable", "The local credential vault refused to store this API key; the instance was not created and no secret was persisted."); }
  return input.create({ ...rest, credentialRef });
} }; }
function unavailable(code: string, hint: string): Receipt { return { schema: "command-receipt/v2", ok: false, command: "runtime-instance-create", outcome: "op_rejected", opId: `runtime-instance-create:${randomUUID()}`, code, origin: "electron-main", evidence: `rejection:${code}`, error: { code, hint }, nextAction: hint }; }
