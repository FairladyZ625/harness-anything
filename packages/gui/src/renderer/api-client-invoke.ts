import type { GuiBridgeMethod } from "../api/renderer-dto.ts";
import type { FirstRunApi } from "../api/first-run-contract.ts";
import type { DaemonRpcMethodMap, DaemonRpcResult } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

type GuiInvokeFacet =
  (typeof import("../../../daemon/src/protocol/daemon-protocol.contract.ts").daemonGuiInvokeFacets)[number];
type GuiRpcMethod = GuiInvokeFacet["method"] & keyof DaemonRpcMethodMap;
type GuiBridgeMethodFor<Method extends GuiRpcMethod> = Extract<
  GuiInvokeFacet,
  { readonly method: Method }
>["guiBridgeMethod"];
type GuiInput<Value> =
  Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<GuiInput<Item>>
    : Value extends object
      ? string extends keyof Value
        ? object
        : { readonly [Key in keyof Value]: GuiInput<Value[Key]> }
      : Value;
type GuiBridgeParams<Method extends GuiRpcMethod> = DaemonRpcMethodMap[Method]["params"] extends {
  readonly repo: { readonly repoId: infer RepoId };
  readonly payload: infer Payload extends object;
}
  ? { readonly repoId: RepoId } & GuiInput<Payload>
  : DaemonRpcMethodMap[Method]["params"] extends {
        readonly repo: { readonly repoId: infer RepoId };
      }
    ? { readonly repoId: RepoId }
    : DaemonRpcMethodMap[Method]["params"] extends { readonly payload: infer Payload extends object }
      ? GuiInput<Payload>
      : GuiInput<DaemonRpcMethodMap[Method]["params"]>;

type HarnessBridge = Record<GuiBridgeMethod, (payload?: object | null) => Promise<unknown>> & {
  readonly capabilities?: unknown;
  readonly firstRun?: FirstRunApi;
};

declare global {
  interface Window {
    readonly harness?: HarnessBridge;
  }
}

export async function invoke<Method extends keyof DaemonRpcMethodMap>(
  method: Method & GuiRpcMethod,
  params: GuiBridgeParams<Method & GuiRpcMethod>,
  bridgeMethod: GuiBridgeMethodFor<Method & GuiRpcMethod>,
): Promise<DaemonRpcResult<Method>> {
  const bridge = window.harness;
  if (!bridge || typeof bridge[bridgeMethod] !== "function")
    throw new Error(`Harness preload bridge is unavailable for ${method} (${bridgeMethod}).`);
  return bridge[bridgeMethod](params) as Promise<DaemonRpcResult<Method>>;
}
