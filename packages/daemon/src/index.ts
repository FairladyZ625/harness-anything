// TW-04 platform
export * from "./platform/index.ts";
export {
  ensureMachinePeopleRoster
} from "./identity/machine-people.ts";
export {
  daemonIdForRoot,
  daemonIdForUserRoot,
  daemonIdFromEnv,
  daemonUserRoot,
  daemonUserRootForRepo,
  DaemonJsonRpcResponseError,
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
  loadPeopleRosterFile,
  mergePeopleRosters,
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
  decodeDaemonStatusRequestV2,
  decodeDaemonStatusResultV2,
  isDaemonStatusContractError,
  projectDaemonStatusForRenderer,
  type DaemonActiveControlStatus,
  type DaemonBuildStatus,
  type DaemonControlAcceptedV1,
  type DaemonControlErrorV1,
  type DaemonControlKind,
  type DaemonControlRequestV1,
  type DaemonControlService,
  type DaemonControlServiceResult,
  type DaemonProtocolErrorV1,
  type DaemonAdmissionStatus,
  type DaemonQueueStatus,
  type DaemonRendererStatusV2,
  type DaemonRepoStatus,
  type DaemonStatusRequestV2,
  type DaemonStatusResultV2,
  type DaemonStatusContractError,
  type DaemonStatusService
} from "../../application/src/daemon-status-contract.ts";
export {
  daemonLogLevels,
  decodeDaemonLogEntry,
  decodeDaemonLogPage,
  decodeDaemonLogListInput,
  isDaemonLogContractError,
  type DaemonLogAppendInput,
  type DaemonLogEntryV1,
  type DaemonLogLevel,
  type DaemonLogListInputV1,
  type DaemonLogPageV1,
  type DaemonLogRepoContext,
  type DaemonLogService
} from "../../application/src/daemon-log-contract.ts";
export {
  calculateDaemonArtifactIdentity,
  resolveDaemonArtifactRoot,
  type DaemonArtifactIdentity
} from "./protocol/daemon-artifact-identity.ts";
export {
  createJsonRpcProtocolServer,
  type DaemonRepoAvailabilityFailure,
  type DaemonRepoNamespace,
  type DaemonServiceHost,
  type JsonRpcProtocolServer,
  type JsonRpcServerOptions
} from "./protocol/json-rpc-server.ts";
export {
  resolveAuthorityConnectionDispatch,
  resolveAuthorityConnectionForRequest,
  type AcceptedConnectionBinding,
  type AuthorityConnectionContext,
  type AuthorityConnectionDispatch,
  type AuthorityConnectionRepo,
  type AuthorityConnectionUnavailableCode,
  type AuthorityPeerPolicy
} from "./protocol/connection-context.ts";
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
  type AcceptedConnectionEvidence,
  type AcceptedConnectionEvidenceAdapter,
  type AttachTokenSubject,
  type ChannelDigest32,
  type ConnectionGeneration,
  type DaemonAuthenticationContext,
  type DaemonTransportKind,
  type NamedPipeClientContext,
  type OsObservedPeerCredential,
  type OsPeerCredentialEvidence,
  type SshExecUserContext,
  type SshForcedCommandContext,
  type SshTunnelTokenContext,
  type UnixSocketOwnerBoundary,
  type UnixSocketOwnerCompatibilityBoundary
} from "./transport/auth-context.ts";
export {
  canonicalPeerCredentialBytes,
  channelDigest32,
  connectionGeneration,
  createAcceptedConnectionEvidence,
  type CreateAcceptedConnectionEvidenceInput
} from "./transport/accepted-connection-evidence.ts";
export {
  createNodeSocketAcceptedConnectionEvidenceAdapter,
  observeNodeSocketPeerCredential,
  type NodeSocketAcceptedConnectionEvidenceAdapterOptions
} from "./transport/node-socket-peer-credential.ts";
export {
  authenticateSshAuthorityWireFrame,
  authenticateSshForcedCommandFrame,
  isSshAuthorityWireBootstrapFrame,
  sshAuthorityWireBootstrapFrame,
  sshForcedCommandBootstrapFrame,
  type AcceptSshForcedCommand,
  type SshAuthenticatedBootstrapFrame,
  type SshAuthorityWireBootstrapFrame,
  type SshForcedCommandBootstrapFrame,
  type SshForcedCommandBootstrapInput
} from "./transport/ssh-forced-command.ts";
export type {
  AuthorityWireIngressHandler,
  AuthorityWireIngressRequest,
  AuthorityWireIngressSession
} from "./transport/authority-wire-ingress.ts";
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
