import {
  daemonGuiInvokeFacets,
  type DaemonRpcMethodMap,
  type DaemonRpcResult,
} from "@harness-anything/daemon/protocol";
import { guiTransport } from "./gui-transport.ts";

type GuiInvokeFacet = (typeof daemonGuiInvokeFacets)[number];
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

// The envelope follows the protocol facet declaration, not the caller's field count: the daemon
// validates params against these same shapes and rejects a declared-but-absent `payload` key
// ("params.payload must be an object"), so a declared payload is always sent — as {} when the
// caller passed no fields — and a payload-only method's fields are wrapped, never flattened.
const invokeFacetFields = new Map(
  daemonGuiInvokeFacets.map((facet) => [facet.method, new Set(Object.keys(facet.params.fields))]),
);

export async function invoke<Method extends keyof DaemonRpcMethodMap>(
  method: Method & GuiRpcMethod,
  params: GuiBridgeParams<Method & GuiRpcMethod>,
  bridgeMethod: GuiBridgeMethodFor<Method & GuiRpcMethod>,
): Promise<DaemonRpcResult<Method>> {
  const fields = invokeFacetFields.get(method);
  if (!fields) throw new Error(`RPC method is not a GUI invoke facet: ${String(method)}.`);
  const { repoId, ...payload } = params as { readonly repoId?: string; readonly [key: string]: unknown };
  const wireParams = (
    fields.has("repo") && fields.has("payload")
      ? { repo: { repoId }, payload }
      : fields.has("repo")
        ? { repo: { repoId } }
        : fields.has("payload")
          ? { payload: params }
          : params
  ) as DaemonRpcMethodMap[Method]["params"];
  return guiTransport().request(method, wireParams, bridgeMethod);
}
