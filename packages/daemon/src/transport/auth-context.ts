import type { JsonObject } from "../protocol/json-rpc-types.ts";

export type DaemonTransportKind = "unix-socket" | "named-pipe" | "ssh-exec" | "ssh-tunnel";

export type ConnectionGeneration = string & { readonly __brand: "connection-generation" };
export type ChannelDigest32 = Uint8Array & { readonly __brand: "channel-digest-32" };

export interface OsObservedPeerCredential {
  readonly schema: "os-observed-peer-credential/v1";
  readonly platform: NodeJS.Platform;
  readonly source: "getpeereid" | "LOCAL_PEERCRED" | "SO_PEERCRED";
  readonly uid: number;
  readonly gid?: number;
  readonly pid?: number;
}

export type OsPeerCredentialEvidence =
  | { readonly available: true; readonly value: OsObservedPeerCredential }
  | {
      readonly available: false;
      readonly code: "platform_unsupported" | "observation_failed";
      readonly source: "os-peer-credential-adapter";
    };

export interface UnixSocketOwnerCompatibilityBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
}

export type UnixSocketOwnerBoundary = UnixSocketOwnerCompatibilityBoundary;

export interface AcceptedConnectionEvidence {
  readonly schema: "daemon-accepted-connection-evidence/v1";
  readonly connectionId: string;
  readonly connectionGeneration: ConnectionGeneration;
  readonly transportKind: DaemonTransportKind;
  readonly channelBinding: {
    readonly digest: ChannelDigest32;
    readonly source: "transport-observed";
  };
  readonly peerCredential: OsPeerCredentialEvidence;
  readonly compatibilityBoundary?: UnixSocketOwnerCompatibilityBoundary;
}

export interface AcceptedConnectionEvidenceAdapter<SocketHandle> {
  readonly observeAcceptedConnection: (input: {
    readonly socket: SocketHandle;
    readonly connectionId: string;
    readonly connectionGeneration: ConnectionGeneration;
    readonly daemonInstanceId: string;
    readonly compatibilityBoundary?: UnixSocketOwnerCompatibilityBoundary;
  }) => Promise<AcceptedConnectionEvidence>;
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
