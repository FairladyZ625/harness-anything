import type { RuntimeInstanceSummary } from "../../../daemon/src/agent-runtime-instances.ts";
import type { RuntimeInstanceCreateInput } from "./runtime-instance-client.ts";
import { planeAllowsBaseUrl, planeAllowsEffort, planeAuthMode, runtimeProviderPlane, type RuntimeAuthMode, type RuntimeKindId } from "./runtime-provider-planes.ts";

export type CreateInstanceFormState = { readonly instanceId: string; readonly name: string; readonly kindId: RuntimeKindId; readonly installationId: string; readonly providerId: string; readonly model: string; readonly reasoningEffort: string; readonly baseUrl: string; readonly authMode: RuntimeAuthMode; readonly apiKey: string; readonly wireApi: string; readonly requiresOpenAiAuth: boolean; readonly permissionMode?: "bypass" | "workspace-write" | "read-only"; readonly isolation: "enforced" | "operator-environment" };

export function buildRuntimeInstanceCreatePayload(form: CreateInstanceFormState, installationId: string): RuntimeInstanceCreateInput {
  const models = form.model.split(/[\s,]+/u).filter(Boolean), common = { instanceId: form.instanceId.trim(), name: form.name.trim(), installationId, providerId: form.providerId.trim(), models }, baseUrl = form.baseUrl.trim();
  if (form.kindId === "agy") {
    if (form.authMode !== "subscription") throw new Error("agy runtime instances support subscription OAuth only.");
    return { ...common, kindId: "agy", authMode: "subscription", agy: { ...(form.reasoningEffort.trim() ? { effort: form.reasoningEffort.trim() as "low" | "medium" | "high" } : {}) } };
  }
  const auth = form.authMode === "api-key" ? { authMode: "api-key" as const, apiKey: form.apiKey.trim() } : { authMode: "subscription" as const };
  const isolation = { isolationState: form.isolation };
  return form.kindId === "codex" ? { ...common, ...auth, kindId: "codex", ...isolation, permissionMode: form.permissionMode, codex: { ...(form.reasoningEffort.trim() ? { reasoningEffort: form.reasoningEffort.trim() } : {}), ...(baseUrl ? { baseUrl } : {}), ...(form.wireApi ? { wireApi: form.wireApi } : {}), ...(form.requiresOpenAiAuth ? { requiresOpenAiAuth: true } : {}) } } : { ...common, ...auth, kindId: "claude", ...isolation, permissionMode: form.permissionMode, claude: { ...(baseUrl ? { baseUrl } : {}) } };
}

// Switching provider plane rewrites every field the new plane does not have, so a value
// typed under one plane can never be submitted under another (the "combination the user
// cannot build" rule): agy loses base URL, key, wire api and permissions outright, and a
// plane without the requested auth mode falls back to its subscription login.
export function applyRuntimeKind(form: CreateInstanceFormState, kindId: RuntimeKindId, defaults: { readonly permissionMode?: CreateInstanceFormState["permissionMode"]; readonly isolation: CreateInstanceFormState["isolation"] }): CreateInstanceFormState {
  const authMode = planeAuthMode(kindId, form.authMode);
  return { ...form, kindId, providerId: runtimeProviderPlane(kindId).defaultProviderId, installationId: "", authMode, apiKey: "", wireApi: "", requiresOpenAiAuth: false, baseUrl: planeAllowsBaseUrl(kindId, authMode) ? form.baseUrl : "", reasoningEffort: planeAllowsEffort(kindId) ? form.reasoningEffort : "", permissionMode: defaults.permissionMode, isolation: defaults.isolation };
}

export function applyRuntimeAuthMode(form: CreateInstanceFormState, requested: RuntimeAuthMode): CreateInstanceFormState {
  const authMode = planeAuthMode(form.kindId, requested);
  return { ...form, authMode, apiKey: "", baseUrl: planeAllowsBaseUrl(form.kindId, authMode) ? form.baseUrl : "" };
}

export function runtimeInstanceFormReady(form: CreateInstanceFormState, installationId: string): boolean {
  return Boolean(installationId) && form.instanceId.trim() !== "" && form.name.trim() !== "" && form.model.trim() !== "" && (form.authMode !== "api-key" || form.apiKey.trim() !== "");
}

export function visibleRuntimeInstances(instances: readonly RuntimeInstanceSummary[], showDisabled: boolean): readonly RuntimeInstanceSummary[] { return showDisabled ? instances : instances.filter((instance) => instance.enabled); }
