import type { RuntimeSpawnerInput } from "./runtime-spawn-types.ts";

type RuntimeOwnershipInput = Pick<RuntimeSpawnerInput, "repoId" | "runtimeNode">;

const owners = new Map<string, symbol>();

function ownershipKey(input: RuntimeOwnershipInput, runtimeSessionId: string): string {
  return JSON.stringify([input.repoId, input.runtimeNode?.nodeId ?? null, runtimeSessionId]);
}

/** Reserves a session before its center-visible start event can trigger recovery in another context. */
export function claimRuntimeOwnership(input: RuntimeOwnershipInput, runtimeSessionId: string): symbol | null {
  const key = ownershipKey(input, runtimeSessionId);
  if (owners.has(key)) return null;
  const token = Symbol(key);
  owners.set(key, token);
  return token;
}

export function releaseRuntimeOwnership(input: RuntimeOwnershipInput, runtimeSessionId: string, token: symbol): void {
  const key = ownershipKey(input, runtimeSessionId);
  if (owners.get(key) === token) owners.delete(key);
}

export function runtimeOwnershipHeld(input: RuntimeOwnershipInput, runtimeSessionId: string): boolean {
  return owners.has(ownershipKey(input, runtimeSessionId));
}
