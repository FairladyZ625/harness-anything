/** @slice-activation Slice 7.5 GUI terminal - Environment profile validation is admitted for terminal launch context wiring. */
export interface EnvProfile {
  readonly envProfileId: string;
  readonly name: string;
  readonly projectId?: string;
  readonly hostProfileId?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritSystemEnv: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnvProfileScopeRequirement = "global" | "project" | "host" | "project-host";

export interface EnvProfileValidationOptions {
  readonly requiredScope?: EnvProfileScopeRequirement;
}

export interface EnvProfileSecretViolation {
  readonly key: string;
  readonly reason: "secret_key_name" | "secret_value";
}

export type EnvProfileValidationErrorCode =
  | "invalid_env_profile_identity"
  | "invalid_env_profile_scope"
  | "invalid_env_profile_env"
  | "env_profile_contains_secret";

export type EnvProfileValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: EnvProfileValidationErrorCode;
        readonly hint: string;
        readonly violations?: ReadonlyArray<EnvProfileSecretViolation>;
      };
    };

const secretKeyPattern = /(^|_)(api[_-]?key|access[_-]?key|auth|credential|pass(word|phrase)?|private[_-]?key|secret|token)($|_)/i;
const secretValuePattern = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-|sk-[A-Za-z0-9]{16,}|bearer\s+[A-Za-z0-9._-]{16,})/i;
const secretReferencePattern = /^(keychain:|ssh-agent:|secret:\/\/|\$\{(?:KEYCHAIN|SSH_AGENT|SECRET_REF):[^}]+\})/i;

export function validateEnvProfile(profile: EnvProfile, options: EnvProfileValidationOptions = {}): EnvProfileValidationResult {
  if (!profile.envProfileId || !profile.name || !profile.createdAt || !profile.updatedAt) {
    return failure("invalid_env_profile_identity", "EnvProfile requires stable id, name, createdAt and updatedAt.");
  }

  const requiredScope = options.requiredScope ?? "global";
  if ((requiredScope === "project" || requiredScope === "project-host") && !profile.projectId) {
    return failure("invalid_env_profile_scope", "Project-specific EnvProfile requires projectId.");
  }
  if ((requiredScope === "host" || requiredScope === "project-host") && !profile.hostProfileId) {
    return failure("invalid_env_profile_scope", "Host-specific EnvProfile requires hostProfileId.");
  }

  if (typeof profile.inheritSystemEnv !== "boolean" || !isPlainStringRecord(profile.env)) {
    return failure("invalid_env_profile_env", "EnvProfile env must be a string-to-string record and inheritSystemEnv must be boolean.");
  }

  const violations = findEnvProfileSecretViolations(profile);
  if (violations.length > 0) {
    return {
      ok: false,
      error: {
        code: "env_profile_contains_secret",
        hint: "EnvProfile is launch context, not a secret store; use keychain, ssh-agent, or an enterprise secret reference.",
        violations
      }
    };
  }

  return { ok: true };
}

export function findEnvProfileSecretViolations(profile: EnvProfile): ReadonlyArray<EnvProfileSecretViolation> {
  const violations: EnvProfileSecretViolation[] = [];
  for (const [key, value] of Object.entries(profile.env)) {
    if (secretReferencePattern.test(value)) continue;
    if (secretKeyPattern.test(key)) {
      violations.push({ key, reason: "secret_key_name" });
      continue;
    }
    if (secretValuePattern.test(value)) {
      violations.push({ key, reason: "secret_value" });
    }
  }
  return violations;
}

function failure(code: EnvProfileValidationErrorCode, hint: string): EnvProfileValidationResult {
  return { ok: false, error: { code, hint } };
}

function isPlainStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}
