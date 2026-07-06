export {
  currentDaemonProtocolVersion,
  deriveJsonRpcServiceMethodContracts,
  jsonRpcMethodContracts,
  jsonRpcServiceMethodContracts,
  type JsonRpcMethodContract,
  type JsonRpcMethodMode
} from "./protocol/method-registry.ts";
export {
  createJsonRpcProtocolServer,
  type DaemonRepoNamespace,
  type DaemonServiceHost,
  type JsonRpcProtocolServer,
  type JsonRpcServerOptions
} from "./protocol/json-rpc-server.ts";
export type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse
} from "./protocol/json-rpc-types.ts";
export {
  localUnixPeerCredential,
  type AttachTokenSubject,
  type DaemonAuthenticationContext,
  type DaemonTransportKind,
  type NamedPipeClientContext,
  type SshExecUserContext,
  type SshTunnelTokenContext,
  type UnixPeerCredential
} from "./transport/auth-context.ts";
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
