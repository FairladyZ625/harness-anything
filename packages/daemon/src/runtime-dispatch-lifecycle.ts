import { randomUUID } from "node:crypto";
import type { DispatchLifecycleEvent, DispatchOwnerFence } from "@harness-anything/kernel";
import type { RuntimeSpawnerContext } from "./runtime-spawn-context.ts";
import type { ActiveRuntime, RuntimeBinding } from "./runtime-spawn-types.ts";

type LifecycleEventFields = { readonly type: DispatchLifecycleEvent["type"]; readonly [key: string]: unknown };

/** Emit one fenced lifecycle observation through the existing RuntimeSession Action writer. */
export async function publishDispatchLifecycle(
  context: RuntimeSpawnerContext,
  input: {
    readonly runtimeSessionId: string;
    readonly dispatchId: string;
    readonly attemptGroupId: string;
    readonly expectedGroupVersion: number;
    readonly binding: RuntimeBinding;
    readonly fields: LifecycleEventFields;
    readonly ownerFence?: DispatchOwnerFence | null;
    readonly eventId?: string;
  },
): Promise<DispatchLifecycleEvent | null> {
  const descriptor = input.binding.writerEpochFence ?? context.input.writerEpochFence?.() ?? null,
    ownerFence =
      input.ownerFence === undefined
        ? descriptor
          ? { ownerId: descriptor.holderId, epoch: descriptor.epoch }
          : null
        : input.ownerFence;
  if (ownerFence === null && input.fields.type !== "group_imported")
    throw Object.assign(new Error("Dispatch lifecycle admission requires the center writer epoch fence."), {
      code: "dispatch_lifecycle_fence_required",
    });
  const lifecycle = {
    schema: "dispatch-lifecycle-event/v1" as const,
    source: context.input.remote ? ("edge" as const) : ("center" as const),
    eventId: input.eventId ?? `dispatch-lifecycle:${input.dispatchId}:${input.expectedGroupVersion}:${randomUUID()}`,
    repoId: context.input.repoId,
    attemptGroupId: input.attemptGroupId,
    dispatchId: input.dispatchId,
    expectedGroupVersion: input.expectedGroupVersion,
    ownerFence,
    ...input.fields,
  } as DispatchLifecycleEvent;
  const publication = await context.publishRuntimeEvent(
    "runtime_dispatch_lifecycle_observed",
    { runtimeSessionId: input.runtimeSessionId, lifecycle },
    lifecycle.eventId,
    input.binding,
  );
  return publication.event ? lifecycle : null;
}

export async function publishActiveDispatchLifecycle(
  context: RuntimeSpawnerContext,
  active: Pick<
    ActiveRuntime,
    "runtimeSessionId" | "dispatchId" | "binding" | "lifecycleAttemptGroupId" | "lifecycleVersion"
  >,
  fields: LifecycleEventFields,
): Promise<DispatchLifecycleEvent | null> {
  if (active.lifecycleAttemptGroupId === null || active.lifecycleVersion === null) return null;
  const event = await publishDispatchLifecycle(context, {
    runtimeSessionId: active.runtimeSessionId,
    dispatchId: active.dispatchId,
    attemptGroupId: active.lifecycleAttemptGroupId,
    expectedGroupVersion: active.lifecycleVersion,
    binding: active.binding,
    fields,
  });
  if (event) active.lifecycleVersion += 1;
  return event;
}

export function lifecycleAttemptGroupId(active: Pick<ActiveRuntime, "dispatchId" | "fallbackAttempt">): string {
  return active.fallbackAttempt?.attemptGroupId ?? active.dispatchId;
}
