import type { RuntimeInstanceSummary } from "../../../daemon/src/agent-runtime-instances.ts";
import type { TerminalControlReceipt } from "../../../daemon/src/gui-s3-control.ts";
export interface RuntimeInstallationRow {
  readonly installationId: string;
  readonly kindId: "claude" | "codex" | "agy";
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
  readonly name?: string;
  readonly installationId?: string;
  readonly models?: readonly string[];
  readonly defaultModel?: string;
  /** Non-empty replaces the endpoint (create-time validation applies); empty clears back
   * to the official endpoint; omitted leaves it untouched. claude/codex API mode only. */
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly permissionMode?: "bypass" | "workspace-write" | "read-only";
  readonly isolationState?: "enforced" | "operator-environment";
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
// api-key creation carries the user-typed key exactly once, main-process-bound:
// main stores it in the native vault and the daemon sees only an opaque reference.
export type RuntimeInstanceCreateInput = RuntimeInstanceCreateCommon &
  (
    | { readonly kindId: "claude"; readonly claude: { readonly baseUrl?: string } }
    | {
        readonly kindId: "codex";
        readonly codex: {
          readonly reasoningEffort?: string;
          readonly baseUrl?: string;
          readonly wireApi?: string;
          readonly requiresOpenAiAuth?: boolean;
          readonly httpHeaders?: Readonly<Record<string, string>>;
        };
      }
    | {
        readonly kindId: "agy";
        readonly agy: { readonly effort?: "low" | "medium" | "high" };
        readonly authMode: "subscription";
      }
  ) &
  ({ readonly authMode: "subscription" } | { readonly authMode: "api-key"; readonly apiKey: string });
type Bridge = {
  readonly listRuntimeInstances: (payload: { readonly all: true }) => Promise<unknown>;
  readonly showRuntimeInstance: (payload: {
    readonly instanceId: string;
    readonly probe?: boolean;
  }) => Promise<unknown>;
  readonly createRuntimeInstance: (payload: RuntimeInstanceCreateInput) => Promise<unknown>;
  readonly updateRuntimeInstance: (payload: RuntimeInstanceUpdateInput) => Promise<unknown>;
  readonly deleteRuntimeInstance: (payload: { readonly instanceId: string }) => Promise<unknown>;
  readonly signInRuntimeInstance: (payload: AuthInput) => Promise<unknown>;
  readonly signOutRuntimeInstance: (payload: AuthInput) => Promise<unknown>;
};
type AuthInput = { readonly repoId: string; readonly instanceId: string; readonly idempotencyKey: string };
const bridge = (): Bridge => {
  const value = window.harness as unknown as Partial<Bridge> | undefined,
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
  list: async (): Promise<RuntimeInstanceCatalog> =>
    runtimeInstanceCatalog(await bridge().listRuntimeInstances({ all: true })),
  show: (instanceId: string) => runtimeInstanceReceipt(bridge().showRuntimeInstance({ instanceId })),
  create: (input: RuntimeInstanceCreateInput) => runtimeInstanceReceipt(bridge().createRuntimeInstance(input)),
  update: (input: RuntimeInstanceUpdateInput) => runtimeInstanceReceipt(bridge().updateRuntimeInstance(input)),
  setEnabled: (instanceId: string, enabled: boolean) => runtimeInstanceClient.update({ instanceId, enabled }),
  delete: (instanceId: string) => runtimeInstanceReceipt(bridge().deleteRuntimeInstance({ instanceId })),
  probe: async (instanceId: string): Promise<RuntimeInstanceSummary> =>
    runtimeInstanceSummary(
      (await runtimeInstanceReceipt(bridge().showRuntimeInstance({ instanceId, probe: true }))).instance,
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
  return runtimeInstanceRecord(value) && runtimeInstanceRecord(value.error) && typeof value.error.hint === "string"
    ? value.error.hint
    : fallback;
}
function runtimeInstanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
