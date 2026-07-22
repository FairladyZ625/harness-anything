export interface ProjectHarnessExecutionSettings {
  readonly consentTtlMs?: number;
}

export interface ProjectHarnessAdapterSettings {
  readonly multica?: {
    readonly staleTtlMs?: number;
  };
}

export const DEFAULT_EXECUTION_CONSENT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MULTICA_STALE_TTL_MS = 5 * 60 * 1_000;

export function resolvePositiveIntegerValue(input: {
  readonly envName: string;
  readonly envValue: string | undefined;
  readonly yamlValue: number | undefined;
  readonly defaultValue: number;
}): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  if (input.envValue !== undefined) {
    const parsed = positiveInteger(input.envValue.trim());
    if (parsed === undefined) {
      return { ok: false, message: `${input.envName} must be a positive integer in milliseconds.` };
    }
    return { ok: true, value: parsed };
  }
  return { ok: true, value: input.yamlValue ?? input.defaultValue };
}

export function validatePositiveIntegerMapping(
  value: unknown,
  pathName: string,
  key: string
): { readonly ok: true; readonly value?: number } | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: true };
  if (!isRecord(value) || Object.keys(value).length !== 1 || !(key in value)) {
    return { ok: false, message: `${pathName} supports only ${key}.` };
  }
  const parsed = positiveInteger(value[key]);
  return parsed === undefined
    ? { ok: false, message: `${pathName}.${key} must be a positive integer in milliseconds.` }
    : { ok: true, value: parsed };
}

export function validateAdapterSettings(value: unknown):
  | { readonly ok: true; readonly value?: ProjectHarnessAdapterSettings }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: true };
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "multica")) {
    return { ok: false, message: "settings.adapters supports only multica." };
  }
  const multica = validatePositiveIntegerMapping(value.multica, "settings.adapters.multica", "staleTtlMs");
  if (!multica.ok) return multica;
  return {
    ok: true,
    value: multica.value === undefined ? {} : { multica: { staleTtlMs: multica.value } }
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "string" && !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
