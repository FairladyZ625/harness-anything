import { Context, Effect } from "effect";

export type CurrentSessionRuntime = "human" | "claude-code" | "codex" | "zcode" | "antigravity";
export type CurrentSessionSource = "runtime" | "manual";

export interface CurrentSessionRef {
  readonly runtime: CurrentSessionRuntime;
  readonly sessionId: string;
  readonly source: CurrentSessionSource;
  readonly detectedAt: string;
  readonly user?: string;
}

export interface CurrentSessionProbe {
  readonly currentSession: Effect.Effect<CurrentSessionRef, never>;
}

export const CurrentSessionProbe = Context.GenericTag<CurrentSessionProbe>(
  "@harness-anything/kernel/CurrentSessionProbe"
);
