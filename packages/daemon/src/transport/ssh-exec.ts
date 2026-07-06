// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import type { Readable, Writable } from "node:stream";
import type { DaemonAuthenticationContext } from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection } from "./json-rpc-stream.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface SshExecBridgeOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly username?: string;
  readonly host?: string;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
}

export function serveSshExecBridge(options: SshExecBridgeOptions): DaemonTransportConnection {
  const authContext: DaemonAuthenticationContext = {
    transportKind: "ssh-exec",
    sshExecUser: {
      username: options.username,
      host: options.host,
      source: "ssh-authenticated-exec"
    }
  };
  return serveJsonRpcStream({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    transportKind: "ssh-exec",
    authContext,
    createProtocolServer: options.createProtocolServer
  });
}
