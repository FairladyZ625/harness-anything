// @slice-activation PLT-Daemon W4 transport-derived identity provider exported for daemon composition and W7 team server wiring.
import os from "node:os";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { CredentialRef, IdentityProvider, IdentityProviderFailure, PeopleRoster } from "./types.ts";

export interface TransportDerivedIdentityProviderOptions {
  readonly localUnixIssuer?: string;
  readonly sshExecIssuer?: string;
  readonly namedPipeIssuer?: string;
}

export function makeTransportDerivedIdentityProvider(
  roster: PeopleRoster,
  options: TransportDerivedIdentityProviderOptions = {}
): IdentityProvider {
  const providerId = "transport-derived/v1";
  return {
    providerId,
    resolveActor: async ({ authContext }) => {
      const credential = credentialFromAuthContext(authContext, options);
      if (!credential) {
        return unavailableTransportCredentialFailure(
          providerId,
          "credential_unavailable",
          "Transport authentication context did not expose a usable credential."
        );
      }
      return roster.resolveCredential(credential, providerId);
    }
  };
}

function credentialFromAuthContext(
  authContext: DaemonAuthenticationContext,
  options: TransportDerivedIdentityProviderOptions
): CredentialRef | undefined {
  if (typeof authContext.unixPeerCredential?.uid === "number") {
    return {
      kind: "unix-uid",
      issuer: options.localUnixIssuer ?? `host:${os.hostname()}`,
      subject: String(authContext.unixPeerCredential.uid)
    };
  }
  if (authContext.sshExecUser?.username) {
    return {
      kind: "ssh-username",
      issuer: options.sshExecIssuer ?? `host:${authContext.sshExecUser.host ?? "unknown"}`,
      subject: authContext.sshExecUser.username
    };
  }
  if (authContext.sshTunnelToken?.subject.userId) {
    return {
      kind: "ssh-tunnel-token-subject",
      issuer: `host-profile:${authContext.sshTunnelToken.subject.hostProfileId}`,
      subject: authContext.sshTunnelToken.subject.userId
    };
  }
  if (authContext.namedPipeClient?.endpoint) {
    return {
      kind: "windows-named-pipe-client",
      issuer: options.namedPipeIssuer ?? "host:windows-named-pipe",
      subject: authContext.namedPipeClient.endpoint
    };
  }
  return undefined;
}

function unavailableTransportCredentialFailure(
  providerId: string,
  code: IdentityProviderFailure["code"],
  message: string
): IdentityProviderFailure {
  return { ok: false, code, providerId, message };
}
