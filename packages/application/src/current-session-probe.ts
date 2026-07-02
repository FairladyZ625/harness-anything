import { Effect } from "effect";
import type { CurrentSessionProbePort, CurrentSessionRef, CurrentSessionRuntime, ProvenancePayload } from "../../kernel/src/index.ts";

export interface HumanFallbackSessionProbeOptions {
  readonly now?: () => string;
  readonly user?: () => string | undefined;
}

export interface RuntimeSessionEnvCandidate {
  readonly runtime: Exclude<CurrentSessionRuntime, "human">;
  readonly keys: ReadonlyArray<string>;
}

export interface EnvironmentCurrentSessionProbeOptions extends HumanFallbackSessionProbeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly candidates?: ReadonlyArray<RuntimeSessionEnvCandidate>;
}

export const defaultRuntimeSessionEnvCandidates: ReadonlyArray<RuntimeSessionEnvCandidate> = [
  { runtime: "claude-code", keys: ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"] },
  { runtime: "codex", keys: ["CODEX_SESSION_ID"] },
  { runtime: "zcode", keys: ["ZCODE_SESSION_ID"] },
  { runtime: "antigravity", keys: ["ANTIGRAVITY_SESSION_ID"] }
] as const;

export function makeHumanFallbackSessionProbe(options: HumanFallbackSessionProbeOptions = {}): CurrentSessionProbePort {
  return {
    currentSession: Effect.sync(() => humanFallbackSession(options))
  };
}

export function makeEnvironmentCurrentSessionProbe(options: EnvironmentCurrentSessionProbeOptions = {}): CurrentSessionProbePort {
  return {
    currentSession: Effect.sync(() => detectEnvironmentSession(options) ?? humanFallbackSession(options))
  };
}

export function currentSessionToProvenancePayload(session: CurrentSessionRef, boundAt: string): ProvenancePayload {
  return {
    runtime: session.runtime,
    sessionId: session.sessionId,
    boundAt
  };
}

function detectEnvironmentSession(options: EnvironmentCurrentSessionProbeOptions): CurrentSessionRef | null {
  const env = options.env ?? process.env;
  const detectedAt = options.now?.() ?? new Date().toISOString();
  for (const candidate of options.candidates ?? defaultRuntimeSessionEnvCandidates) {
    for (const key of candidate.keys) {
      const sessionId = env[key]?.trim();
      if (!sessionId) continue;
      return {
        runtime: candidate.runtime,
        sessionId,
        source: "runtime",
        detectedAt
      };
    }
  }
  return null;
}

function humanFallbackSession(options: HumanFallbackSessionProbeOptions): CurrentSessionRef {
  const detectedAt = options.now?.() ?? new Date().toISOString();
  const user = options.user?.() ?? process.env.USER;
  return {
    runtime: "human",
    sessionId: `human-cli-${Date.parse(detectedAt)}`,
    source: "manual",
    detectedAt,
    ...(user ? { user } : {})
  };
}
