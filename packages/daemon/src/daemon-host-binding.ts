/** @daemon-transport-authority Transport-derived actor and assignment binding. */
import os from "node:os";
import { hostCodedError } from "./daemon-host-errors.ts";
import {
  deriveRoleBindings,
  roleBindingActorMatches,
  roleBindingApplies,
  roleBindingExpired,
  type EntityRef,
} from "../../kernel/src/index.ts";
import { loadPeopleRoster } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import type { DaemonCommandClass, PeopleRoster } from "./identity/types.ts";
import { type RepoCellBinding } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export function localSystemBinding(
  rootDir: string,
  required: DaemonCommandClass = "repo-write",
  executor: RepoCellBinding["actor"]["executor"] = null,
): RepoCellBinding {
  const ownerUid = process.getuid?.();
  if (typeof ownerUid !== "number")
    throw hostCodedError("credential_unavailable", "Local system binding requires a Unix socket owner boundary.");
  const roster = loadPeopleRoster({ rootDir }),
    resolved = roster.resolveCredential(
      {
        kind: "unix-socket-owner-boundary",
        issuer: `host:${os.hostname()}`,
        subject: String(ownerUid),
      },
      "local-system/v1",
    );
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  const actor = { principal: { personId: resolved.actor.personId }, executor };
  return deriveLocalBinding(roster, actor, resolved.actor.roles, required);
}

function deriveLocalBinding(
  roster: PeopleRoster,
  actor: RepoCellBinding["actor"],
  roleIds: readonly string[],
  required: DaemonCommandClass,
  returnDeniedDocDetail = false,
): RepoCellBinding {
  const repositoryTarget: EntityRef = "settings/repository",
    evaluatedAt = new Date().toISOString(),
    roleBindings = [
      ...deriveRoleBindings({
        actor,
        roleIds,
        roleDeclarations: roster.roles,
        target: repositoryTarget,
      }),
      ...roster.bindings.filter(
        (candidate) => roleBindingActorMatches(candidate.actor, actor) && !roleBindingExpired(candidate, evaluatedAt),
      ),
    ],
    allowed = roleBindings.some((candidate) =>
      roleBindingApplies(candidate, actor, required, [repositoryTarget], evaluatedAt),
    );
  if (!allowed && !returnDeniedDocDetail)
    throw hostCodedError("rbac_forbidden", `Principal ${actor.principal.personId} lacks ${required}.`);
  return { actor, roleBindings, source: "local", docWriteAllowed: allowed };
}

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
  const actor = { principal: { personId: resolved.actor.personId }, executor };
  return deriveLocalBinding(roster, actor, resolved.actor.roles, required, returnDeniedDocDetail);
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
