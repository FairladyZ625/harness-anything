import { moduleEntityId } from "@harness-anything/kernel";
import type { ModuleRecordV2, ModuleRegisterPayloadV2, ModuleStepPayloadV2, ModuleUnregisterPayloadV2 } from "./task-decision-module-command-v2.ts";
import type { CompiledTaskDecisionModuleCommandV2, TaskDecisionModuleAuthorityStateV2 } from "./task-decision-module-semantic-compiler-v2.ts";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type { RegistryEntityRefV2 } from "./semantic-mutation-envelope-v2.ts";
import { semanticAdmissionV2 as admission, semanticMutationPlanV2 as plan } from "./semantic-authority-helpers-v2.ts";

export interface ModuleRegistryV2 {
  readonly schema: "module-registry/v1";
  readonly modules: ReadonlyArray<ModuleRecordV2>;
}

export async function compileModuleRegisterV2(state: TaskDecisionModuleAuthorityStateV2, payload: ModuleRegisterPayloadV2): Promise<CompiledTaskDecisionModuleCommandV2> {
  const { registry, snapshot } = await readModuleRegistryV2(state);
  const modules = registry.modules.some((entry) => entry.key === payload.module.key)
    ? registry.modules.map((entry) => entry.key === payload.module.key ? payload.module : entry)
    : [...registry.modules, payload.module];
  return moduleCompilation(payload.module.key, "register", { schema: "module-registry/v1", modules }, snapshot);
}

export async function compileModuleUnregisterV2(state: TaskDecisionModuleAuthorityStateV2, payload: ModuleUnregisterPayloadV2): Promise<CompiledTaskDecisionModuleCommandV2> {
  const { registry, snapshot } = await readModuleRegistryV2(state);
  if (!snapshot) throw admission("MODULE_REGISTRY_NOT_FOUND");
  const current = registry.modules.find((entry) => entry.key === payload.moduleKey);
  if (!current || current.status === "unregistered") throw admission("MODULE_NOT_FOUND");
  return moduleCompilation(payload.moduleKey, "unregister", {
    schema: "module-registry/v1",
    modules: registry.modules.map((entry) => entry.key === payload.moduleKey ? { ...entry, status: "unregistered" } : entry)
  }, snapshot);
}

export async function compileModuleStepV2(state: TaskDecisionModuleAuthorityStateV2, payload: ModuleStepPayloadV2): Promise<CompiledTaskDecisionModuleCommandV2> {
  const { registry, snapshot } = await readModuleRegistryV2(state);
  if (!snapshot) throw admission("MODULE_REGISTRY_NOT_FOUND");
  const current = registry.modules.find((entry) => entry.key === payload.moduleKey);
  if (!current || current.status === "unregistered") throw admission("MODULE_NOT_FOUND");
  const step = { id: payload.stepId, state: payload.state };
  const steps = current.steps.some((entry) => entry.id === payload.stepId)
    ? current.steps.map((entry) => entry.id === payload.stepId ? step : entry)
    : [...current.steps, step];
  return moduleCompilation(payload.moduleKey, "step", {
    schema: "module-registry/v1",
    modules: registry.modules.map((entry) => entry.key === payload.moduleKey ? { ...entry, steps } : entry)
  }, snapshot);
}

function moduleCompilation(moduleKey: string, action: "register" | "unregister" | "step", registry: ModuleRegistryV2, snapshot: HostedDocumentSnapshotV2 | null): CompiledTaskDecisionModuleCommandV2 {
  return {
    mutationPlan: plan([{ entityKind: "module", identity: { moduleKey }, action }]),
    operation: { opId: "authority-overrides-this", entityId: moduleEntityId(moduleKey), kind: "module_registry_write", payload: { operation: action, registry } },
    requiredBaseRefs: [moduleMutationRef("module", `module/${encodeURIComponent(moduleKey)}`)],
    requiredPathSnapshots: snapshot ? [{ path: "modules.json", snapshot }] : []
  };
}

export async function readModuleRegistryV2(state: TaskDecisionModuleAuthorityStateV2): Promise<{ readonly registry: ModuleRegistryV2; readonly snapshot: HostedDocumentSnapshotV2 | null }> {
  const snapshot = await state.readHostedDocument("modules.json");
  if (!snapshot) return { registry: { schema: "module-registry/v1", modules: [] }, snapshot: null };
  let value: unknown;
  try { value = JSON.parse(snapshot.body); } catch { throw admission("MODULE_REGISTRY_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw admission("MODULE_REGISTRY_INVALID");
  const row = value as { readonly schema?: unknown; readonly modules?: unknown };
  if (row.schema !== "module-registry/v1" || !Array.isArray(row.modules)) throw admission("MODULE_REGISTRY_INVALID");
  const modules = row.modules.map(decodeModuleRecord);
  if (new Set(modules.map((entry) => entry.key)).size !== modules.length) throw admission("MODULE_REGISTRY_DUPLICATE_KEY");
  return { registry: { schema: "module-registry/v1", modules }, snapshot };
}

function decodeModuleRecord(value: unknown): ModuleRecordV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw admission("MODULE_REGISTRY_INVALID");
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || typeof row.title !== "string" || typeof row.status !== "string" || !Array.isArray(row.scopes) || !Array.isArray(row.steps)) throw admission("MODULE_REGISTRY_INVALID");
  const optional = (key: string): string | undefined => row[key] === undefined ? undefined : typeof row[key] === "string" ? row[key] : invalidModuleRegistry();
  const stringArray = (key: string): ReadonlyArray<string> | undefined => row[key] === undefined ? undefined
    : Array.isArray(row[key]) && row[key].every((entry) => typeof entry === "string") ? row[key] as ReadonlyArray<string> : invalidModuleRegistry();
  const steps = row.steps.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw admission("MODULE_REGISTRY_INVALID");
    const step = entry as Record<string, unknown>;
    if (typeof step.id !== "string" || typeof step.state !== "string") throw admission("MODULE_REGISTRY_INVALID");
    return { id: step.id, state: step.state };
  });
  return {
    key: row.key, title: row.title,
    ...(optional("prefix") === undefined ? {} : { prefix: optional("prefix")! }), status: row.status,
    ...(optional("branch") === undefined ? {} : { branch: optional("branch")! }),
    ...(optional("owner") === undefined ? {} : { owner: optional("owner")! }),
    ...(optional("currentStep") === undefined ? {} : { currentStep: optional("currentStep")! }),
    scopes: row.scopes as ReadonlyArray<string>,
    ...(stringArray("shared") === undefined ? {} : { shared: stringArray("shared")! }),
    ...(stringArray("dependsOn") === undefined ? {} : { dependsOn: stringArray("dependsOn")! }), steps
  };
}

function invalidModuleRegistry(): never { throw admission("MODULE_REGISTRY_INVALID"); }
function moduleMutationRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 { return { registryVersion: 1, entityKind, canonicalRef }; }
