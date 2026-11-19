import type { ExternalUrlApi } from "../api/external-url-contract.ts";
import type { ProjectDirectoryApi } from "../api/project-directory-contract.ts";
import type { ProjectWindowApi } from "../api/project-window-contract.ts";
import type { AppCommandApi } from "../api/app-command-contract.ts";
import type { DaemonRpcMethodMap, DaemonRpcResult, DaemonStreamMethod } from "@harness-anything/daemon/protocol";
import type { FirstRunApi } from "../api/first-run-contract.ts";
import type { ArtifactOpenApi } from "../api/artifact-open-contract.ts";
import type { ConnectionAdminApi, RepoAdminApi } from "../api/connection-admin-contract.ts";
import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import type { AccessAdminApi } from "@harness-anything/authorization-gui/access-admin-contract";
import type { FleetAdminApi } from "../api/fleet-admin-contract.ts";
import type { AuthorizationUiComponents } from "@harness-anything/authorization-gui/ui-component-contract";
import type { CenterSettingsApi } from "../api/center-settings-contract.ts";
import type { LocalDocApi } from "../api/local-doc-contract.ts";
import type { UpdateApi } from "../api/update-contract.ts";
import { loadBrowserGuiTransport } from "../browser/browser-gui-transport.ts";

type GuiMethod = keyof DaemonRpcMethodMap;
type GuiBridge = {
  readonly request?: (method: string, params: unknown) => Promise<unknown>;
  readonly subscribe?: (
    method: DaemonStreamMethod,
    params: unknown,
    onValue: (value: unknown) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  readonly capabilities?: Readonly<Record<string, { readonly status: string; readonly reason?: string }>>;
  readonly firstRun?: FirstRunApi;
  readonly artifacts?: ArtifactOpenApi;
  readonly externalUrl?: ExternalUrlApi;
  readonly connections?: ConnectionAdminApi;
  readonly repoAdmin?: RepoAdminApi;
  readonly projects?: ProjectDirectoryApi;
  readonly windows?: ProjectWindowApi;
  readonly appCommand?: AppCommandApi;
  readonly auth?: OidcAuthApi;
  readonly access?: AccessAdminApi;
  readonly fleetAdmin?: FleetAdminApi;
  readonly authorizationUi?: AuthorizationUiComponents;
  readonly centerSettings?: CenterSettingsApi;
  readonly localDoc?: LocalDocApi;
  readonly updates?: UpdateApi;
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
  ): Promise<DaemonRpcResult<Method>>;
  subscribe<Method extends DaemonStreamMethod>(
    method: Method,
    params: DaemonRpcMethodMap[Method]["params"],
    onValue: (value: unknown) => void,
    onError: (error: unknown) => void,
  ): () => void;
  capabilities(): Readonly<Record<string, { readonly status: string; readonly reason?: string }>>;
}
export function createElectronGuiTransport(bridge: GuiBridge): GuiTransport {
  return {
    request: (method, params) => {
      if (!bridge.request) throw new Error(`Harness RPC is unavailable for ${method}.`);
      return bridge.request(method, params) as Promise<DaemonRpcResult<typeof method>>;
    },
    subscribe: (method, params, onValue, onError) => {
      if (!bridge.subscribe) throw new Error(`Harness streaming is unavailable for ${method}.`);
      const controller = new AbortController(),
        signal = controller.signal;
      const stop = bridge.subscribe(
        method,
        params,
        (value) => {
          if (signal.aborted) return;
          if (value && typeof value === "object" && "code" in value && value.code === "daemon_stream_lost") {
            onError(Object.assign(new Error(String("hint" in value ? value.hint : value.code)), { code: value.code }));
          } else onValue(value);
        },
        onError,
      );
      signal.addEventListener("abort", stop, { once: true });
      return () => controller.abort();
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
