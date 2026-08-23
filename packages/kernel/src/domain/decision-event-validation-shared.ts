import { isNonEmptyString } from "./write-chain.contract.ts";

export function includes<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

export function decisionId(value: unknown): value is string {
  return typeof value === "string" && /^dec_[A-Za-z0-9_-]+$/u.test(value);
}

export function optionId(value: unknown, prefix: "CH" | "RJ"): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${prefix}[A-Za-z0-9_-]+$`, "u").test(value)
  );
}

export function claimId(value: unknown): value is string {
  return typeof value === "string" && /^C[A-Za-z0-9_-]+$/u.test(value);
}

export function uniqueFactStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}
