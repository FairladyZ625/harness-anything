import type { RuntimeAuthReadiness } from "./agent-runtime-instance-types.ts";

// Primitive runtime-instance readers and error constructors. They live below both the
// launch-config reader and the instance-config reader so neither has to import the other.
export function requiredRuntimeInstanceText(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length) return value.trim();
  throw runtimeInstanceError("invalid_runtime_instance", `${field} is required.`);
}

export function identifier(value: unknown, field: string): string {
  const text = requiredRuntimeInstanceText(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(text))
    throw runtimeInstanceError("invalid_runtime_instance", `${field} is invalid.`);
  return text;
}

export function isRuntimeInstanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runtimeInstanceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function available(): RuntimeAuthReadiness {
  return { status: "ready", code: null, hint: null };
}

export function unavailable(code: string, hint: string): RuntimeAuthReadiness {
  return { status: "not-ready", code, hint };
}
