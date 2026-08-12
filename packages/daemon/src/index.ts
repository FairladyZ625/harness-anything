export {
  JsonRpcLineClient, daemonIdFromEnv, daemonUserRoot, localUserDaemonEndpoint, requestDaemonJsonRpcAt,
  requestLocalDaemonJsonRpc, requestLocalDaemonJsonRpcForTarget, resolveLocalDaemonTarget,
  type LocalDaemonJsonRpcOptions, type LocalDaemonTarget
} from "./client/local-json-rpc-client.ts";
export { openDaemonHost, type DaemonHost } from "./daemon-host.ts";
export { loadPeopleRoster, peopleRosterFromDocument } from "./identity/people-roster.ts";
export { makeTransportDerivedIdentityProvider, type TransportDerivedIdentityProviderOptions } from "./identity/transport-derived-provider.ts";
export type { AuthenticatedActor, CredentialRef, IdentityProvider, PeopleRoster, PersonProfile, RolePolicy } from "./identity/types.ts";
export { createJsonRpcProtocolServer, type JsonRpcProtocolServer } from "./protocol/json-rpc-server.ts";
export { currentDaemonProtocolVersion, jsonRpcMethodContracts } from "./protocol/method-registry.ts";
export type { JsonObject, JsonRpcRequest, JsonRpcResponse, JsonValue } from "./protocol/json-rpc-types.ts";
export { openRepoCell, type RepoCell, type RepoCellBinding, type RepoCellStatus, type RepoTaskAction } from "./repo-cell.ts";
export { daemonPidPath, readDaemonPid, startDaemon, type RunningDaemon } from "./runtime.ts";
export type { DaemonAuthenticationContext, DaemonTransportKind } from "./transport/auth-context.ts";
export { createJsonLineFrameReader, encodeJsonLineFrame, isJsonRpcRequestLike } from "./transport/frame-codec.ts";
export { serveJsonRpcStream, type DaemonTransportConnection } from "./transport/json-rpc-stream.ts";
export { createUnixSocketTransportServer, defaultUnixSocketPath } from "./transport/unix-socket.ts";
