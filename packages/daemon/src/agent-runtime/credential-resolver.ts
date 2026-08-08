import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
        const parsed = parseCredentialsDocument(content);
        const profile = parsed.profiles?.find((p) => p.kindId === kindId && p.profileKind === profileKind);
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

/**
 * The credentials document is a fixed four-field profile list that this
 * repository both writes and reads, so it is parsed directly rather than by
 * adding a YAML dependency to the only publishable artifact. JSON is accepted
 * as a strict YAML subset, matching how the people roster is read.
 */
function parseCredentialsDocument(content: string): Partial<CredentialsYaml> {
  try {
    return JSON.parse(content) as CredentialsYaml;
  } catch {
    // The canonical document is YAML; JSON is accepted for fixtures.
  }
  const profiles: Array<{ kindId: string; profileKind: string; apiKey?: string; baseUrl?: string }> = [];
  let current: Record<string, string> | undefined;
  const commit = () => {
    if (current?.kindId && current.profileKind) {
      profiles.push({
        kindId: current.kindId,
        profileKind: current.profileKind,
        ...(current.apiKey ? { apiKey: current.apiKey } : {}),
        ...(current.baseUrl ? { baseUrl: current.baseUrl } : {})
      });
    }
    current = undefined;
  };
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (!line.trim()) continue;
    const item = /^\s*-\s*(.*)$/u.exec(line);
    if (item) {
      commit();
      current = {};
      if (!item[1]?.trim()) continue;
      assignCredentialField(current, item[1]);
      continue;
    }
    if (!current) continue;
    // A key at or left of the list marker's own indent ends the list.
    if (!/^\s\s/u.test(line)) { commit(); continue; }
    assignCredentialField(current, line);
  }
  commit();
  return { profiles };
}

function assignCredentialField(target: Record<string, string>, line: string): void {
  const match = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/u.exec(line);
  if (!match) return;
  const value = match[2]?.trim() ?? "";
  if (!value) return;
  const unquoted = /^(["'])(.*)\1$/u.exec(value);
  target[match[1]!] = unquoted ? unquoted[2]! : value;
}
