/** @daemon-transport-authority Transport-derived actor and assignment binding. */
import { hostCodedError } from "./daemon-host-errors.ts";
import { loadPeopleRoster } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import type { DaemonCommandClass } from "./identity/types.ts";
import { type RepoCellBinding } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export const localRepairBinding: RepoCellBinding = {
  actor: { principal: { personId: "daemon-local-repair" }, executor: null },
  roles: ["$admin"],
  source: "local",
};

export async function binding(
  rootDir: string,
  auth: DaemonAuthenticationContext,
  required: DaemonCommandClass,
  returnDeniedDocDetail = false,
  executor: RepoCellBinding["actor"]["executor"] = null,
): Promise<RepoCellBinding> {
  if (auth.assignmentBinding) {
    if (required === "admin" || required === "arbiter")
      throw hostCodedError("rbac_forbidden", `Assignment ingress cannot perform ${required}.`);
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
    return {
      actor: auth.assignmentBinding.actor,
      source: {
        kind: "assignment",
        nodeId: auth.assignmentBinding.nodeId,
        assignmentId: auth.assignmentBinding.assignmentId,
      },
      docWriteAllowed: true,
      assignmentScope: {
        repoId: auth.assignmentBinding.repoId,
        scope,
      },
      ...(auth.writerEpoch === undefined ? {} : { writerEpoch: auth.writerEpoch }),
      ...(auth.assertWriterEpoch ? { assertWriterEpoch: auth.assertWriterEpoch } : {}),
      ...(auth.withWriterEpochFence ? { withWriterEpochFence: auth.withWriterEpochFence } : {}),
    };
  }
  const roster = loadPeopleRoster({ rootDir });
  const resolved = await makeTransportDerivedIdentityProvider(roster).resolveActor({
    authContext: auth,
    command:
      required === "admin"
        ? {
            method: "daemon.repo.admin",
            namespace: "admin",
            requiresRepo: true,
          }
        : { method: "repo.task.run", namespace: "repo", requiresRepo: true },
  });
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  const allowed = resolved.actor.roles.some((role) => roster.roleAllows(role, required));
  if (!allowed && !returnDeniedDocDetail) {
    throw hostCodedError("rbac_forbidden", `Principal ${resolved.actor.personId} lacks ${required}.`);
  }
  return {
    actor: { principal: { personId: resolved.actor.personId }, executor },
    roles: [
      ...resolved.actor.roles,
      ...(resolved.actor.roles.some((role) => roster.roleAllows(role, "arbiter")) ? ["$arbiter"] : []),
      ...(resolved.actor.roles.some((role) => roster.roleAllows(role, "admin")) ? ["$admin"] : []),
    ],
    source: "local",
    docWriteAllowed: allowed,
  };
}

export function declaredExecutor(value: unknown): RepoCellBinding["actor"]["executor"] {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw hostCodedError("invalid_executor", "Executor must be null or an agent declaration.");
  const record = value as Record<string, unknown>,
    id = typeof record.id === "string" ? record.id.trim() : "";
  if (
    record.kind !== "agent" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) ||
    Object.keys(record).some((field) => field !== "kind" && field !== "id")
  )
    throw hostCodedError("invalid_executor", 'Executor must be { kind: "agent", id: string }.');
  return { kind: "agent", id };
}
