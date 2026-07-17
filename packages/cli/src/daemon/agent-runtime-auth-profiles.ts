import { execFile } from "node:child_process";
import type { RuntimeAuthenticationProfileProjection } from "../../../application/src/agent-runtime-control.ts";

export interface RuntimeAuthStatusResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface RuntimeAuthenticationProbeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runStatus?: (kindId: "claude-code" | "codex") => Promise<RuntimeAuthStatusResult>;
}

export async function probeRuntimeAuthenticationProfiles(
  options: RuntimeAuthenticationProbeOptions = {}
): Promise<ReadonlyArray<RuntimeAuthenticationProfileProjection>> {
  const env = options.env ?? process.env;
  const runStatus = options.runStatus ?? ((kindId) => runRuntimeAuthStatus(kindId, env));
  const [claudeStatus, codexStatus] = await Promise.all([runStatus("claude-code"), runStatus("codex")]);
  return [
    {
      kindId: "claude-code",
      profileKind: "subscription-account",
      state: claudeAccountState(claudeStatus),
      guidance: "Run `claude auth login` to configure a Claude account."
    },
    {
      kindId: "claude-code",
      profileKind: "api-key",
      state: configuredEnvironmentValue(env.ANTHROPIC_API_KEY),
      guidance: "Configure ANTHROPIC_API_KEY in the daemon environment."
    },
    {
      kindId: "codex",
      profileKind: "chatgpt-account",
      state: codexAccountState(codexStatus),
      guidance: "Run `codex login` to configure a ChatGPT account."
    },
    {
      kindId: "codex",
      profileKind: "api-key",
      state: configuredEnvironmentValue(env.OPENAI_API_KEY),
      guidance: "Configure OPENAI_API_KEY in the daemon environment."
    }
  ];
}

function runRuntimeAuthStatus(
  kindId: "claude-code" | "codex",
  env: Readonly<Record<string, string | undefined>>
): Promise<RuntimeAuthStatusResult> {
  const command = kindId === "claude-code" ? "claude" : "codex";
  const args = kindId === "claude-code" ? ["auth", "status", "--json"] : ["login", "status"];
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2_000, maxBuffer: 32 * 1024, env: { ...env } }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? Number((error as NodeJS.ErrnoException).code)
        : error ? 1 : 0;
      resolve({ exitCode, stdout: error && !stdout ? "" : stdout, stderr });
    });
  });
}

function claudeAccountState(result: RuntimeAuthStatusResult): RuntimeAuthenticationProfileProjection["state"] {
  if (result.exitCode !== 0) return "not-configured";
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isAuthStatusRecord(parsed) || typeof parsed.loggedIn !== "boolean") return "invalid";
    return parsed.loggedIn ? "configured" : "not-configured";
  } catch {
    return "invalid";
  }
}

function codexAccountState(result: RuntimeAuthStatusResult): RuntimeAuthenticationProfileProjection["state"] {
  if (result.exitCode !== 0) return "not-configured";
  const statusOutput = [result.stdout, result.stderr ?? ""].filter((value) => value.trim().length > 0).join("\n").trim();
  return /^Logged in using (ChatGPT|access token)$/mu.test(statusOutput) ? "configured" : "invalid";
}

function configuredEnvironmentValue(value: string | undefined): RuntimeAuthenticationProfileProjection["state"] {
  return typeof value === "string" && value.trim().length > 0 ? "configured" : "not-configured";
}

function isAuthStatusRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
