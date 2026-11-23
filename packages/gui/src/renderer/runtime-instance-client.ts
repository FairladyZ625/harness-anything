import type * as DomainStatus from "../api/renderer-dto.ts";
import {
  validRuntimeSubscriptionQuota,
  type RuntimeInstanceSummary,
  type TerminalControlReceipt,
} from "@harness-anything/daemon/protocol";
import { invoke } from "./api-client-invoke.ts";
import { isRendererRecord, rendererErrorHint } from "./result-validation.ts";
export interface RuntimeInstallationRow {
  readonly installationId: string;
  readonly kindId: string;
  readonly version: string;
  readonly observedAt: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
}
export interface RuntimeInstanceCatalog {
  /** Node that served this machine-local catalog. */
  readonly nodeId: string;
  readonly instances: readonly RuntimeInstanceSummary[];
  readonly installations: readonly RuntimeInstallationRow[];
  /** Verified kinds on the connected daemon, independent of the renderer platform. */
  readonly subscriptionIsolationKinds?: readonly string[];
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
  readonly mcpPolicy?: "disabled" | "inherit";
  readonly isolationState?: DomainStatus.RuntimeIsolationState;
  readonly credentialSource?: "operator" | "instance";
  readonly tier?: number;
  readonly fast?: boolean;
  readonly webSearch?: "disabled" | "cached" | "live";
  readonly clearFreeze?: boolean;
};
type RuntimeInstanceCreateCommon = {
  readonly enabled?: boolean;
  readonly instanceId: string;
  readonly name: string;
  readonly installationId: string;
  readonly providerId: string;
  readonly models: readonly string[];
  readonly defaultModel?: string;
  readonly permissionMode?: "bypass" | "workspace-write" | "read-only";
  readonly mcpPolicy?: "disabled" | "inherit";
  readonly isolationState?: DomainStatus.RuntimeIsolationState;
  readonly credentialSource?: "operator" | "instance";
  readonly tier?: number;
};
// Keys travel once through the trusted bridge to the selected daemon's native vault.
export type RuntimeInstanceCreateInput = RuntimeInstanceCreateCommon & {
  readonly kindId: string;
  readonly [field: string]: unknown;
} & ({ readonly authMode: "subscription" } | { readonly authMode: "api-key"; readonly apiKey: string });
export const runtimeInstanceClient = {
  list: async (repoId?: string): Promise<RuntimeInstanceCatalog> =>
    runtimeInstanceCatalog(await invoke("daemon.runtimeInstance.list", { all: true, ...scope(repoId) })),
  show: (instanceId: string, repoId?: string) =>
    runtimeInstanceShowReceipt(
      runtimeInstanceReceipt(invoke("daemon.runtimeInstance.show", { instanceId, ...scope(repoId) })),
    ),
  create: (input: RuntimeInstanceCreateInput, repoId?: string) =>
    runtimeInstanceReceipt(invoke("daemon.runtimeInstance.create", { ...input, ...scope(repoId) })),
  update: (input: RuntimeInstanceUpdateInput, repoId?: string) =>
    runtimeInstanceReceipt(invoke("daemon.runtimeInstance.update", { ...input, ...scope(repoId) })),
  setEnabled: (instanceId: string, enabled: boolean, repoId?: string) =>
    runtimeInstanceClient.update({ instanceId, enabled }, repoId),
  delete: (instanceId: string, repoId?: string) =>
    runtimeInstanceReceipt(invoke("daemon.runtimeInstance.delete", { instanceId, ...scope(repoId) })),
  probe: async (instanceId: string, repoId?: string): Promise<RuntimeInstanceSummary> =>
    runtimeInstanceSummary(
      (
        await runtimeInstanceReceipt(
          invoke("daemon.runtimeInstance.show", { instanceId, probe: true, ...scope(repoId) }),
        )
      ).instance,
    ),
  login: async (repoId: string, instanceId: string): Promise<TerminalControlReceipt> =>
    runtimeInstanceTerminal(
      await invoke("repo.runtimeInstance.auth.login", runtimeInstanceAuthPayload(repoId, instanceId, "login")),
    ),
  logout: async (repoId: string, instanceId: string): Promise<TerminalControlReceipt> =>
    runtimeInstanceTerminal(
      await invoke("repo.runtimeInstance.auth.logout", runtimeInstanceAuthPayload(repoId, instanceId, "logout")),
    ),
};
function runtimeInstanceAuthPayload(repoId: string, instanceId: string, operation: "login" | "logout") {
  return { repoId, instanceId, idempotencyKey: `runtime-auth-${operation}-${instanceId}-${crypto.randomUUID()}` };
}
const scope = (repoId?: string) => (repoId === undefined ? {} : { repoId });
async function runtimeInstanceReceipt(value: Promise<unknown>): Promise<Record<string, unknown>> {
  const result = await value;
  if (!isRendererRecord(result) || result.schema !== "command-receipt/v2" || typeof result.ok !== "boolean")
    throw new Error(rendererErrorHint(result, "Runtime instance operation returned an invalid receipt."));
  if (!result.ok) throw new Error(rendererErrorHint(result, "Runtime instance operation was rejected."));
  return result;
}
async function runtimeInstanceShowReceipt(value: Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const receipt = await value;
  return { ...receipt, instance: runtimeInstanceSummary(receipt.instance) };
}
function runtimeInstanceCatalog(value: unknown): RuntimeInstanceCatalog {
  if (
    !isRendererRecord(value) ||
    value.schema !== "command-receipt/v2" ||
    value.ok !== true ||
    typeof value.nodeId !== "string" ||
    !Array.isArray(value.instances) ||
    !Array.isArray(value.installations)
  )
    throw new Error(rendererErrorHint(value, "Runtime instance list returned an invalid receipt."));
  return {
    nodeId: value.nodeId,
    instances: value.instances.map(runtimeInstanceSummary),
    installations: value.installations as RuntimeInstallationRow[],
    subscriptionIsolationKinds: (value.subscriptionIsolationKinds as readonly string[] | undefined) ?? [],
  };
}
function runtimeInstanceSummary(value: unknown): RuntimeInstanceSummary {
  if (!isRendererRecord(value) || typeof value.instanceId !== "string" || !isRendererRecord(value.authReadiness))
    throw new Error("Runtime instance authentication probe returned an invalid instance.");
  if (value.quota !== undefined && !validRuntimeSubscriptionQuota(value.quota))
    throw new Error("Runtime instance returned an invalid subscription quota snapshot.");
  return value as unknown as RuntimeInstanceSummary;
}
function runtimeInstanceTerminal(value: unknown): TerminalControlReceipt {
  if (
    !isRendererRecord(value) ||
    value.schema !== "terminal-control-receipt/v1" ||
    value.outcome !== "applied" ||
    typeof value.sessionId !== "string"
  )
    throw new Error(rendererErrorHint(value, "Provider-native authentication terminal did not start."));
  return value as TerminalControlReceipt;
}
