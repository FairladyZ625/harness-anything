import assert from "node:assert/strict";
import test from "node:test";
import {
  apiRouteContracts,
  bindApiRoutesToDaemonTransport,
  createRemoteDaemonTunnelController,
  deriveRemoteTerminalSurfaceState,
  publicTokenMetadata
} from "../src/index.ts";
import type { RemoteHostProfile, TerminalSessionInfo } from "../src/index.ts";

test("ssh tunnel transport reuses daemon API route semantics with tunnel auth only", () => {
  const local = bindApiRoutesToDaemonTransport(apiRouteContracts, {
    kind: "local-loopback",
    host: "127.0.0.1",
    port: 4873
  });
  const remote = bindApiRoutesToDaemonTransport(apiRouteContracts, {
    kind: "ssh-tunnel",
    tunnelId: "tunnel-1",
    localHost: "127.0.0.1",
    localPort: 65001
  });

  assert.deepEqual(
    remote.map(({ id, method, path, service, serviceMethod }) => ({ id, method, path, service, serviceMethod })),
    local.map(({ id, method, path, service, serviceMethod }) => ({ id, method, path, service, serviceMethod }))
  );
  assert.equal(remote.every((route) => route.auth === "ssh-tunnel-local-token"), true);
  assert.equal(remote.some((route) => route.id.includes("remote")), false);
});

test("remote daemon token bootstrap stores metadata separately from the one-time secret", () => {
  const controller = createRemoteDaemonTunnelController({
    hostProfiles: [hostProfile("host-a")],
    createId: sequenceId(),
    now: sequenceTime("2026-06-14T00:00:00.000Z")
  });

  const issued = controller.requestAttachToken({
    hostProfileId: "host-a",
    daemonInstanceId: "daemon-a",
    userId: "user-a",
    ttlMillis: 60_000,
    tunnelNonce: "nonce-a"
  });

  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(issued.secret.value, "secret-2");
  assert.deepEqual(publicTokenMetadata(issued.metadata), {
    tokenId: "token-1",
    daemonInstanceId: "daemon-a",
    userId: "user-a",
    hostProfileId: "host-a",
    tunnelNonce: "nonce-a",
    issuedAt: "2026-06-14T00:00:00.000Z",
    expiresAt: "2026-06-14T00:01:00.000Z"
  });
  assert.deepEqual(controller.listTokenMetadata(), [issued.metadata]);
  assert.equal(JSON.stringify(controller.listTokenMetadata()).includes("secret-2"), false);
});

test("remote daemon tunnel lifecycle distinguishes degraded reconnect failed and closed", () => {
  const controller = createRemoteDaemonTunnelController({
    hostProfiles: [hostProfile("host-a")],
    createId: sequenceId(),
    now: sequenceTime("2026-06-14T01:00:00.000Z")
  });
  const token = controller.requestAttachToken({
    hostProfileId: "host-a",
    daemonInstanceId: "daemon-a",
    userId: "user-a",
    ttlMillis: 60_000
  });
  assert.equal(token.ok, true);
  if (!token.ok) return;

  const initiated = controller.initiateTunnel({
    hostProfileId: "host-a",
    localPort: 65001
  });
  assert.equal(initiated.ok, true);
  if (!initiated.ok) return;
  assert.equal(initiated.tunnel.status, "initiating");

  const authenticating = controller.authenticateTunnel({
    tunnelId: initiated.tunnel.tunnelId,
    tokenId: token.metadata.tokenId,
    tokenSecret: token.secret.value,
    tunnelNonce: token.metadata.tunnelNonce,
    remoteDaemonId: "daemon-a"
  });
  assert.equal(authenticating.ok, true);
  if (!authenticating.ok) return;
  assert.equal(authenticating.tunnel.status, "authenticating");

  const started = controller.establishTunnel(authenticating.tunnel.tunnelId);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.tunnel.status, "established");
  assert.deepEqual(
    controller.authenticateTunnel({
      tunnelId: started.tunnel.tunnelId,
      tokenId: token.metadata.tokenId,
      tokenSecret: token.secret.value,
      tunnelNonce: token.metadata.tunnelNonce,
      remoteDaemonId: "daemon-a"
    }),
    {
      ok: false,
      error: {
        code: "invalid_tunnel_state",
        hint: "Tunnel cannot authenticate from status: established"
      }
    }
  );

  const degraded = controller.markDegraded(started.tunnel.tunnelId, "remote_daemon_unreachable", "heartbeat missed");
  assert.equal(degraded.ok, true);
  if (!degraded.ok) return;
  assert.equal(degraded.tunnel.status, "degraded");
  assert.equal(degraded.tunnel.errorCode, "remote_daemon_unreachable");

  const reconnecting = controller.beginReconnect(started.tunnel.tunnelId);
  assert.equal(reconnecting.ok, true);
  if (!reconnecting.ok) return;
  assert.equal(reconnecting.tunnel.status, "reconnecting");

  const reconnected = controller.completeReconnect(started.tunnel.tunnelId);
  assert.equal(reconnected.ok, true);
  if (!reconnected.ok) return;
  assert.equal(reconnected.tunnel.status, "established");
  assert.equal(reconnected.tunnel.errorCode, undefined);

  const failed = controller.failTunnel(started.tunnel.tunnelId, "ssh_tunnel_closed", "ssh process exited");
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.tunnel.status, "failed");

  const closed = controller.closeTunnel(started.tunnel.tunnelId);
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.tunnel.status, "closed");
});

test("token expiry and host revoke block new tunnel use without requiring network", () => {
  const controller = createRemoteDaemonTunnelController({
    hostProfiles: [hostProfile("host-a"), hostProfile("host-b")],
    createId: sequenceId(),
    now: sequenceTime("2026-06-14T02:00:00.000Z", 61_000)
  });
  const expired = controller.requestAttachToken({
    hostProfileId: "host-a",
    daemonInstanceId: "daemon-a",
    userId: "user-a",
    ttlMillis: 60_000
  });
  assert.equal(expired.ok, true);
  if (!expired.ok) return;

  assert.deepEqual(
    controller.startTunnel({
      hostProfileId: "host-a",
      tokenId: expired.metadata.tokenId,
      tokenSecret: expired.secret.value,
      tunnelNonce: expired.metadata.tunnelNonce,
      localPort: 65001,
      remoteDaemonId: "daemon-a"
    }),
    {
      ok: false,
      error: {
        code: "token_expired",
        hint: "Remote daemon attach token has expired."
      }
    }
  );

  const revoked = controller.requestAttachToken({
    hostProfileId: "host-b",
    daemonInstanceId: "daemon-b",
    userId: "user-a",
    ttlMillis: 120_000
  });
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;
  controller.revokeHostProfile("host-b");

  assert.deepEqual(
    controller.startTunnel({
      hostProfileId: "host-b",
      tokenId: revoked.metadata.tokenId,
      tokenSecret: revoked.secret.value,
      tunnelNonce: revoked.metadata.tunnelNonce,
      localPort: 65002,
      remoteDaemonId: "daemon-b"
    }),
    {
      ok: false,
      error: {
        code: "host_profile_revoked",
        hint: "Remote host profile is revoked: host-b"
      }
    }
  );
});

test("token id metadata alone cannot authenticate and attach tokens are one-time daemon nonce bound", () => {
  const controller = createRemoteDaemonTunnelController({
    hostProfiles: [hostProfile("host-a")],
    createId: sequenceId(),
    now: sequenceTime("2026-06-14T02:30:00.000Z")
  });
  const issued = controller.requestAttachToken({
    hostProfileId: "host-a",
    daemonInstanceId: "daemon-a",
    userId: "user-a",
    ttlMillis: 60_000,
    tunnelNonce: "nonce-a"
  });
  assert.equal(issued.ok, true);
  if (!issued.ok) return;

  assert.deepEqual(
    controller.startTunnel({
      hostProfileId: "host-a",
      tokenId: issued.metadata.tokenId,
      tokenSecret: "not-the-secret",
      tunnelNonce: "nonce-a",
      localPort: 65001,
      remoteDaemonId: "daemon-a"
    }),
    {
      ok: false,
      error: {
        code: "token_secret_mismatch",
        hint: "Remote daemon attach token secret is invalid."
      }
    }
  );
  assert.deepEqual(
    controller.startTunnel({
      hostProfileId: "host-a",
      tokenId: issued.metadata.tokenId,
      tokenSecret: issued.secret.value,
      tunnelNonce: "wrong-nonce",
      localPort: 65001,
      remoteDaemonId: "daemon-a"
    }),
    {
      ok: false,
      error: {
        code: "token_nonce_mismatch",
        hint: "Remote daemon attach token is bound to a different tunnel nonce."
      }
    }
  );
  assert.deepEqual(
    controller.startTunnel({
      hostProfileId: "host-a",
      tokenId: issued.metadata.tokenId,
      tokenSecret: issued.secret.value,
      tunnelNonce: "nonce-a",
      localPort: 65001,
      remoteDaemonId: "daemon-b"
    }),
    {
      ok: false,
      error: {
        code: "token_daemon_mismatch",
        hint: "Remote daemon attach token is bound to a different daemon instance."
      }
    }
  );

  const started = controller.startTunnel({
    hostProfileId: "host-a",
    tokenId: issued.metadata.tokenId,
    tokenSecret: issued.secret.value,
    tunnelNonce: "nonce-a",
    localPort: 65001,
    remoteDaemonId: "daemon-a"
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.deepEqual(
    controller.startTunnel({
      hostProfileId: "host-a",
      tokenId: issued.metadata.tokenId,
      tokenSecret: issued.secret.value,
      tunnelNonce: "nonce-a",
      localPort: 65002,
      remoteDaemonId: "daemon-a"
    }),
    {
      ok: false,
      error: {
        code: "token_already_used",
        hint: "Remote daemon attach token has already been used."
      }
    }
  );
});

test("closed or revoked tunnels cannot be reconnected back to established", () => {
  const controller = createRemoteDaemonTunnelController({
    hostProfiles: [hostProfile("host-a")],
    createId: sequenceId(),
    now: sequenceTime("2026-06-14T02:45:00.000Z")
  });
  const token = controller.requestAttachToken({
    hostProfileId: "host-a",
    daemonInstanceId: "daemon-a",
    userId: "user-a",
    ttlMillis: 60_000
  });
  assert.equal(token.ok, true);
  if (!token.ok) return;
  const started = controller.startTunnel({
    hostProfileId: "host-a",
    tokenId: token.metadata.tokenId,
    tokenSecret: token.secret.value,
    tunnelNonce: token.metadata.tunnelNonce,
    localPort: 65001,
    remoteDaemonId: "daemon-a"
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.deepEqual(controller.beginReconnect(started.tunnel.tunnelId), {
    ok: false,
    error: {
      code: "invalid_tunnel_state",
      hint: "Tunnel cannot reconnect from status: established"
    }
  });
  controller.revokeHostProfile("host-a");
  assert.deepEqual(controller.completeReconnect(started.tunnel.tunnelId), {
    ok: false,
    error: {
      code: "invalid_tunnel_state",
      hint: "Tunnel cannot complete reconnect from status: closed"
    }
  });
  assert.deepEqual(controller.markDegraded(started.tunnel.tunnelId, "stale_heartbeat", "late stale event"), {
    ok: false,
    error: {
      code: "invalid_tunnel_state",
      hint: "Closed tunnels cannot be marked degraded."
    }
  });
  assert.deepEqual(controller.failTunnel(started.tunnel.tunnelId, "stale_ssh_close", "late stale event"), {
    ok: false,
    error: {
      code: "invalid_tunnel_state",
      hint: "Closed tunnels cannot be marked failed."
    }
  });
});

test("tunnel disconnect and host revoke degrade remote terminal surfaces instead of exiting sessions", () => {
  const activeSession = remoteSession("term-1", "active");
  const exitedSession = remoteSession("term-2", "exited");
  const degradedTunnel = {
    tunnelId: "tunnel-1",
    hostProfileId: "host-a",
    status: "degraded" as const,
    localHost: "127.0.0.1" as const,
    localPort: 65001,
    startedAt: "2026-06-14T03:00:00.000Z",
    errorCode: "ssh_tunnel_closed",
    errorMessage: "ssh process exited"
  };
  const closedRevokedTunnel = {
    ...degradedTunnel,
    status: "closed" as const,
    errorCode: "host_profile_revoked",
    errorMessage: "Remote host profile was revoked."
  };

  assert.deepEqual(deriveRemoteTerminalSurfaceState(activeSession, degradedTunnel), {
    sessionId: "term-1",
    terminalStatus: "active",
    surfaceStatus: "degraded",
    reason: "ssh_tunnel_closed"
  });
  assert.deepEqual(deriveRemoteTerminalSurfaceState(activeSession, closedRevokedTunnel), {
    sessionId: "term-1",
    terminalStatus: "active",
    surfaceStatus: "detached",
    reason: "host_profile_revoked"
  });
  assert.deepEqual(deriveRemoteTerminalSurfaceState(exitedSession, degradedTunnel), {
    sessionId: "term-2",
    terminalStatus: "exited",
    surfaceStatus: "closed",
    reason: "terminal-session-exited"
  });
});

function hostProfile(hostProfileId: string): RemoteHostProfile {
  return {
    hostProfileId,
    label: hostProfileId,
    sshConfigHost: hostProfileId
  };
}

function remoteSession(sessionId: string, status: TerminalSessionInfo["status"]): TerminalSessionInfo {
  return {
    sessionId,
    name: "Remote shell",
    backend: "remote",
    status,
    hostProfileId: "host-a",
    hostLabel: "remote-a",
    projectId: "project-a",
    taskId: "task-a",
    cwd: "/workspace",
    shell: "/bin/zsh",
    createdAt: "2026-06-14T03:00:00.000Z",
    lastActivityAt: "2026-06-14T03:00:00.000Z"
  };
}

function sequenceId(): (prefix: string) => string {
  let value = 0;
  return (prefix) => `${prefix}-${++value}`;
}

function sequenceTime(start: string, stepMs = 1000): () => string {
  let value = Date.parse(start);
  return () => {
    const current = new Date(value).toISOString();
    value += stepMs;
    return current;
  };
}
