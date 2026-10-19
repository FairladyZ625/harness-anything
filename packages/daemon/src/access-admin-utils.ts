import type { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";

export function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function requiredUserId(adapter: KeycloakPolicyAdapter, token: string, personId: string): Promise<string> {
  const userId = await adapter.findUserId(token, personId);
  if (!userId) throw coded("access_person_unknown", `No Keycloak account carries Harness person ${personId}.`);
  return userId;
}

export function names(value: readonly unknown[] | undefined, field: string): readonly string[] | undefined {
  if (value?.some((item) => typeof item !== "string"))
    throw coded("access_request_invalid", `Access administration requires ${field} to list names.`);
  return value as readonly string[] | undefined;
}

export function text(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw coded("access_request_invalid", `Access administration requires ${field}.`);
  return value;
}

export function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
