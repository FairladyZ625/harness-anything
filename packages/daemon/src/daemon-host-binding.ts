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
): RepoCellBinding {
  if (!auth.oidcPrincipal || auth.oidcPrincipal.expiresAt <= Date.now())
    throw hostCodedError("authentication_required", "Sign in with Keycloak before performing this action.");
  return withSessionEnvironment(
    {
      actor: { principal: { personId: auth.oidcPrincipal.personId }, executor },
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
  const assignment = auth.assignmentBinding!,
    owner = auth.nodePrincipal,
    legacy = assignment as typeof assignment & {
      readonly taskId?: string;
      readonly executionId?: string;
      readonly paths?: readonly string[];
    },
    scope =
      assignment.scope ??
      (legacy.taskId && legacy.executionId && legacy.paths
        ? { kind: "task" as const, taskId: legacy.taskId, executionId: legacy.executionId, paths: legacy.paths }
        : undefined);
  if (!scope)
    throw hostCodedError("assignment_scope_mismatch", "Assignment ingress requires a valid task or Schedule scope.");
  if (!owner || owner.nodeId !== assignment.nodeId || !auth.keycloakCenter)
    throw hostCodedError(
      "authentication_required",
      `Fleet ingress requires node ${assignment.nodeId} to have an owner registered at the center.`,
    );
  if (auth.oidcPrincipal && auth.oidcPrincipal.personId !== owner.personId)
    throw hostCodedError("human_confirmation_required", "The interactive session belongs to a different node owner.");
  return {
    actor: { principal: { personId: owner.personId }, executor: null },
    source: { kind: "assignment", nodeId: owner.nodeId, assignmentId: assignment.assignmentId },
    assignmentScope: { repoId: assignment.repoId, scope },
    keycloakAuthorization:
      auth.oidcPrincipal?.personId === owner.personId
        ? {
            session: {
              personId: owner.personId,
              accessToken: auth.oidcPrincipal.accessToken,
              ...auth.oidcPrincipal.authority,
            },
          }
        : { center: await auth.keycloakCenter() },
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
): Promise<RepoCellBinding> {
  if (auth.assignmentBinding) return nodeOwnerBinding(auth);
  if (auth.oidcPrincipal && auth.oidcPrincipal.expiresAt > Date.now()) return localDefaultBinding(auth, executor);
  return localDefaultBinding(auth, executor);
}
