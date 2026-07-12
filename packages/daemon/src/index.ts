export {
  daemonIdForRoot,
  daemonIdForUserRoot,
  daemonIdFromEnv,
  daemonUserRoot,
  defaultDaemonAutostartTimeoutMs,
  defaultDaemonIdleExitMs,
  JsonRpcLineClient,
  localDaemonSocketPath,
  localUserDaemonEndpoint,
  localUserDaemonSocketPath,
  requestLocalDaemonJsonRpc,
  requestLocalDaemonJsonRpcForTarget,
  resolveLocalDaemonTarget,
  spawnLocalDaemon,
  type LocalDaemonAutostartOptions,
  type LocalDaemonJsonRpcOptions,
  type LocalDaemonTarget
} from "./client/local-json-rpc-client.ts";
export {
  actorGitCommitAuthor,
  actorStamp,
  actorStampJson,
  credentialKey,
  type ActorStamp,
  type AuthenticatedActor,
  type CredentialKind,
  type CredentialRef,
  type DaemonCommandClass,
  type GitCommitAuthor,
  type IdentityProvider,
  type IdentityProviderFailure,
  type IdentityProviderFailureCode,
  type IdentityProviderResolveInput,
  type IdentityProviderSuccess,
  type PeopleRoster,
  type PersonId,
  type PersonProfile,
  type RoleId,
  type RolePolicy
} from "./identity/types.ts";
export {
  loadPeopleRoster,
  peopleRosterFromDocument
} from "./identity/people-roster.ts";
export {
  makeTransportDerivedIdentityProvider,
  type TransportDerivedIdentityProviderOptions
} from "./identity/transport-derived-provider.ts";
export {
  authorizeActorForMethod,
  type AuthorizationFailure,
  type AuthorizationSuccess
} from "./identity/authorization.ts";
export {
  currentDaemonProtocolVersion,
  commandClassForApiRoute,
  commandClassForCliCommandPayload,
  commandClassForJsonRpcRequest,
  deriveJsonRpcServiceMethodContracts,
  jsonRpcMethodContracts,
  jsonRpcServiceMethodContracts,
  repoCommandRunClassifiedActionKinds,
  type DaemonCommandClass as JsonRpcDaemonCommandClass,
  type JsonRpcMethodContract,
  type JsonRpcMethodMode
} from "./protocol/method-registry.ts";
export {
  createJsonRpcProtocolServer,
  type DaemonRepoAvailabilityFailure,
  type DaemonRepoNamespace,
  type DaemonServiceHost,
  type JsonRpcProtocolServer,
  type JsonRpcServerOptions
} from "./protocol/json-rpc-server.ts";
export type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonObject,
  JsonValue,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse
} from "./protocol/json-rpc-types.ts";
export {
  type AttachTokenSubject,
  type DaemonAuthenticationContext,
  type DaemonTransportKind,
  type NamedPipeClientContext,
  type SshExecUserContext,
  type SshForcedCommandContext,
  type SshTunnelTokenContext,
  type UnixSocketOwnerBoundary
} from "./transport/auth-context.ts";
export {
  authenticateSshForcedCommandFrame,
  sshForcedCommandBootstrapFrame,
  type SshForcedCommandBootstrapFrame,
  type SshForcedCommandBootstrapInput
} from "./transport/ssh-forced-command.ts";
export {
  createJsonLineFrameReader,
  encodeJsonLineFrame,
  isJsonRpcRequestLike,
  type JsonLineFrameBatch,
  type JsonLineFrameReader
} from "./transport/frame-codec.ts";
export {
  serveJsonRpcStream,
  type DaemonTransportConnection,
  type JsonRpcStreamOptions,
  type TransportAuthenticationFailure,
  type TransportAuthenticationResult,
  type TransportAuthenticationSuccess
} from "./transport/json-rpc-stream.ts";
export {
  createUnixSocketTransportServer,
  defaultUnixSocketPath,
  ensurePrivateUnixSocketDirectory,
  unixSocketDirectory,
  type UnixSocketPathOptions,
  type UnixSocketTransportOptions,
  type UnixSocketTransportServer
} from "./transport/unix-socket.ts";
export {
  createNamedPipeTransportServer,
  defaultNamedPipePath,
  windowsNamedPipeIntegrationEntry,
  type NamedPipeTransportOptions,
  type NamedPipeTransportServer,
  type WindowsNamedPipeIntegrationEntry
} from "./transport/named-pipe.ts";
export { serveSshExecBridge, type SshExecBridgeOptions } from "./transport/ssh-exec.ts";
export {
  attachTokenBootstrapFrame,
  createInMemoryAttachTokenStore,
  serveSshTunnelTokenStream,
  type AttachTokenFailure,
  type AttachTokenFrame,
  type AttachTokenMetadata,
  type AttachTokenStore,
  type ConsumeAttachTokenInput,
  type IssueAttachTokenInput,
  type IssuedAttachToken,
  type SshTunnelTokenStreamOptions
} from "./transport/ssh-tunnel-token.ts";
