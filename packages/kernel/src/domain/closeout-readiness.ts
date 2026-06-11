export const closeoutReadinesses = [
  "not_required",
  "missing",
  "incomplete",
  "ready",
  "passed",
  "failed"
] as const;

export type CloseoutReadiness = typeof closeoutReadinesses[number];

export function isCloseoutReadiness(value: string): value is CloseoutReadiness {
  return (closeoutReadinesses as ReadonlyArray<string>).includes(value);
}
