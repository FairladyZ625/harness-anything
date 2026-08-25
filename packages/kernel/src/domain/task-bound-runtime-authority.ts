import { stableStringify } from "../integrity/stable-hash.ts";
import type { RuntimeSession } from "./agent-runtime.ts";
import { isSamePerson } from "./actor-domain-services.ts";
import type { LeaseV1 } from "./execution.ts";
import type { ActorIdentity, WriteSource } from "./write-chain.contract.ts";

export interface LiveTaskBoundRuntimeBinding {
  readonly runtimeSessionId: string;
  readonly taskId: string;
  readonly executionId: string;
}

export function runtimeSessionIdFromActor(actor: ActorIdentity): string | null {
  const id = actor.executor?.kind === "agent" ? actor.executor.id : "",
    prefix = "runtime-session:";
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : null;
}

/** The handoff edge is the authenticated executor relation for a live runtime. */
export function runtimeSessionExecutesTask(
  session: RuntimeSession | null,
  taskId: string,
  executionId: string,
): boolean {
  return (
    session?.liveness === "live" &&
    session.taskBindings.some((binding) => binding.taskId === taskId && binding.executionId === executionId)
  );
}

/** Resolves authority only from a canonical live runtime-session projection. */
export function resolveLiveTaskBoundRuntimeBinding(
  session: RuntimeSession | null,
  taskId: string,
  executionId: string,
): LiveTaskBoundRuntimeBinding | null {
  if (
    session?.liveness !== "live" ||
    !session.taskBindings.some((binding) => binding.taskId === taskId && binding.executionId === executionId)
  )
    return null;
  return { runtimeSessionId: session.runtimeSessionId, taskId, executionId };
}

export function isTaskBoundRuntimeWriter(
  lease: LeaseV1,
  actor: ActorIdentity,
  source: WriteSource,
  binding: LiveTaskBoundRuntimeBinding,
): boolean {
  return (
    lease.taskId === binding.taskId &&
    lease.executionId === binding.executionId &&
    isSamePerson(lease.actor, actor) &&
    stableStringify(lease.source) === stableStringify(source) &&
    runtimeSessionIdFromActor(actor) === binding.runtimeSessionId
  );
}
