import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface ResolvedCredentials {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly env: NodeJS.ProcessEnv;
}

interface CredentialsYaml {
  readonly schema: string;
  readonly profiles: ReadonlyArray<{
    readonly kindId: string;
    readonly profileKind: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
  }>;
}

/**
 * Resolve API credentials and endpoint for an agent runtime profile.
 *
 * Priority: process.env > credentials YAML file > empty
 *
 * @param kindId - Runtime kind (claude-code / codex)
 * @param profileKind - Profile kind (api-key / subscription-account / etc)
 * @param userRoot - Daemon user root (e.g. ~/.harness-production)
 * @param processEnv - Process environment (usually process.env)
 * @returns Resolved credentials with env object to pass to AdapterOptions
 */
export function resolveCredentials(
  kindId: string,
  profileKind: string,
  userRoot: string,
  processEnv: NodeJS.ProcessEnv
): ResolvedCredentials {
  // Only resolve for api-key profiles; others use native auth flows
  if (profileKind !== "api-key") {
    return { env: { ...processEnv } };
  }

  const envKeyName = kindId === "claude-code" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const envBaseUrlName = kindId === "claude-code" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";

  // Priority 1: environment variables
  if (processEnv[envKeyName]) {
    return {
      apiKey: processEnv[envKeyName],
      baseUrl: processEnv[envBaseUrlName],
      env: { ...processEnv }
    };
  }

  // Priority 2: YAML file
  const credentialsPath = path.join(userRoot, "agent-runtime-credentials.yaml");
  if (!existsSync(credentialsPath)) {
    return { env: { ...processEnv } };
  }

  let yaml: CredentialsYaml;
  try {
    const content = readFileSync(credentialsPath, "utf-8");
    yaml = YAML.parse(content) as CredentialsYaml;
  } catch {
    return { env: { ...processEnv } };
  }

  const profile = yaml.profiles?.find((p) => p.kindId === kindId && p.profileKind === profileKind);
  if (!profile?.apiKey) {
    return { env: { ...processEnv } };
  }

  // Build env with credentials from YAML
  const env = { ...processEnv };
  if (profile.apiKey) env[envKeyName] = profile.apiKey;
  if (profile.baseUrl) env[envBaseUrlName] = profile.baseUrl;

  return {
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    env
  };
}
