// @slice-activation PLT-Daemon W4 transport-derived identity provider exported for daemon composition and W7 team server wiring.
import os from "node:os";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { CredentialRef, IdentityProvider, IdentityProviderFailure, PeopleRoster } from "./types.ts";

export interface TransportDerivedIdentityProviderOptions {
  readonly localUnixIssuer?: string;
}

export function makeTransportDerivedIdentityProvider(
  roster: PeopleRoster,
  options: TransportDerivedIdentityProviderOptions = {},
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
          "Transport authentication context did not expose a usable credential.",
        );
      }
      return roster.resolveCredential(credential, providerId);
    },
  };
}

function credentialFromAuthContext(
  authContext: DaemonAuthenticationContext,
  options: TransportDerivedIdentityProviderOptions,
): CredentialRef | undefined {
  if (typeof authContext.unixSocketOwnerBoundary?.ownerUid === "number") {
    return {
      kind: "unix-socket-owner-boundary",
      issuer: options.localUnixIssuer ?? `host:${os.hostname()}`,
      subject: String(authContext.unixSocketOwnerBoundary.ownerUid),
    };
  }
  return undefined;
}

function unavailableTransportCredentialFailure(
  providerId: string,
  code: IdentityProviderFailure["code"],
  message: string,
): IdentityProviderFailure {
  return { ok: false, code, providerId, message };
}
