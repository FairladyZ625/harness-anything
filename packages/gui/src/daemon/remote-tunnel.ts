/** @slice-activation Slice 7.5 GUI remote daemon - Remote terminal transport consumes this when daemon attach wiring lands. */
import type { ApiRouteAuth, ApiRouteContract } from "../api/api-contract-registry.ts";
import type { TerminalSessionInfo } from "../../../application/src/terminal-session-contract.ts";

export type DaemonTransport =
  | { readonly kind: "local-ipc"; readonly endpoint: string }
  | { readonly kind: "local-loopback"; readonly host: "127.0.0.1"; readonly port: number }
  | { readonly kind: "ssh-tunnel"; readonly tunnelId: string; readonly localHost: "127.0.0.1"; readonly localPort: number };

export type TunnelConnectionStatus =
  | "initiating"
  | "authenticating"
  | "established"
  | "degraded"
  | "reconnecting"
  | "failed"
  | "closed";

export interface TunnelConnectionInfo {
  readonly tunnelId: string;
  readonly hostProfileId: string;
  readonly status: TunnelConnectionStatus;
  readonly localHost: "127.0.0.1";
  readonly localPort: number;
  readonly remoteDaemonId?: string;
  readonly startedAt: string;
  readonly lastHeartbeatAt?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface RemoteHostProfile {
  readonly hostProfileId: string;
  readonly label: string;
  readonly sshConfigHost: string;
  readonly revokedAt?: string;
}

export interface RemoteDaemonAttachTokenMetadata {
  readonly tokenId: string;
  readonly daemonInstanceId: string;
  readonly userId: string;
  readonly hostProfileId: string;
  readonly tunnelNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface RemoteDaemonAttachSecret {
  readonly tokenId: string;
  readonly value: string;
}

export interface RemoteDaemonAttachTokenSuccess {
  readonly ok: true;
  readonly metadata: RemoteDaemonAttachTokenMetadata;
  readonly secret: RemoteDaemonAttachSecret;
}

export interface RemoteTunnelFailure {
  readonly ok: false;
  readonly error: {
    readonly code:
      | "host_profile_not_found"
      | "host_profile_revoked"
      | "invalid_tunnel_port"
      | "invalid_tunnel_state"
      | "token_already_used"
      | "token_daemon_mismatch"
      | "token_expired"
      | "token_host_mismatch"
      | "token_nonce_mismatch"
      | "token_not_found"
      | "token_revoked"
      | "token_secret_mismatch"
      | "tunnel_not_found";
    readonly hint: string;
  };
}

export type RemoteDaemonAttachTokenResult = RemoteDaemonAttachTokenSuccess | RemoteTunnelFailure;

export interface RequestAttachTokenInput {
  readonly hostProfileId: string;
  readonly daemonInstanceId: string;
  readonly userId: string;
  readonly ttlMillis: number;
  readonly tunnelNonce?: string;
}

export interface StartTunnelInput {
  readonly hostProfileId: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly tunnelNonce: string;
  readonly localPort: number;
  readonly remoteDaemonId: string;
}

export interface InitiateTunnelInput {
  readonly hostProfileId: string;
  readonly localPort: number;
}

export interface AuthenticateTunnelInput {
  readonly tunnelId: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly tunnelNonce: string;
  readonly remoteDaemonId: string;
}

export interface TunnelConnectionSuccess {
  readonly ok: true;
  readonly tunnel: TunnelConnectionInfo;
}

export type TunnelConnectionResult = TunnelConnectionSuccess | RemoteTunnelFailure;

export interface BoundApiRouteForTransport {
  readonly id: string;
  readonly method: ApiRouteContract["method"];
  readonly path: string;
  readonly service: ApiRouteContract["service"];
  readonly serviceMethod: ApiRouteContract["serviceMethod"];
  readonly auth: ApiRouteAuth;
  readonly transport: DaemonTransport["kind"];
}

export interface RemoteTerminalSurfaceState {
  readonly sessionId: string;
  readonly terminalStatus: TerminalSessionInfo["status"];
  readonly surfaceStatus: "attached" | "detached" | "degraded" | "closed";
  readonly reason?: string;
}

export interface RemoteDaemonTunnelController {
  readonly requestAttachToken: (input: RequestAttachTokenInput) => RemoteDaemonAttachTokenResult;
  readonly initiateTunnel: (input: InitiateTunnelInput) => TunnelConnectionResult;
  readonly authenticateTunnel: (input: AuthenticateTunnelInput) => TunnelConnectionResult;
  readonly establishTunnel: (tunnelId: string) => TunnelConnectionResult;
  readonly startTunnel: (input: StartTunnelInput) => TunnelConnectionResult;
  readonly markDegraded: (tunnelId: string, errorCode: string, errorMessage: string) => TunnelConnectionResult;
  readonly beginReconnect: (tunnelId: string) => TunnelConnectionResult;
  readonly completeReconnect: (tunnelId: string) => TunnelConnectionResult;
  readonly failTunnel: (tunnelId: string, errorCode: string, errorMessage: string) => TunnelConnectionResult;
  readonly closeTunnel: (tunnelId: string) => TunnelConnectionResult;
  readonly revokeHostProfile: (hostProfileId: string) => void;
  readonly listTunnels: () => ReadonlyArray<TunnelConnectionInfo>;
  readonly listTokenMetadata: () => ReadonlyArray<RemoteDaemonAttachTokenMetadata>;
}

export interface RemoteDaemonTunnelControllerOptions {
  readonly hostProfiles: ReadonlyArray<RemoteHostProfile>;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

export function bindApiRoutesToDaemonTransport(
  routes: ReadonlyArray<ApiRouteContract>,
  transport: DaemonTransport
): ReadonlyArray<BoundApiRouteForTransport> {
  return routes.map((route) => ({
    id: route.id,
    method: route.method,
    path: route.path,
    service: route.service,
    serviceMethod: route.serviceMethod,
    auth: transport.kind === "ssh-tunnel" ? "ssh-tunnel-local-token" : route.auth,
    transport: transport.kind
  }));
}

export function createRemoteDaemonTunnelController(options: RemoteDaemonTunnelControllerOptions): RemoteDaemonTunnelController {
  const hostProfiles = new Map(options.hostProfiles.map((profile) => [profile.hostProfileId, profile]));
  const tokens = new Map<string, RemoteDaemonAttachTokenMetadata>();
  const tokenSecrets = new Map<string, string>();
  const consumedTokenIds = new Set<string>();
  const tunnels = new Map<string, TunnelConnectionInfo>();
  const createId = options.createId ?? randomId;
  const now = options.now ?? (() => new Date().toISOString());

  function hostProfile(hostProfileId: string): RemoteHostProfile | RemoteTunnelFailure {
    const profile = hostProfiles.get(hostProfileId);
    if (!profile) return failure("host_profile_not_found", `Remote host profile not found: ${hostProfileId}`);
    if (profile.revokedAt) return failure("host_profile_revoked", `Remote host profile is revoked: ${hostProfileId}`);
    return profile;
  }

  function validateToken(input: {
    readonly tokenId: string;
    readonly tokenSecret: string;
    readonly hostProfileId: string;
    readonly remoteDaemonId: string;
    readonly tunnelNonce: string;
  }): RemoteDaemonAttachTokenMetadata | RemoteTunnelFailure {
    const tokenId = input.tokenId;
    const token = tokens.get(tokenId);
    if (!token) return failure("token_not_found", `Remote daemon attach token not found: ${tokenId}`);
    if (token.hostProfileId !== input.hostProfileId) {
      return failure("token_host_mismatch", "Remote daemon attach token is bound to a different host profile.");
    }
    if (token.daemonInstanceId !== input.remoteDaemonId) {
      return failure("token_daemon_mismatch", "Remote daemon attach token is bound to a different daemon instance.");
    }
    if (token.tunnelNonce !== input.tunnelNonce) {
      return failure("token_nonce_mismatch", "Remote daemon attach token is bound to a different tunnel nonce.");
    }
    if (tokenSecrets.get(tokenId) !== input.tokenSecret) {
      return failure("token_secret_mismatch", "Remote daemon attach token secret is invalid.");
    }
    if (consumedTokenIds.has(tokenId)) return failure("token_already_used", "Remote daemon attach token has already been used.");
    if (token.revokedAt) return failure("token_revoked", "Remote daemon attach token has been revoked.");
    if (Date.parse(token.expiresAt) <= Date.parse(now())) return failure("token_expired", "Remote daemon attach token has expired.");
    return token;
  }

  function existingTunnel(tunnelId: string): TunnelConnectionInfo | RemoteTunnelFailure {
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) return failure("tunnel_not_found", `Tunnel not found: ${tunnelId}`);
    return tunnel;
  }

  function save(tunnel: TunnelConnectionInfo): TunnelConnectionInfo {
    tunnels.set(tunnel.tunnelId, tunnel);
    return tunnel;
  }

  const controller: RemoteDaemonTunnelController = {
    requestAttachToken: (input) => {
      const profile = hostProfile(input.hostProfileId);
      if (!isRemoteHostProfile(profile)) return profile;
      const issuedAt = now();
      const tokenId = createId("token");
      const metadata: RemoteDaemonAttachTokenMetadata = {
        tokenId,
        daemonInstanceId: input.daemonInstanceId,
        userId: input.userId,
        hostProfileId: input.hostProfileId,
        tunnelNonce: input.tunnelNonce ?? createId("nonce"),
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + input.ttlMillis).toISOString()
      };
      tokens.set(tokenId, metadata);
      const secret = createId("secret");
      tokenSecrets.set(tokenId, secret);
      return {
        ok: true,
        metadata,
        secret: {
          tokenId,
          value: secret
        }
      };
    },
    initiateTunnel: (input) => {
      const profile = hostProfile(input.hostProfileId);
      if (!isRemoteHostProfile(profile)) return profile;
      if (!Number.isInteger(input.localPort) || input.localPort <= 0 || input.localPort > 65535) {
        return failure("invalid_tunnel_port", "SSH tunnel local port must be a valid TCP port.");
      }
      const timestamp = now();
      return {
        ok: true,
        tunnel: save({
          tunnelId: createId("tunnel"),
          hostProfileId: input.hostProfileId,
          status: "initiating",
          localHost: "127.0.0.1",
          localPort: input.localPort,
          startedAt: timestamp
        })
      };
    },
    authenticateTunnel: (input) => {
      const tunnel = existingTunnel(input.tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      if (tunnel.status !== "initiating" && tunnel.status !== "reconnecting") {
        return failure("invalid_tunnel_state", `Tunnel cannot authenticate from status: ${tunnel.status}`);
      }
      const profile = hostProfile(tunnel.hostProfileId);
      if (!isRemoteHostProfile(profile)) return profile;
      const token = validateToken({
        tokenId: input.tokenId,
        tokenSecret: input.tokenSecret,
        hostProfileId: tunnel.hostProfileId,
        remoteDaemonId: input.remoteDaemonId,
        tunnelNonce: input.tunnelNonce
      });
      if (!isRemoteDaemonAttachTokenMetadata(token)) return token;
      consumedTokenIds.add(input.tokenId);
      return {
        ok: true,
        tunnel: save({
          ...tunnel,
          status: "authenticating",
          remoteDaemonId: input.remoteDaemonId,
          lastHeartbeatAt: now()
        })
      };
    },
    establishTunnel: (tunnelId) => {
      const tunnel = existingTunnel(tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      if (tunnel.status !== "authenticating") {
        return failure("invalid_tunnel_state", `Tunnel cannot be established from status: ${tunnel.status}`);
      }
      return { ok: true, tunnel: save({ ...tunnel, status: "established", lastHeartbeatAt: now() }) };
    },
    startTunnel: (input) => {
      const profile = hostProfile(input.hostProfileId);
      if (!isRemoteHostProfile(profile)) return profile;
      const token = validateToken({
        tokenId: input.tokenId,
        tokenSecret: input.tokenSecret,
        hostProfileId: input.hostProfileId,
        remoteDaemonId: input.remoteDaemonId,
        tunnelNonce: input.tunnelNonce
      });
      if (!isRemoteDaemonAttachTokenMetadata(token)) return token;
      if (!Number.isInteger(input.localPort) || input.localPort <= 0 || input.localPort > 65535) {
        return failure("invalid_tunnel_port", "SSH tunnel local port must be a valid TCP port.");
      }
      consumedTokenIds.add(input.tokenId);
      const timestamp = now();
      return {
        ok: true,
        tunnel: save({
          tunnelId: createId("tunnel"),
          hostProfileId: input.hostProfileId,
          status: "established",
          localHost: "127.0.0.1",
          localPort: input.localPort,
          remoteDaemonId: input.remoteDaemonId,
          startedAt: timestamp,
          lastHeartbeatAt: timestamp
        })
      };
    },
    markDegraded: (tunnelId, errorCode, errorMessage) => {
      const tunnel = existingTunnel(tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      if (tunnel.status === "closed") return failure("invalid_tunnel_state", "Closed tunnels cannot be marked degraded.");
      return {
        ok: true,
        tunnel: save({ ...tunnel, status: "degraded", errorCode, errorMessage, lastHeartbeatAt: now() })
      };
    },
    beginReconnect: (tunnelId) => {
      const tunnel = existingTunnel(tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      if (tunnel.status !== "degraded" && tunnel.status !== "failed") {
        return failure("invalid_tunnel_state", `Tunnel cannot reconnect from status: ${tunnel.status}`);
      }
      const profile = hostProfile(tunnel.hostProfileId);
      if (!isRemoteHostProfile(profile)) return profile;
      return { ok: true, tunnel: save({ ...tunnel, status: "reconnecting", lastHeartbeatAt: now() }) };
    },
    completeReconnect: (tunnelId) => {
      const tunnel = existingTunnel(tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      if (tunnel.status !== "reconnecting") {
        return failure("invalid_tunnel_state", `Tunnel cannot complete reconnect from status: ${tunnel.status}`);
      }
      const profile = hostProfile(tunnel.hostProfileId);
      if (!isRemoteHostProfile(profile)) return profile;
      return {
        ok: true,
        tunnel: save({
          ...tunnel,
          status: "established",
          lastHeartbeatAt: now(),
          errorCode: undefined,
          errorMessage: undefined
        })
      };
    },
    failTunnel: (tunnelId, errorCode, errorMessage) => {
      const tunnel = existingTunnel(tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      if (tunnel.status === "closed") return failure("invalid_tunnel_state", "Closed tunnels cannot be marked failed.");
      return { ok: true, tunnel: save({ ...tunnel, status: "failed", errorCode, errorMessage, lastHeartbeatAt: now() }) };
    },
    closeTunnel: (tunnelId) => {
      const tunnel = existingTunnel(tunnelId);
      if (!isTunnelConnectionInfo(tunnel)) return tunnel;
      return { ok: true, tunnel: save({ ...tunnel, status: "closed", lastHeartbeatAt: now() }) };
    },
    revokeHostProfile: (hostProfileId) => {
      const timestamp = now();
      const profile = hostProfiles.get(hostProfileId);
      if (profile) hostProfiles.set(hostProfileId, { ...profile, revokedAt: timestamp });
      for (const token of tokens.values()) {
        if (token.hostProfileId === hostProfileId && !token.revokedAt) tokens.set(token.tokenId, { ...token, revokedAt: timestamp });
      }
      for (const tunnel of tunnels.values()) {
        if (tunnel.hostProfileId === hostProfileId && tunnel.status !== "closed") {
          save({
            ...tunnel,
            status: "closed",
            lastHeartbeatAt: timestamp,
            errorCode: "host_profile_revoked",
            errorMessage: "Remote host profile was revoked."
          });
        }
      }
    },
    listTunnels: () => [...tunnels.values()].sort((left, right) => left.tunnelId.localeCompare(right.tunnelId)),
    listTokenMetadata: () => [...tokens.values()].sort((left, right) => left.tokenId.localeCompare(right.tokenId))
  };
  return controller;
}

export function deriveRemoteTerminalSurfaceState(
  session: TerminalSessionInfo,
  tunnel: TunnelConnectionInfo
): RemoteTerminalSurfaceState {
  if (session.status === "exited") {
    return {
      sessionId: session.sessionId,
      terminalStatus: "exited",
      surfaceStatus: "closed",
      reason: "terminal-session-exited"
    };
  }
  if (tunnel.status === "established") {
    return {
      sessionId: session.sessionId,
      terminalStatus: session.status,
      surfaceStatus: "attached"
    };
  }
  if (tunnel.status === "closed") {
    return {
      sessionId: session.sessionId,
      terminalStatus: session.status,
      surfaceStatus: "detached",
      reason: tunnel.errorCode ?? "tunnel-closed"
    };
  }
  return {
    sessionId: session.sessionId,
    terminalStatus: session.status,
    surfaceStatus: "degraded",
    reason: tunnel.errorCode ?? `tunnel-${tunnel.status}`
  };
}

export function publicTokenMetadata(metadata: RemoteDaemonAttachTokenMetadata): RemoteDaemonAttachTokenMetadata {
  return { ...metadata };
}

function failure(code: RemoteTunnelFailure["error"]["code"], hint: string): RemoteTunnelFailure {
  return { ok: false, error: { code, hint } };
}

function isRemoteHostProfile(value: RemoteHostProfile | RemoteTunnelFailure): value is RemoteHostProfile {
  return !("ok" in value);
}

function isRemoteDaemonAttachTokenMetadata(
  value: RemoteDaemonAttachTokenMetadata | RemoteTunnelFailure
): value is RemoteDaemonAttachTokenMetadata {
  return !("ok" in value);
}

function isTunnelConnectionInfo(value: TunnelConnectionInfo | RemoteTunnelFailure): value is TunnelConnectionInfo {
  return !("ok" in value);
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
