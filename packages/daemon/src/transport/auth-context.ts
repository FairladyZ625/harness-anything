import type { JsonObject } from "../protocol/json-rpc-types.ts";

export type DaemonTransportKind = "unix-socket" | "named-pipe" | "ssh-exec" | "ssh-tunnel";

export interface UnixSocketOwnerBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
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

export interface SshForcedCommandContext {
  readonly personId: string;
  readonly canonicalRoot: string;
  readonly source: "sshd-authorized-keys-forced-command";
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
  readonly unixSocketOwnerBoundary?: UnixSocketOwnerBoundary;
  readonly namedPipeClient?: NamedPipeClientContext;
  readonly sshExecUser?: SshExecUserContext;
  readonly sshForcedCommand?: SshForcedCommandContext;
  readonly sshTunnelToken?: SshTunnelTokenContext;
}
