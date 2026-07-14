// TW-04 platform
export * from "./platform/index.ts";
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
export * from "./authority/index.ts";
// TW-06 fence
export * from "./fence/index.ts";
export * from "./broker/index.ts";
export * from "./resolver/index.ts";
export {
  actorGitCommitAuthor,
  actorStamp,
  actorStampJson,
  composeIdentityProvider,
  credentialKey,
  type ActorStamp,
  type AuthenticationProvider,
  type AuthenticatedActor,
  type AuthorizationProvider,
  type CredentialKind,
  type CredentialRef,
  type DaemonCommandClass,
  type GitCommitAuthor,
  type IdentityAdminSnapshot,
  type IdentityAuthenticationResult,
  type IdentityAuthenticationSuccess,
  type IdentityAuthorizationAction,
  type IdentityAuthorizationDecision,
  type IdentityAuthorizationFailure,
  type IdentityAuthorizationInput,
  type IdentityAuthorizationResource,
  type IdentityAuthorizationSuccess,
  type IdentityEvidence,
  type IdentityProvider,
  type IdentityProviderFailure,
  type IdentityProviderFailureCode,
  type PeopleRoster,
  type PersonId,
  type PersonRecord,
  type PersonRegistry,
  type PersonProfile,
  type RoleId,
  type RolePolicy
} from "./identity/types.ts";
export {
  loadPeopleRoster,
  makePeopleRosterIdentityAdminSnapshot,
  peopleRosterFromDocument
} from "./identity/people-roster.ts";
export {
  hasPersonRegistry,
  loadPersonRegistry,
  personRegistryFromDocument,
  personRegistryFromLegacyRoster,
  personRegistryFromRecords,
  personRegistryPath,
  validatePeopleRosterReferences
} from "./identity/person-registry.ts";
export {
  makeTransportDerivedAuthenticationProvider,
  makeTransportDerivedIdentityProvider,
  type TransportDerivedIdentityProviderOptions
} from "./identity/transport-derived-provider.ts";
export {
  authorizePersonForMethod,
  makePeopleRosterAuthorizationProvider,
  makePersonAuthorizationProvider,
  type AuthorizationFailure,
  type AuthorizationSuccess
} from "./identity/authorization.ts";
export {
  currentDaemonProtocolVersion,
  commandClassForApiRoute,
  commandClassForCliActionKind,
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
  createLengthPrefixedFrameReader,
  defaultAuthorityMaxFrameBytes,
  encodeLengthPrefixedFrame,
  type LengthFrameBatch,
  type LengthPrefixedFrameReader
} from "./transport/length-frame-codec.ts";
export {
  AuthorityTransportDisconnectedError,
  PersistentSshAuthorityClient,
  buildAuthoritySshArgs,
  type AuthoritySshTarget,
  type PersistentSshAuthorityClientOptions,
  type SshAuthorityChild,
  type SshAuthorityChildFactory,
  type TransportFlowLimits
} from "./transport/persistent-ssh-authority-client.ts";
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
  createPtyTerminalSessionService,
  resolveTerminalCwd,
  resolveTerminalShell,
  type PtySpawner,
  type PtySpawnOptions,
  type PtyTerminalSessionServiceOptions
} from "../../gui/src/terminal/pty-host.ts";
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
// TW-07 attestation
export * from "./attestation/index.ts";
