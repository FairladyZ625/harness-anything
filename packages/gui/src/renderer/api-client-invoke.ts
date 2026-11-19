import {
  daemonReadRoutes,
  scopedRpcParams,
  type InteractiveRpcDescriptor,
  type DaemonRpcMethodMap,
  type DaemonRpcResult,
} from "@harness-anything/daemon/protocol";
import { guiTransport } from "./gui-transport.ts";
import { repositoryReadFailure } from "./repository-read-frame.ts";

type GuiRpcMethod = InteractiveRpcDescriptor["method"] & keyof DaemonRpcMethodMap;
type GuiInput<Value> =
  Value extends ReadonlyArray<infer Item>
    ? ReadonlyArray<GuiInput<Item>>
    : Value extends object
      ? string extends keyof Value
        ? object
        : { readonly [Key in keyof Value]: GuiInput<Value[Key]> }
      : Value;
type InputRepo<Params> = Params extends { readonly repo: { readonly repoId: infer RepoId } }
  ? { readonly repoId: RepoId }
  : "repo" extends keyof Params
    ? { readonly repoId?: string }
    : object;
type ClientInput<Params> = InputRepo<Params> &
  (Params extends { readonly payload: infer Payload extends object }
    ? GuiInput<Payload>
    : Omit<GuiInput<Params>, "repo">);

const readMethods = new Set<string>(daemonReadRoutes.map(({ method }) => method));

export async function invoke<Method extends keyof DaemonRpcMethodMap>(
  method: Method & GuiRpcMethod,
  params: ClientInput<DaemonRpcMethodMap[Method & GuiRpcMethod]["params"]>,
): Promise<DaemonRpcResult<Method>> {
  const result = await guiTransport().request(method, scopedRpcParams(method, params));
  const failure = readMethods.has(method) ? repositoryReadFailure(result) : null;
  if (failure) {
    // The read is authoritative for its operation: tell the identity surfaces to re-read the
    // session port. They remain the only account-state authority; this is a wake-up, not a state.
    if ((failure as Error & { readonly code?: string }).code === "authentication_required")
      window.dispatchEvent(new Event("harness-auth-changed"));
    throw failure;
  }
  return result;
}
