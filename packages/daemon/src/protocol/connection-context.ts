import type {
  AcceptedConnectionEvidence,
  ConnectionGeneration,
  OsObservedPeerCredential
} from "../transport/auth-context.ts";
import type { AuthenticatedActor } from "../identity/types.ts";

export interface AcceptedConnectionBinding {
  readonly evidence: AcceptedConnectionEvidence;
  readonly connectionId: string;
  readonly connectionGeneration: ConnectionGeneration;
  readonly isActive: () => boolean;
  readonly assertActive: () => void;
}

export interface AuthorityConnectionContext {
  readonly schema: "authority-connection-context/v1";
  readonly connectionId: AcceptedConnectionEvidence["connectionId"];
  readonly connectionGeneration: ConnectionGeneration;
  readonly actor: AuthenticatedActor;
  readonly repoId: string;
  readonly channelBinding: AcceptedConnectionEvidence["channelBinding"];
  readonly peerCredential: OsObservedPeerCredential;
}

export type AuthorityConnectionUnavailableCode =
  | "connection_tuple_mismatch"
  | "connection_generation_closed"
  | "identity_or_repo_unavailable"
  | "peer_credential_unavailable"
  | "peer_policy_unavailable"
  | "peer_policy_mismatch";

export type AuthorityConnectionDispatch =
  | {
      readonly available: true;
      readonly context: AuthorityConnectionContext;
      readonly assertActive: () => void;
    }
  | {
      readonly available: false;
      readonly code: AuthorityConnectionUnavailableCode;
    };

export interface AuthorityConnectionRepo {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export type AuthorityPeerPolicy = (input: {
  readonly actor: AuthenticatedActor;
  readonly repo: AuthorityConnectionRepo;
  readonly peerCredential: OsObservedPeerCredential;
}) => boolean | Promise<boolean>;

export async function resolveAuthorityConnectionForRequest(input: {
  readonly acceptedConnection?: AcceptedConnectionBinding;
  readonly actor?: AuthenticatedActor;
  readonly repo?: AuthorityConnectionRepo;
  readonly peerPolicy?: AuthorityPeerPolicy;
}): Promise<AuthorityConnectionDispatch | undefined> {
  const acceptedConnection = input.acceptedConnection;
  if (!acceptedConnection) return undefined;
  const evidence = acceptedConnection.evidence;
  const tupleMatches = evidence.connectionId === acceptedConnection.connectionId
    && evidence.connectionGeneration === acceptedConnection.connectionGeneration
    && evidence.channelBinding.digest.byteLength === 32;
  const peerCredential = evidence.peerCredential;
  const policyAccepted = tupleMatches
    && acceptedConnection.isActive()
    && input.actor !== undefined
    && input.repo !== undefined
    && peerCredential.available
    && input.peerPolicy !== undefined
    ? await input.peerPolicy({
        actor: input.actor,
        repo: input.repo,
        peerCredential: peerCredential.value
      })
    : false;
  return resolveAuthorityConnectionDispatch({
    acceptedConnection,
    actor: input.actor,
    repoId: input.repo?.repoId,
    peerPolicyConfigured: input.peerPolicy !== undefined,
    peerPolicyAccepted: policyAccepted
  });
}

export function resolveAuthorityConnectionDispatch(input: {
  readonly acceptedConnection: AcceptedConnectionBinding;
  readonly actor?: AuthenticatedActor;
  readonly repoId?: string;
  readonly peerPolicyConfigured: boolean;
  readonly peerPolicyAccepted: boolean;
}): AuthorityConnectionDispatch {
  const tupleFailure = connectionTupleFailure(input.acceptedConnection);
  if (tupleFailure) return unavailable(tupleFailure);
  if (!connectionIsActive(input.acceptedConnection)) {
    return unavailable("connection_generation_closed");
  }
  if (!input.actor || !input.repoId) return unavailable("identity_or_repo_unavailable");
  const peerCredential = input.acceptedConnection.evidence.peerCredential;
  if (!peerCredential.available) return unavailable("peer_credential_unavailable");
  if (!input.peerPolicyConfigured) return unavailable("peer_policy_unavailable");
  if (!input.peerPolicyAccepted) return unavailable("peer_policy_mismatch");

  const evidence = input.acceptedConnection.evidence;
  const context = Object.freeze({
    schema: "authority-connection-context/v1" as const,
    connectionId: evidence.connectionId,
    connectionGeneration: evidence.connectionGeneration,
    actor: freezeActor(input.actor),
    repoId: input.repoId,
    channelBinding: evidence.channelBinding,
    peerCredential: Object.freeze({ ...peerCredential.value })
  });
  return Object.freeze({
    available: true as const,
    context,
    assertActive: () => assertAuthorityConnectionActive(input.acceptedConnection, context)
  });
}

function assertAuthorityConnectionActive(
  acceptedConnection: AcceptedConnectionBinding,
  context: AuthorityConnectionContext
): void {
  const tupleFailure = connectionTupleFailure(acceptedConnection);
  if (tupleFailure
    || context.connectionId !== acceptedConnection.connectionId
    || context.connectionGeneration !== acceptedConnection.connectionGeneration) {
    throw new Error("authority connection tuple does not match accepted connection evidence");
  }
  acceptedConnection.assertActive();
  if (!acceptedConnection.isActive()) {
    throw new Error("accepted connection generation is closed");
  }
}

function connectionTupleFailure(
  acceptedConnection: AcceptedConnectionBinding
): "connection_tuple_mismatch" | undefined {
  const evidence = acceptedConnection.evidence;
  return evidence.connectionId === acceptedConnection.connectionId
    && evidence.connectionGeneration === acceptedConnection.connectionGeneration
    && evidence.channelBinding.digest.byteLength === 32
    ? undefined
    : "connection_tuple_mismatch";
}

function connectionIsActive(acceptedConnection: AcceptedConnectionBinding): boolean {
  if (!acceptedConnection.isActive()) return false;
  try {
    acceptedConnection.assertActive();
    return true;
  } catch {
    return false;
  }
}

function freezeActor(actor: AuthenticatedActor): AuthenticatedActor {
  return Object.freeze({
    ...actor,
    resolvedCredential: Object.freeze({ ...actor.resolvedCredential })
  });
}

function unavailable(code: AuthorityConnectionUnavailableCode): AuthorityConnectionDispatch {
  return Object.freeze({ available: false, code });
}
