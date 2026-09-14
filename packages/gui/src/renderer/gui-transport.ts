import type { DaemonRpcMethodMap, DaemonRpcResult } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { FirstRunApi } from "../api/first-run-contract.ts";
import type { ArtifactOpenApi } from "../api/artifact-open-contract.ts";
import type { ConnectionAdminApi, RepoAdminApi } from "../api/connection-admin-contract.ts";

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
export function createBrowserGuiTransport(token: string): GuiTransport {
  const unavailable = { status: "unavailable", reason: "Available in the desktop app only." } as const;
  return {
    async request(method, params) {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      if (!response.ok) throw new Error(`Browser transport rejected ${method} (${response.status}).`);
      return (await response.json()) as DaemonRpcResult<typeof method>;
    },
    capabilities: () => ({ stream: unavailable, terminal: unavailable, nativeFiles: unavailable, writes: unavailable }),
  };
}
let transport: GuiTransport | undefined;
export function guiTransport(): GuiTransport {
  if (transport) return transport;
  if (window.harness) return createElectronGuiTransport(window.harness);
  const token = new URLSearchParams(window.location.hash.slice(1)).get("access_token");
  if (!token) throw new Error("GUI transport credentials are unavailable.");
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return (transport = createBrowserGuiTransport(token));
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
