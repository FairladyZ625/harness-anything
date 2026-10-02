import type { RuntimeInstanceSummary } from "@harness-anything/daemon/protocol";
import type { TerminalControlReceipt } from "@harness-anything/daemon/protocol";
import { guiHostBridge } from "./gui-transport.ts";
export interface RuntimeInstallationRow {
  readonly installationId: string;
  readonly kindId: string;
  readonly version: string;
  readonly observedAt: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
}
export interface RuntimeInstanceCatalog {
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly installations: readonly RuntimeInstallationRow[];
}
export type RuntimeInstanceUpdateInput = {
  readonly instanceId: string;
  /** A newly entered key; omitted leaves the current credential unchanged. */
  readonly apiKey?: string;
  readonly name?: string;
  readonly installationId?: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  /** Non-empty replaces the endpoint (create-time validation applies); empty clears back
   * to the official endpoint; omitted leaves it untouched. claude/codex API mode only. */
  readonly baseUrl?: string;
  /** Non-empty replaces the effort preset under the kind's own configuration key
   * (create-time validation applies); empty clears back to the provider default; omitted
   * leaves it untouched. Available on kinds whose catalog entry declares an effort field. */
  readonly effort?: string;
  readonly enabled?: boolean;
  readonly permissionMode?: "bypass" | "workspace-write" | "read-only";
  readonly isolationState?: "enforced" | "operator-environment";
  readonly fast?: boolean;
};
type RuntimeInstanceCreateCommon = {
  readonly instanceId: string;
  readonly name: string;
  readonly installationId: string;
  readonly providerId: string;
  readonly models: readonly string[];
  readonly defaultModel?: string;
  readonly permissionMode?: "bypass" | "workspace-write" | "read-only";
  readonly isolationState?: "enforced" | "operator-environment";
};
// Keys travel once through the trusted bridge to the selected daemon's native vault.
export type RuntimeInstanceCreateInput = RuntimeInstanceCreateCommon & {
  readonly kindId: string;
  readonly [field: string]: unknown;
} & ({ readonly authMode: "subscription" } | { readonly authMode: "api-key"; readonly apiKey: string });
type Bridge = {
  readonly listRuntimeInstances: (payload: { readonly all: true; readonly repoId?: string }) => Promise<unknown>;
  readonly showRuntimeInstance: (payload: {
    readonly instanceId: string;
    readonly probe?: boolean;
    readonly repoId?: string;
  }) => Promise<unknown>;
  readonly createRuntimeInstance: (
    payload: RuntimeInstanceCreateInput & { readonly repoId?: string },
  ) => Promise<unknown>;
  readonly updateRuntimeInstance: (
    payload: RuntimeInstanceUpdateInput & { readonly repoId?: string },
  ) => Promise<unknown>;
  readonly deleteRuntimeInstance: (payload: {
    readonly instanceId: string;
    readonly repoId?: string;
  }) => Promise<unknown>;
  readonly signInRuntimeInstance: (payload: AuthInput) => Promise<unknown>;
  readonly signOutRuntimeInstance: (payload: AuthInput) => Promise<unknown>;
};
type AuthInput = { readonly repoId: string; readonly instanceId: string; readonly idempotencyKey: string };
const bridge = (): Bridge => {
  const value = guiHostBridge() as unknown as Partial<Bridge> | undefined,
    required = [
      "listRuntimeInstances",
      "showRuntimeInstance",
      "createRuntimeInstance",
      "updateRuntimeInstance",
      "deleteRuntimeInstance",
      "signInRuntimeInstance",
      "signOutRuntimeInstance",
    ] as const;
  if (!value || required.some((method) => typeof value[method] !== "function"))
    throw new Error("Runtime instance bridge is unavailable.");
  return value as Bridge;
};
export const runtimeInstanceClient = {
  list: async (repoId?: string): Promise<RuntimeInstanceCatalog> =>
    runtimeInstanceCatalog(await bridge().listRuntimeInstances({ all: true, ...scope(repoId) })),
  show: (instanceId: string, repoId?: string) =>
    runtimeInstanceReceipt(bridge().showRuntimeInstance({ instanceId, ...scope(repoId) })),
  create: (input: RuntimeInstanceCreateInput, repoId?: string) =>
    runtimeInstanceReceipt(bridge().createRuntimeInstance({ ...input, ...scope(repoId) })),
  update: (input: RuntimeInstanceUpdateInput, repoId?: string) =>
    runtimeInstanceReceipt(bridge().updateRuntimeInstance({ ...input, ...scope(repoId) })),
  setEnabled: (instanceId: string, enabled: boolean, repoId?: string) =>
    runtimeInstanceClient.update({ instanceId, enabled }, repoId),
  delete: (instanceId: string, repoId?: string) =>
    runtimeInstanceReceipt(bridge().deleteRuntimeInstance({ instanceId, ...scope(repoId) })),
  probe: async (instanceId: string, repoId?: string): Promise<RuntimeInstanceSummary> =>
    runtimeInstanceSummary(
      (await runtimeInstanceReceipt(bridge().showRuntimeInstance({ instanceId, probe: true, ...scope(repoId) })))
        .instance,
    ),
  auth: async (repoId: string, instanceId: string, action: "login" | "logout"): Promise<TerminalControlReceipt> =>
    runtimeInstanceTerminal(
      await bridge()[action === "login" ? "signInRuntimeInstance" : "signOutRuntimeInstance"]({
        repoId,
        instanceId,
        idempotencyKey: `runtime-auth-${action}-${instanceId}-${crypto.randomUUID()}`,
      }),
    ),
};
const scope = (repoId?: string) => (repoId === undefined ? {} : { repoId });
async function runtimeInstanceReceipt(value: Promise<unknown>): Promise<Record<string, unknown>> {
  const result = await value;
  if (!runtimeInstanceRecord(result) || result.schema !== "command-receipt/v2" || typeof result.ok !== "boolean")
    throw new Error(runtimeInstanceHint(result, "Runtime instance operation returned an invalid receipt."));
  if (!result.ok) throw new Error(runtimeInstanceHint(result, "Runtime instance operation was rejected."));
  return result;
}
function runtimeInstanceCatalog(value: unknown): RuntimeInstanceCatalog {
  if (
    !runtimeInstanceRecord(value) ||
    value.schema !== "command-receipt/v2" ||
    value.ok !== true ||
    !Array.isArray(value.instances) ||
    !Array.isArray(value.installations)
  )
    throw new Error(runtimeInstanceHint(value, "Runtime instance list returned an invalid receipt."));
  return {
    instances: value.instances as RuntimeInstanceSummary[],
    installations: value.installations as RuntimeInstallationRow[],
  };
}
function runtimeInstanceSummary(value: unknown): RuntimeInstanceSummary {
  if (
    !runtimeInstanceRecord(value) ||
    typeof value.instanceId !== "string" ||
    !runtimeInstanceRecord(value.authReadiness)
  )
    throw new Error("Runtime instance authentication probe returned an invalid instance.");
  return value as unknown as RuntimeInstanceSummary;
}
function runtimeInstanceTerminal(value: unknown): TerminalControlReceipt {
  if (
    !runtimeInstanceRecord(value) ||
    value.schema !== "terminal-control-receipt/v1" ||
    value.outcome !== "applied" ||
    typeof value.sessionId !== "string"
  )
    throw new Error(runtimeInstanceHint(value, "Provider-native authentication terminal did not start."));
  return value as TerminalControlReceipt;
}
function runtimeInstanceHint(value: unknown, fallback: string): string {
  return runtimeInstanceRecord(value) && typeof value.rejectionExplanation === "string"
    ? value.rejectionExplanation
    : fallback;
}
function runtimeInstanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
