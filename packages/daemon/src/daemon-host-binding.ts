/** @daemon-transport-authority Transport-derived actor binding for local sessions and fleet nodes. */
import { actionDeclarations } from "@harness-anything/kernel";
import { hostCodedError } from "./daemon-host-errors.ts";
import { type RepoCellBinding } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { withWriterEpochFenceDescriptor, type WriterEpochFenceDescriptor } from "./writer-epoch.ts";

export function localSystemBinding(
  _rootDir: string,
  executor: RepoCellBinding["actor"]["executor"] = null,
): RepoCellBinding {
  const ownerUid = process.getuid?.();
  // Named pipes do not expose a POSIX UID on Windows; use a stable Windows owner value there only.
  if (typeof ownerUid !== "number" && process.platform !== "win32")
    throw hostCodedError("credential_unavailable", "Local system binding requires a Unix socket owner boundary.");
  return defaultLocalBinding(ownerUid ?? 0, executor);
}

/** Daemon socket-owner authority for actions whose declaration keeps all writes outside a repository cell. */
export async function localSystemActionBinding(
  rootDir: string,
  kind: string,
  auth: DaemonAuthenticationContext,
  principalBinding: () => Promise<RepoCellBinding>,
): Promise<RepoCellBinding> {
  const declaration = actionDeclarations.find((candidate) => candidate.kind === kind);
  if (!declaration || declaration.residency.scope === "canonical")
    throw hostCodedError("authentication_required", `Action ${kind} requires an authenticated repository principal.`);
  const daemonUid = process.getuid?.(),
    ownerUid = auth.unixSocketOwnerBoundary?.ownerUid,
    isDaemonSocketOwner =
      auth.transportKind === "unix-socket" &&
      typeof ownerUid === "number" &&
      (typeof daemonUid === "number" ? ownerUid === daemonUid : process.platform === "win32" && ownerUid === 0);
  return isDaemonSocketOwner ? defaultLocalBinding(ownerUid!, null) : principalBinding();
}

export function withDaemonWriterEpochFence(
  binding: RepoCellBinding,
  descriptor: WriterEpochFenceDescriptor,
): RepoCellBinding {
  if (binding.writerEpochFence) return binding;
  return {
    ...binding,
    writerEpoch: descriptor.epoch,
    withWriterEpochFence: <T>(operation: () => T) => withWriterEpochFenceDescriptor(descriptor, operation),
    writerEpochFence: descriptor,
  };
}

function defaultLocalBinding(ownerUid: number, executor: RepoCellBinding["actor"]["executor"]): RepoCellBinding {
  return {
    actor: { principal: { personId: `local-user-${ownerUid}` }, executor },
    daemonSocketOwner: true,
    source: "local",
  };
}

/** Bind daemon-global local actions when no repository exists to provide an authored RBAC projection. */
export function localDefaultBinding(
  auth: DaemonAuthenticationContext,
  executor: RepoCellBinding["actor"]["executor"] = null,
  replicaRead = false,
): RepoCellBinding {
  const replicaPrincipal =
    replicaRead && auth.replicaReadPrincipal && auth.replicaReadPrincipal.sessionExpiresAt > Date.now()
      ? auth.replicaReadPrincipal
      : undefined;
  if (replicaPrincipal) auth = { ...auth, oidcPrincipal: undefined };
  else if (!auth.oidcPrincipal || auth.oidcPrincipal.expiresAt <= Date.now())
    throw hostCodedError("authentication_required", "Sign in with Keycloak before performing this action.");
  return withSessionEnvironment(
    {
      ...(auth.oidcPrincipal
        ? { actor: { principal: { personId: auth.oidcPrincipal.personId }, executor } }
        : { actor: { principal: { personId: replicaPrincipal!.personId }, executor } }),
      source: "local",
    },
    auth,
  );
}

function withSessionEnvironment(binding: RepoCellBinding, auth: DaemonAuthenticationContext): RepoCellBinding {
  return {
    ...binding,
    ...(auth.sessionEnvironment === undefined ? {} : { sessionEnvironment: auth.sessionEnvironment }),
    ...(auth.oidcPrincipal === undefined
      ? {}
      : {
          keycloakAuthorization: {
            session: {
              personId: auth.oidcPrincipal.personId,
              accessToken: auth.oidcPrincipal.accessToken,
              ...(auth.localSessionAccessToken ? { currentAccessToken: auth.localSessionAccessToken } : {}),
              url: auth.oidcPrincipal.authority.url,
              realm: auth.oidcPrincipal.authority.realm,
              clientId: auth.oidcPrincipal.authority.clientId,
            },
          },
        }),
  };
}

/**
 * A fleet connection authenticates a machine only. The person it acts for is the node's registered
 * owner, and that person answers to the same Keycloak grants as when signed in locally.
 */
async function nodeOwnerBinding(auth: DaemonAuthenticationContext): Promise<RepoCellBinding> {
  const owner = auth.nodePrincipal;
  if (!owner || !owner.nodeId || !auth.keycloakCenter)
    throw hostCodedError(
      "authentication_required",
      "Fleet ingress requires a registered node owner and center authority.",
    );
  if (auth.oidcPrincipal && auth.oidcPrincipal.personId !== owner.personId)
    throw hostCodedError("human_confirmation_required", "The interactive session belongs to a different node owner.");
  return {
    actor: { principal: { personId: owner.personId }, executor: null },
    source: { kind: "node", nodeId: owner.nodeId },
    keycloakAuthorization:
      auth.oidcPrincipal?.personId === owner.personId
        ? {
            session: {
              personId: owner.personId,
              accessToken: auth.oidcPrincipal.accessToken,
              ...auth.oidcPrincipal.authority,
            },
          }
        : { center: auth.keycloakCenter },
    ...(auth.sessionEnvironment === undefined ? {} : { sessionEnvironment: auth.sessionEnvironment }),
    ...(auth.writerEpoch === undefined ? {} : { writerEpoch: auth.writerEpoch }),
    ...(auth.withWriterEpochFence ? { withWriterEpochFence: auth.withWriterEpochFence } : {}),
    ...(auth.writerEpochFence ? { writerEpochFence: auth.writerEpochFence } : {}),
  };
}

export async function binding(
  _rootDir: string,
  auth: DaemonAuthenticationContext,
  executor: RepoCellBinding["actor"]["executor"] = null,
  replicaRead = false,
): Promise<RepoCellBinding> {
  if (auth.transportKind === "fleet-tls") return nodeOwnerBinding(auth);
  if (replicaRead) return localDefaultBinding(auth, executor, true);
  return localDefaultBinding(auth, executor);
}
