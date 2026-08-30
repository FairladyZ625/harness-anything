/** @daemon-transport-authority Transport-derived actor and assignment binding. */
import os from "node:os";
import { hostCodedError } from "./daemon-host-errors.ts";
import { loadPeopleRoster } from "./identity/people-roster.ts";
import { makeTransportDerivedIdentityProvider } from "./identity/transport-derived-provider.ts";
import { type RepoCellBinding } from "./repo-cell.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { declaredRoleBindingsForActor } from "./identity/declared-role-binding-projection.ts";

export function localSystemBinding(
  rootDir: string,
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
  return deriveLocalBinding(rootDir, actor);
}

function deriveLocalBinding(rootDir: string, actor: RepoCellBinding["actor"]): RepoCellBinding {
  return { actor, roleBindings: declaredRoleBindingsForActor(rootDir, actor), source: "local" };
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
    return {
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
    };
  }
  const roster = loadPeopleRoster({ rootDir });
  const resolved = await makeTransportDerivedIdentityProvider(roster).resolveActor({
    authContext: auth,
    command: { method: "repo.task.run", namespace: "repo", requiresRepo: true },
  });
  if (!resolved.ok) throw hostCodedError(resolved.code, resolved.message);
  const actor = { principal: { personId: resolved.actor.personId }, executor };
  return deriveLocalBinding(rootDir, actor);
}
