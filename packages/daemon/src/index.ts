export {
  JsonRpcLineClient,
  daemonIdFromEnv,
  daemonUserRoot,
  localUserDaemonEndpoint,
  requestDaemonJsonRpcAt,
  requestLocalDaemonJsonRpc,
  requestLocalDaemonJsonRpcForTarget,
  resolveLocalDaemonTarget,
  type LocalDaemonJsonRpcOptions,
  type LocalDaemonTarget,
} from "./client/local-json-rpc-client.ts";
export { openDaemonHost, type DaemonHost } from "./daemon-host.ts";
export {
  listenFleetTls,
  type FleetAssignmentRecord,
  type FleetCenterOptions,
  type FleetTlsCenter,
} from "./fleet/center.ts";
export {
  FleetRemoteError,
  openFleetEdgeView,
  runFleetReplicaPullClient,
  runFleetWriteClient,
  type FleetReplicaPullClientOptions,
  type FleetReplicaPullClientResult,
  type FleetWriteClientOptions,
  type FleetWriteClientResult,
  type FleetEdgeView,
} from "./fleet/edge.ts";
export { parseFleetFrame, serializeFleetFrame, type FleetFrameV1 } from "./fleet/contract.ts";
export { loadPeopleRoster, peopleRosterFromDocument } from "./identity/people-roster.ts";
export {
  makeTransportDerivedIdentityProvider,
  type TransportDerivedIdentityProviderOptions,
} from "./identity/transport-derived-provider.ts";
export type {
  AuthenticatedActor,
  CredentialRef,
  IdentityProvider,
  PeopleRoster,
  PersonProfile,
  RolePolicy,
} from "./identity/types.ts";
export { createJsonRpcProtocolServer, type JsonRpcProtocolServer } from "./protocol/json-rpc-server.ts";
export { jsonRpcMethodContracts } from "./protocol/daemon-protocol.contract.ts";
export type {
  ObserveTailCursor,
  ObserveTailKind,
  ObserveTailPayload,
  ObserveTailResult,
} from "./protocol/daemon-protocol.contract.ts";
export { currentDaemonProtocolVersion } from "./protocol/version.ts";
export type { JsonObject, JsonRpcRequest, JsonRpcResponse, JsonValue } from "./protocol/json-rpc-types.ts";
export {
  openRepoCell,
  type RepoCell,
  type RepoCellBinding,
  type RepoCellStatus,
  type RepoTaskAction,
} from "./repo-cell.ts";
export {
  DAEMON_REQUEST_LOG_SCHEMA,
  daemonRequestLogPath,
  openDaemonRequestLog,
  type DaemonRequestLog,
  type DaemonRequestLogEntry,
  type DaemonRequestLogRecord,
} from "./request-log.ts";
export {
  DAEMON_CONN_LOG_SCHEMA,
  daemonConnLogFileStem,
  openDaemonConnLog,
  type DaemonConnLog,
  type DaemonConnLogOptions,
  type DaemonTrafficLogEntry,
} from "./conn-log.ts";
export { daemonPidPath, readDaemonPid, startDaemon, type RunningDaemon } from "./runtime.ts";
export type { DaemonAuthenticationContext, DaemonTransportKind } from "./transport/auth-context.ts";
export { createJsonLineFrameReader, encodeJsonLineFrame, isJsonRpcRequestLike } from "./transport/frame-codec.ts";
export { serveJsonRpcStream, type DaemonTransportConnection } from "./transport/json-rpc-stream.ts";
export { createUnixSocketTransportServer, defaultUnixSocketPath } from "./transport/unix-socket.ts";
