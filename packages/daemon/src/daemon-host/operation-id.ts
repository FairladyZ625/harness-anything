import { normalizeCommandEnvelope, sha256Text, stableStringify, type ActorIdentity } from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/**
 * The center's canonical command identity: a content + target-revision digest, not the transport
 * request id. Retries of the same command at the same target revision replay this event.
 */
export function operationId(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  workspaceId: string,
  expectedRevision: number,
): string {
  const {
    actor: _actor,
    source: _source,
    root: _root,
    workspaceId: _workspace,
    serverWorkspaceId: _server,
    ...intent
  } = action;
  return normalizeCommandEnvelope({
    workspaceId,
    actor: binding.actor,
    source: binding.source,
    expectedRevision,
    command: intent,
  }).opId;
}

export function witnessOperationId(
  intent: Readonly<Record<string, unknown>>,
  actor: ActorIdentity,
  workspaceId: string,
): string {
  return `op_${sha256Text(stableStringify({ workspaceId, actor, command: intent }))}`;
}

export function actorHint(actor: ActorIdentity): string {
  return [
    "personId=",
    `${actor.principal.personId}`,
    ", executor=",
    `${actor.executor === null ? "none" : `${actor.executor.kind}:${actor.executor.id}`}`,
    "",
  ].join("");
}
