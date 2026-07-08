import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";

export type PersonId = string;
export type RoleId = string;

export type CredentialKind =
  | "unix-uid"
  | "windows-named-pipe-client"
  | "ssh-username"
  | "ssh-tunnel-token-subject"
  | "email-address"
  | "password-account"
  | "oauth-subject"
  | "api-token";

export type DaemonCommandClass = "admin" | "repo-write" | "repo-read" | "arbiter";

export interface CredentialRef {
  readonly kind: CredentialKind;
  readonly issuer: string;
  readonly subject: string;
}

export interface PersonProfile {
  readonly personId: PersonId;
  readonly displayName: string;
  readonly primaryEmail?: string;
  readonly roles: ReadonlyArray<RoleId>;
  readonly credentials: ReadonlyArray<CredentialRef>;
  readonly disabled?: boolean;
}

export interface RolePolicy {
  readonly roleId: RoleId;
  readonly commandClasses: ReadonlyArray<DaemonCommandClass>;
}

export interface PeopleRoster {
  readonly schema: "harness-people/v1";
  readonly people: ReadonlyArray<PersonProfile>;
  readonly roles: ReadonlyArray<RolePolicy>;
  readonly resolveCredential: (credential: CredentialRef, providerId: string) => IdentityProviderSuccess | IdentityProviderFailure;
  readonly roleAllows: (roleId: RoleId, commandClass: DaemonCommandClass) => boolean;
}

export interface AuthenticatedActor {
  readonly personId: PersonId;
  readonly displayName: string;
  readonly primaryEmail?: string;
  readonly roles: ReadonlyArray<RoleId>;
  readonly resolvedCredential: CredentialRef;
  readonly providerId: string;
}

export interface ActorStamp {
  readonly personId: PersonId;
  readonly displayName: string;
  readonly primaryEmail?: string;
  readonly providerId: string;
  readonly credential: CredentialRef;
}

export interface IdentityProviderResolveInput {
  readonly authContext: DaemonAuthenticationContext;
  readonly command: {
    readonly method: string;
    readonly namespace: "protocol" | "repo" | "admin";
    readonly requiresRepo: boolean;
  };
}

export type IdentityProviderFailureCode =
  | "credential_unavailable"
  | "credential_unknown"
  | "person_disabled"
  | "provider_unavailable"
  | "malformed_credential";

export interface IdentityProviderFailure {
  readonly ok: false;
  readonly code: IdentityProviderFailureCode;
  readonly providerId: string;
  readonly message: string;
  readonly credential?: CredentialRef;
}

export interface IdentityProviderSuccess {
  readonly ok: true;
  readonly actor: AuthenticatedActor;
}

export interface IdentityProvider {
  readonly providerId: string;
  readonly resolveActor: (input: IdentityProviderResolveInput) => Promise<IdentityProviderSuccess | IdentityProviderFailure>;
}

export interface GitCommitAuthor {
  readonly name: string;
  readonly email: string;
}

export function credentialKey(credential: CredentialRef): string {
  return `${credential.kind}\0${credential.issuer}\0${credential.subject}`;
}

export function actorStamp(actor: AuthenticatedActor): ActorStamp {
  return {
    personId: actor.personId,
    displayName: actor.displayName,
    ...(actor.primaryEmail ? { primaryEmail: actor.primaryEmail } : {}),
    providerId: actor.providerId,
    credential: actor.resolvedCredential
  };
}

export function actorStampJson(actor: AuthenticatedActor): JsonObject {
  const stamp = actorStamp(actor);
  return {
    personId: stamp.personId,
    displayName: stamp.displayName,
    ...(stamp.primaryEmail ? { primaryEmail: stamp.primaryEmail } : {}),
    providerId: stamp.providerId,
    credential: {
      kind: stamp.credential.kind,
      issuer: stamp.credential.issuer,
      subject: stamp.credential.subject
    }
  };
}

export function actorGitCommitAuthor(actor: AuthenticatedActor): GitCommitAuthor {
  const email = actor.primaryEmail?.trim();
  if (!email) throw new Error(`Actor ${actor.personId} requires primaryEmail for git author attribution.`);
  return {
    name: actor.displayName,
    email
  };
}
