/**
 * Unattended launch admission (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1 + R4: security admission precedes the
 * first automatic wakeup).
 *
 * Every Inbox- or Schedule-triggered run passes this judgment before a process starts:
 * - `bypass` is refused outright; an omitted mode resolves to the work kind's ceiling, never to `bypass`;
 * - code-change work runs at most `workspace-write`, supervision runs `read-only`;
 * - a runtime that cannot run the admitted mode fails closed (`unattended_permission_unsupported`);
 * - host plaintext GitHub tokens are removed from the child environment.
 * The returned ceiling is what a provider-fallback candidate must be admitted against again.
 * The judgment is pure: it reads only its input and never echoes an environment value.
 */
import type { AgentPermissionMode } from "./agent-squad-schema.ts";

export const unattendedWorkKinds = ["code_change", "supervision", "peer_readonly"] as const;
export type UnattendedWorkKind = (typeof unattendedWorkKinds)[number];
export type UnattendedPermissionMode = Exclude<AgentPermissionMode, "bypass">;

export const unattendedPermissionCeilings: Readonly<Record<UnattendedWorkKind, UnattendedPermissionMode>> = {
  code_change: "workspace-write",
  supervision: "read-only",
  peer_readonly: "read-only",
};
/** Host credentials that an unattended child process must never inherit in plaintext. */
export const unattendedStrippedEnvironmentKeys = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

const permissionRank: Readonly<Record<AgentPermissionMode, number>> = {
  "read-only": 0,
  "workspace-write": 1,
  bypass: 2,
};

export interface UnattendedLaunchAdmissionInput {
  readonly workKind: UnattendedWorkKind;
  /** The mode configured for the runtime instance or agent; `null` when none is configured. */
  readonly requestedPermissionMode: AgentPermissionMode | null;
  /** Modes the selected runtime instance can actually enforce. */
  readonly supportedPermissionModes: readonly AgentPermissionMode[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface UnattendedLaunchAdmission {
  readonly permissionMode: UnattendedPermissionMode;
  readonly ceiling: UnattendedPermissionMode;
  readonly environment: Readonly<Record<string, string>>;
  /** Names only; the stripped values are never part of the result. */
  readonly strippedEnvironmentKeys: readonly string[];
}

export type UnattendedLaunchAdmissionCode =
  | "unattended_permission_bypass_forbidden"
  | "unattended_permission_exceeds_ceiling"
  | "unattended_permission_unsupported";

export class UnattendedLaunchAdmissionError extends Error {
  override name = "UnattendedLaunchAdmissionError";
  readonly code: UnattendedLaunchAdmissionCode;
  constructor(code: UnattendedLaunchAdmissionCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

function isStrippedEnvironmentKey(key: string): boolean {
  // Windows environment names are case-insensitive, so `gh_token` reaches the child as GH_TOKEN.
  const upper = key.toUpperCase();
  return (unattendedStrippedEnvironmentKeys as readonly string[]).includes(upper);
}

/** Admit or refuse one unattended launch; throws {@link UnattendedLaunchAdmissionError} when refused. */
export function assertUnattendedLaunchAdmission(input: UnattendedLaunchAdmissionInput): UnattendedLaunchAdmission {
  const ceiling = unattendedPermissionCeilings[input.workKind];
  if (input.requestedPermissionMode === "bypass")
    throw new UnattendedLaunchAdmissionError(
      "unattended_permission_bypass_forbidden",
      `unattended ${input.workKind} runs may not use bypass`,
    );
  const permissionMode = input.requestedPermissionMode ?? ceiling;
  if (permissionRank[permissionMode] > permissionRank[ceiling])
    throw new UnattendedLaunchAdmissionError(
      "unattended_permission_exceeds_ceiling",
      `unattended ${input.workKind} runs are limited to ${ceiling}, requested ${permissionMode}`,
    );
  if (!input.supportedPermissionModes.includes(permissionMode))
    throw new UnattendedLaunchAdmissionError(
      "unattended_permission_unsupported",
      `the selected runtime cannot enforce ${permissionMode}`,
    );
  const environment: Record<string, string> = {},
    strippedEnvironmentKeys: string[] = [];
  for (const [key, value] of Object.entries(input.environment)) {
    if (isStrippedEnvironmentKey(key)) strippedEnvironmentKeys.push(key);
    else if (value !== undefined) environment[key] = value;
  }
  return { permissionMode, ceiling, environment, strippedEnvironmentKeys: strippedEnvironmentKeys.sort() };
}
