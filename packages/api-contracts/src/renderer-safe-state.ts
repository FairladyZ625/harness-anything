import type { RendererSafeConnectionState } from "./daemon-protocol.ts";

export type RendererSafeStateDecoder = (value: unknown) => RendererSafeConnectionState;

export const decodeRendererSafeConnectionState: RendererSafeStateDecoder = (value) => {
  const input = record(value, "connection state");
  exactKeys(input, ["repo", "state", "lastLiveAt"]);
  const repo = record(input.repo, "RepoKey");
  exactKeys(repo, ["endpoint", "repoId"]);
  if (typeof repo.endpoint !== "string" || repo.endpoint.length === 0) throw new Error("RepoKey endpoint is required");
  if (typeof repo.repoId !== "string" || repo.repoId.length === 0) throw new Error("RepoKey repoId is required");
  if (!isState(input.state)) throw new Error("invalid daemon client state");
  if (input.lastLiveAt !== undefined && typeof input.lastLiveAt !== "number") throw new Error("lastLiveAt must be a number");
  return {
    repo: { endpoint: repo.endpoint, repoId: repo.repoId },
    state: input.state,
    ...(typeof input.lastLiveAt === "number" ? { lastLiveAt: input.lastLiveAt } : {})
  };
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`non-serializable connection field: ${unknown.join(", ")}`);
}

function isState(value: unknown): value is RendererSafeConnectionState["state"] {
  return value === "connecting" || value === "live" || value === "stale" || value === "unknown";
}
