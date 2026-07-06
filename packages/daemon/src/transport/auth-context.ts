import type { JsonObject } from "../protocol/json-rpc-types.ts";

export type DaemonTransportKind = "unix-socket" | "named-pipe" | "ssh-exec" | "ssh-tunnel";

export interface UnixPeerCredential {
  readonly uid?: number;
  readonly gid?: number;
  readonly pid?: number;
  readonly source: "node-process-owner" | "platform-peercred-unavailable";
}

export interface NamedPipeClientContext {
  readonly endpoint: string;
  readonly source: "windows-named-pipe";
}

export interface SshExecUserContext {
  readonly username?: string;
  readonly host?: string;
  readonly source: "ssh-authenticated-exec";
}

export interface AttachTokenSubject {
  readonly userId: string;
  readonly hostProfileId: string;
  readonly daemonInstanceId: string;
  readonly sshUsername?: string;
  readonly claims?: JsonObject;
}

export interface SshTunnelTokenContext {
  readonly tokenId: string;
  readonly tunnelNonce: string;
  readonly subject: AttachTokenSubject;
}

export interface DaemonAuthenticationContext {
  readonly transportKind: DaemonTransportKind;
  readonly endpoint?: string;
  readonly unixPeerCredential?: UnixPeerCredential;
  readonly namedPipeClient?: NamedPipeClientContext;
  readonly sshExecUser?: SshExecUserContext;
  readonly sshTunnelToken?: SshTunnelTokenContext;
}

export function localUnixPeerCredential(): UnixPeerCredential {
  return {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    source: process.getuid || process.getgid ? "node-process-owner" : "platform-peercred-unavailable"
  };
}
