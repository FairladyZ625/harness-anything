import type { HarnessLayoutInput } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult } from "../cli/types.ts";
import {
  DEFAULT_EXECUTION_CONSENT_TTL_MS,
  DEFAULT_MULTICA_STALE_TTL_MS,
  resolvePositiveIntegerValue
} from "./project-policy-values.ts";
import { readProjectHarnessSettings } from "./settings.ts";

export {
  DEFAULT_EXECUTION_CONSENT_TTL_MS,
  DEFAULT_MULTICA_STALE_TTL_MS
} from "./project-policy-values.ts";

type ResolvedTtl =
  | { readonly ok: true; readonly ttlMs: number }
  | { readonly ok: false; readonly result: CliResult };

export function resolveExecutionConsentTtlMs(
  rootInput: HarnessLayoutInput,
  env: NodeJS.ProcessEnv = process.env,
  command = "task-consent"
): ResolvedTtl {
  const settings = readProjectHarnessSettings(rootInput, command);
  if (!settings.ok) return settings;
  return resolvePolicyTtl(command, {
    envName: "HARNESS_EXECUTION_CONSENT_TTL_MS",
    envValue: env.HARNESS_EXECUTION_CONSENT_TTL_MS,
    yamlValue: settings.settings.execution?.consentTtlMs,
    defaultValue: DEFAULT_EXECUTION_CONSENT_TTL_MS
  });
}

export function resolveMulticaStaleTtlMs(
  rootInput: HarnessLayoutInput,
  env: NodeJS.ProcessEnv = process.env,
  command = "multica"
): ResolvedTtl {
  const settings = readProjectHarnessSettings(rootInput, command);
  if (!settings.ok) return settings;
  return resolvePolicyTtl(command, {
    envName: "HARNESS_MULTICA_STALE_TTL_MS",
    envValue: env.HARNESS_MULTICA_STALE_TTL_MS,
    yamlValue: settings.settings.adapters?.multica?.staleTtlMs,
    defaultValue: DEFAULT_MULTICA_STALE_TTL_MS
  });
}

function resolvePolicyTtl(
  command: string,
  input: Parameters<typeof resolvePositiveIntegerValue>[0]
): ResolvedTtl {
  const resolved = resolvePositiveIntegerValue(input);
  return resolved.ok
    ? { ok: true, ttlMs: resolved.value }
    : {
        ok: false,
        result: {
          ok: false,
          command,
          error: cliError(CliErrorCode.HarnessSettingsInvalid, resolved.message)
        }
      };
}
