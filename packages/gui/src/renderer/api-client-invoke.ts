import type { DaemonRpcMethodMap, DaemonRpcResult } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { guiTransport } from "./gui-transport.ts";

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

export async function invoke<Method extends keyof DaemonRpcMethodMap>(
  method: Method & GuiRpcMethod,
  params: GuiBridgeParams<Method & GuiRpcMethod>,
  bridgeMethod: GuiBridgeMethodFor<Method & GuiRpcMethod>,
): Promise<DaemonRpcResult<Method>> {
  if (!("repoId" in params))
    return guiTransport().request(method, params as DaemonRpcMethodMap[Method]["params"], bridgeMethod);
  const { repoId, ...payload } = params as { readonly repoId: string; readonly [key: string]: unknown };
  return guiTransport().request(
    method,
    {
      repo: { repoId },
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    } as DaemonRpcMethodMap[Method]["params"],
    bridgeMethod,
  );
}
