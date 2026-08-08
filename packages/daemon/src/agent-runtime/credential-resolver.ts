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
 * @param userRoot - User root directory (e.g. ~/.harness-production)
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

  // Resolve API key: env > YAML > empty
  let apiKey = processEnv[envKeyName];
  let baseUrl = processEnv[envBaseUrlName];

  // If API key not in env, try YAML
  if (!apiKey) {
    const credentialsPath = path.join(userRoot, "agent-runtime-credentials.yaml");
    if (existsSync(credentialsPath)) {
      try {
        const content = readFileSync(credentialsPath, "utf-8");
        const yaml = YAML.parse(content) as CredentialsYaml;
        const profile = yaml.profiles?.find((p) => p.kindId === kindId && p.profileKind === profileKind);
        if (profile) {
          apiKey = profile.apiKey;
          // Base URL from YAML only if not in env
          if (!baseUrl) baseUrl = profile.baseUrl;
        }
      } catch {
        // YAML parse error or file unreadable: continue with env values
      }
    }
  }

  // Build env with resolved credentials
  const env = { ...processEnv };
  if (apiKey) env[envKeyName] = apiKey;
  if (baseUrl) env[envBaseUrlName] = baseUrl;

  return {
    apiKey,
    baseUrl,
    env
  };
}
