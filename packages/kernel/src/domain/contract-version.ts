import { consumeKnownError } from "../error-consumption.ts";

export type ContractVersion = Readonly<{ major: number; minor: number }>;

export function contractVersion(major: number, minor: number): ContractVersion {
  if (!Number.isSafeInteger(major) || major < 0 || !Number.isSafeInteger(minor) || minor < 0)
    throw new Error("contract version components must be non-negative safe integers");
  return Object.freeze({ major, minor });
}

export const CONTRACT_VERSION_1_0 = contractVersion(1, 0);

export function isContractVersion(value: unknown): value is ContractVersion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(candidate).length === 2 &&
    Number.isSafeInteger(candidate.major) &&
    (candidate.major as number) >= 0 &&
    Number.isSafeInteger(candidate.minor) &&
    (candidate.minor as number) >= 0
  );
}

/** A producer may serve consumers from the same major at or below its supported minor. */
export function isContractVersionCompatible(requested: unknown, supported: ContractVersion): boolean {
  return isContractVersion(requested) && requested.major === supported.major && requested.minor <= supported.minor;
}

export function serializeContractVersion(version: ContractVersion): string {
  return JSON.stringify(version);
}

export function parseContractVersion(value: string | null | undefined): ContractVersion | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isContractVersion(parsed) ? contractVersion(parsed.major, parsed.minor) : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
