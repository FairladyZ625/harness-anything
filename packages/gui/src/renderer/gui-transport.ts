import type { DaemonRpcMethodMap, DaemonRpcResult } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { FirstRunApi } from "../api/first-run-contract.ts";
import type { ArtifactOpenApi } from "../api/artifact-open-contract.ts";
import type { ConnectionAdminApi, RepoAdminApi } from "../api/connection-admin-contract.ts";
import { loadBrowserGuiTransport } from "../browser/browser-gui-transport.ts";

type GuiMethod = keyof DaemonRpcMethodMap;
type GuiBridge = {
  readonly [method: string]: unknown;
  readonly request?: (method: string, payload: unknown) => Promise<unknown>;
  readonly capabilities?: Readonly<Record<string, { readonly status: string; readonly reason?: string }>>;
  readonly firstRun?: FirstRunApi;
  readonly artifacts?: ArtifactOpenApi;
  readonly connections?: ConnectionAdminApi;
  readonly repoAdmin?: RepoAdminApi;
};
declare global {
  interface Window {
    readonly harness?: GuiBridge;
  }
}

export interface GuiTransport {
  request<Method extends GuiMethod>(
    method: Method,
    params: DaemonRpcMethodMap[Method]["params"],
    electronMethod?: string,
  ): Promise<DaemonRpcResult<Method>>;
  capabilities(): Readonly<Record<string, { readonly status: string; readonly reason?: string }>>;
}
export function createElectronGuiTransport(bridge: GuiBridge): GuiTransport {
  return {
    request: (method, params, electronMethod) => {
      if (!electronMethod) throw new Error(`Electron bridge method is unavailable for ${method}`);
      const payload = flattenParams(params);
      if (Object.hasOwn(bridge, "request") && bridge.request)
        return bridge.request(electronMethod, payload) as Promise<DaemonRpcResult<typeof method>>;
      const legacy = bridge[electronMethod];
      if (typeof legacy !== "function") throw new Error(`Harness bridge is unavailable for ${method}.`);
      return legacy(payload) as Promise<DaemonRpcResult<typeof method>>;
    },
    capabilities: () => bridge.capabilities ?? {},
  };
}
let transport: GuiTransport | undefined;
export function guiTransport(): GuiTransport {
  if (transport) return transport;
  if (window.harness) return createElectronGuiTransport(window.harness);
  return (transport = loadBrowserGuiTransport());
}
export function guiHostBridge(): GuiBridge | undefined {
  return window.harness;
}
export function resetGuiTransportForTest(): void {
  transport = undefined;
}
function flattenParams(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const params = value as Record<string, unknown>;
  if (!params.repo || typeof params.repo !== "object" || Array.isArray(params.repo)) return params.payload ?? params;
  return {
    repoId: (params.repo as Record<string, unknown>).repoId,
    ...(params.payload && typeof params.payload === "object" ? params.payload : {}),
  };
}
