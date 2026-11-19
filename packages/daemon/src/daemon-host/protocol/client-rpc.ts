import { interactiveRpcMethods, daemonStreamFacetByMethod } from "./daemon-protocol-action-routes.ts";
import type { DaemonRpcMethodMap } from "./daemon-protocol.contract.ts";
import { DaemonProtocolContractError, isJsonObject } from "./json-rpc-types.ts";

export type InteractiveRpcDescriptor = (typeof interactiveRpcMethods)[number];
type InteractiveRpcMethod = InteractiveRpcDescriptor["method"];
const descriptors: ReadonlyMap<string, InteractiveRpcDescriptor> = new Map(
  interactiveRpcMethods.map((entry) => [entry.method, entry]),
);

export function interactiveRpcDescriptor(method: string): InteractiveRpcDescriptor | undefined {
  return descriptors.get(method);
}

export function streamRpcDescriptor(method: string) {
  return daemonStreamFacetByMethod.get(method);
}

const socketAbsent = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EACCES"]);
export function daemonClientFailureCode(error: unknown): string {
  const code = isJsonObject(error) && typeof error.code === "string" ? error.code : null;
  if ((error instanceof Error && error.message === "daemon_unavailable") || (code && socketAbsent.has(code)))
    return "daemon_unavailable";
  return code ?? "daemon_request_failed";
}

/** Renderer views name the canonical RPC and the repository scope once. */
export function scopedRpcParams<Method extends InteractiveRpcMethod>(
  method: Method,
  input: object,
): DaemonRpcMethodMap[Method]["params"] {
  const descriptor = interactiveRpcDescriptor(method);
  if (!descriptor) throw new DaemonProtocolContractError("method_not_allowed", `Unsupported RPC method: ${method}`);
  const fields = descriptor.params.fields,
    { repoId, ...rest } = input as { readonly repoId?: string },
    scoped = Object.hasOwn(fields, "repo"),
    payload = scoped ? rest : input;
  return {
    ...(scoped && (descriptor.requiresRepo || repoId !== undefined) ? { repo: { repoId } } : {}),
    ...(Object.hasOwn(fields, "payload") ? { payload } : payload),
  } as DaemonRpcMethodMap[Method]["params"];
}
