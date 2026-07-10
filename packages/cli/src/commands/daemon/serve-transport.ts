import {
  createNamedPipeTransportServer,
  createUnixSocketTransportServer,
  type DaemonAuthenticationContext,
  type DaemonTransportConnection,
  type JsonRpcProtocolServer,
  type NamedPipeTransportServer,
  type UnixSocketTransportServer
} from "../../../../daemon/src/index.ts";

export interface DaemonLocalTransportOptions {
  readonly daemonId: string;
  readonly endpoint: string;
  readonly platform?: NodeJS.Platform;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
  readonly onConnection?: (connection: DaemonTransportConnection) => void;
  readonly onConnectionClosed?: (connection: DaemonTransportConnection) => void;
}

export function createDaemonLocalTransport(
  options: DaemonLocalTransportOptions
): UnixSocketTransportServer | NamedPipeTransportServer {
  if ((options.platform ?? process.platform) === "win32") {
    return createNamedPipeTransportServer({
      daemonId: options.daemonId,
      pipePath: options.endpoint,
      acceptSshForcedCommand: true,
      createProtocolServer: options.createProtocolServer,
      onConnection: options.onConnection,
      onConnectionClosed: options.onConnectionClosed
    });
  }
  return createUnixSocketTransportServer({
    daemonId: options.daemonId,
    socketPath: options.endpoint,
    acceptSshForcedCommand: true,
    createProtocolServer: options.createProtocolServer,
    onConnection: options.onConnection,
    onConnectionClosed: options.onConnectionClosed
  });
}
