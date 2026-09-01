/** @daemon-transport-authority Transport-derived actor and assignment binding. */
import os from "node:os";
import { hostCodedError } from "./daemon-host-errors.ts";
import { loadPeopleRosterIfPresent } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import { type RepoCellBinding } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { declaredRoleBindingsForActor } from "./identity/declared-role-binding-projection.ts";

export function localSystemBinding(
  rootDir: string,
  executor: RepoCellBinding["actor"]["executor"] = null,
): RepoCellBinding {
  const ownerUid = process.getuid?.();
  // Named pipes do not expose a POSIX UID on Windows; use a stable Windows owner value there only.
  if (typeof ownerUid !== "number" && process.platform !== "win32")
    throw hostCodedError("credential_unavailable", "Local system binding requires a Unix socket owner boundary.");
  const stableOwnerUid = ownerUid ?? 0;
  const roster = loadPeopleRosterIfPresent({ rootDir });
  if (roster === null) return defaultLocalBinding(stableOwnerUid, executor);
  const resolved = roster.resolveCredential(
    {
      kind: "unix-socket-owner-boundary",
      issuer: `host:${os.hostname()}`,
      subject: String(stableOwnerUid),
    },
    "local-system/v1",
  );
  if (!resolved.ok) {
    if (resolved.code === "credential_unknown") return defaultLocalBinding(stableOwnerUid, executor);
    throw hostCodedError(resolved.code, resolved.message);
  }
  const actor = { principal: { personId: resolved.actor.personId }, executor };
  return deriveLocalBinding(rootDir, actor);
}

function deriveLocalBinding(rootDir: string, actor: RepoCellBinding["actor"]): RepoCellBinding {
  return {
    actor,
    roleBindings: declaredRoleBindingsForActor(rootDir, actor) ?? [],
    authorizationBindingMode: "declared",
    source: "local",
  };
}

function defaultLocalBinding(ownerUid: number, executor: RepoCellBinding["actor"]["executor"]): RepoCellBinding {
  return {
    actor: { principal: { personId: `local-user-${ownerUid}` }, executor },
    authorizationBindingMode: "default",
    source: "local",
  };
}

/** Bind daemon-global local actions when no repository exists to provide an authored RBAC projection. */
export function localDefaultBinding(
  auth: DaemonAuthenticationContext,
  executor: RepoCellBinding["actor"]["executor"] = null,
): RepoCellBinding {
  const ownerUid = auth.unixSocketOwnerBoundary?.ownerUid;
  if (auth.transportKind !== "unix-socket" || typeof ownerUid !== "number")
    throw hostCodedError("credential_unavailable", "Local default binding requires a Unix socket owner boundary.");
  return withSessionEnvironment(defaultLocalBinding(ownerUid, executor), auth);
}

function withSessionEnvironment(binding: RepoCellBinding, auth: DaemonAuthenticationContext): RepoCellBinding {
  return auth.sessionEnvironment === undefined ? binding : { ...binding, sessionEnvironment: auth.sessionEnvironment };
}

export async function binding(
  rootDir: string,
  auth: DaemonAuthenticationContext,
  executor: RepoCellBinding["actor"]["executor"] = null,
): Promise<RepoCellBinding> {
  if (auth.assignmentBinding) {
    const legacy = auth.assignmentBinding as typeof auth.assignmentBinding & {
        readonly taskId?: string;
        readonly executionId?: string;
        readonly paths?: readonly string[];
      },
      scope =
        auth.assignmentBinding.scope ??
        (legacy.taskId && legacy.executionId && legacy.paths
          ? { kind: "task" as const, taskId: legacy.taskId, executionId: legacy.executionId, paths: legacy.paths }
          : undefined);
    if (!scope)
      throw hostCodedError("assignment_scope_mismatch", "Assignment ingress requires a valid task or Schedule scope.");
    return withSessionEnvironment(
      {
        actor: auth.assignmentBinding.actor,
        source: {
          kind: "assignment",
          nodeId: auth.assignmentBinding.nodeId,
          assignmentId: auth.assignmentBinding.assignmentId,
        },
        assignmentScope: {
          repoId: auth.assignmentBinding.repoId,
          scope,
        },
        ...(auth.writerEpoch === undefined ? {} : { writerEpoch: auth.writerEpoch }),
        ...(auth.assertWriterEpoch ? { assertWriterEpoch: auth.assertWriterEpoch } : {}),
        ...(auth.withWriterEpochFence ? { withWriterEpochFence: auth.withWriterEpochFence } : {}),
        ...(auth.writerEpochFence ? { writerEpochFence: auth.writerEpochFence } : {}),
      },
      auth,
    );
  }
  const roster = loadPeopleRosterIfPresent({ rootDir });
  if (roster === null) return localDefaultBinding(auth, executor);
  const resolved = await makeTransportDerivedIdentityProvider(roster).resolveActor({
    authContext: auth,
    command: { method: "repo.task.run", namespace: "repo", requiresRepo: true },
  });
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  const actor = { principal: { personId: resolved.actor.personId }, executor };
  return withSessionEnvironment(deriveLocalBinding(rootDir, actor), auth);
}
