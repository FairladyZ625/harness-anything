import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { VcsCommitAuthor } from "@harness-anything/kernel";

export type PersonId = string;
export type RoleId = string;

export type CredentialKind =
  | "unix-socket-owner-boundary"
  | "windows-named-pipe-client"
  | "ssh-username"
  | "ssh-forced-command-person"
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
  /** Legacy combined people.yaml metadata. Split identity data keeps this in persons.yaml. */
  readonly displayName?: string;
  readonly primaryEmail?: string;
  readonly roles: ReadonlyArray<RoleId>;
  readonly credentials: ReadonlyArray<CredentialRef>;
  /** Legacy combined people.yaml metadata. Split identity data keeps this in persons.yaml. */
  readonly disabled?: boolean;
}

export interface PersonRecord {
  readonly personId: PersonId;
  readonly displayName: string;
  readonly disabled?: boolean;
}

export interface PersonRegistry {
  readonly schema: "harness-persons/v1";
  readonly people: ReadonlyArray<PersonRecord>;
  readonly find: (personId: PersonId) => PersonRecord | undefined;
}

export interface RolePolicy {
  readonly roleId: RoleId;
  readonly commandClasses: ReadonlyArray<DaemonCommandClass>;
}

export interface PeopleRoster {
  readonly schema: "harness-people/v1";
  readonly people: ReadonlyArray<PersonProfile>;
  readonly roles: ReadonlyArray<RolePolicy>;
  readonly resolveCredential: (credential: CredentialRef, providerId: string) => IdentityAuthenticationResult;
  readonly roleAllows: (roleId: RoleId, commandClass: DaemonCommandClass) => boolean;
}

export interface AuthenticatedActor {
  readonly personId: PersonId;
  readonly displayName: string;
  readonly primaryEmail?: string;
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

export type IdentityEvidence = DaemonAuthenticationContext;

export type IdentityProviderFailureCode =
  | "credential_unavailable"
  | "credential_unknown"
  | "person_unregistered"
  | "person_disabled"
  | "person_registry_unavailable"
  | "provider_unavailable"
  | "malformed_credential";

export interface IdentityProviderFailure {
  readonly ok: false;
  readonly code: IdentityProviderFailureCode;
  readonly providerId: string;
  readonly message: string;
  readonly credential?: CredentialRef;
}

export interface IdentityAuthenticationSuccess {
  readonly ok: true;
  readonly personId: PersonId;
  readonly providerId: string;
  readonly credential: CredentialRef;
  readonly primaryEmail?: string;
}

export type IdentityAuthenticationResult = IdentityAuthenticationSuccess | IdentityProviderFailure;

export interface IdentityAuthorizationAction {
  readonly method: string;
  readonly commandClass?: DaemonCommandClass;
}

export interface IdentityAuthorizationResource {
  readonly repoId?: string;
  readonly canonicalRoot?: string;
}

export interface IdentityAuthorizationInput {
  readonly personId: PersonId;
  readonly action: IdentityAuthorizationAction;
  readonly resource?: IdentityAuthorizationResource;
}

export interface IdentityAuthorizationSuccess {
  readonly ok: true;
}

export interface IdentityAuthorizationFailure {
  readonly ok: false;
  readonly code: "rbac_forbidden" | "command_class_missing";
  readonly message: string;
}

export type IdentityAuthorizationDecision = IdentityAuthorizationSuccess | IdentityAuthorizationFailure;

export interface AuthenticationProvider {
  readonly providerId: string;
  readonly authenticate: (evidence: IdentityEvidence) => Promise<IdentityAuthenticationResult>;
}

export interface AuthorizationProvider {
  readonly authorize: (input: IdentityAuthorizationInput) => Promise<IdentityAuthorizationDecision>;
}

/** The only identity contract consumed by daemon core: authenticate, then authorize. */
export interface IdentityProvider extends AuthenticationProvider, AuthorizationProvider {}

export function composeIdentityProvider(
  authentication: AuthenticationProvider,
  authorization: AuthorizationProvider
): IdentityProvider {
  return {
    providerId: authentication.providerId,
    authenticate: (evidence) => authentication.authenticate(evidence),
    authorize: (input) => authorization.authorize(input)
  };
}

export interface IdentityAdminSnapshot {
  readonly people: ReadonlyArray<{
    readonly personId: PersonId;
    readonly displayName: string;
    readonly primaryEmail?: string;
    readonly roles: ReadonlyArray<RoleId>;
    readonly disabled: boolean;
    readonly credentials: ReadonlyArray<CredentialRef>;
  }>;
  readonly roles: ReadonlyArray<RolePolicy>;
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

export function actorGitCommitAuthor(actor: AuthenticatedActor): VcsCommitAuthor {
  const email = actor.primaryEmail?.trim();
  if (!email) throw new Error(`Actor ${actor.personId} requires primaryEmail for git author attribution.`);
  return {
    name: actor.displayName,
    email
  };
}
