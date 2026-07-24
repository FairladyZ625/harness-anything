import type {
  TaskHolderCredential,
  TaskHolderExecutor,
  TaskHolderPersonPrincipal,
  TaskHolderPrincipal
} from "./task-holder-state.ts";

export function taskHolderPrincipalFromActor(input: {
  readonly personId: string;
  readonly displayName?: string;
  readonly primaryEmail?: string;
  readonly providerId?: string;
  readonly resolvedCredential?: TaskHolderCredential;
}, options: { readonly executor?: TaskHolderExecutor | null } = {}): TaskHolderPrincipal {
  const principal = {
    personId: input.personId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.primaryEmail ? { primaryEmail: input.primaryEmail } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.resolvedCredential ? { credential: input.resolvedCredential } : {})
  };
  return taskHolderActor(principal, options.executor ?? null);
}

export function taskHolderExecutorFromJournalActor(input: {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}): TaskHolderExecutor | null {
  if (input.kind === "system") {
    throw new Error(
      "system actor cannot be projected to a direct-human task holder; use an agent executor with a person principal"
    );
  }
  return input.kind === "agent" ? { kind: "agent", id: input.id } : null;
}

export function taskHolderActor(
  principal: TaskHolderPersonPrincipal,
  executor: TaskHolderExecutor | null
): TaskHolderPrincipal {
  return {
    principal,
    executor,
    responsibleHuman: `person:${principal.personId}`
  };
}

export function runtimeEventActorFromTaskHolderPrincipal(input: TaskHolderPrincipal): {
  readonly principal: { readonly kind: "person"; readonly personId: string };
  readonly executor: TaskHolderExecutor | null;
} {
  return {
    principal: { kind: "person", personId: input.principal.personId },
    executor: input.executor
  };
}
