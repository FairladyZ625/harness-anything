export interface RepoWriteNotStartedClassification {
  readonly code: string;
  readonly diagnostic: string;
}

export function classifyRepoWriteNotStartedFailure(
  value: unknown
): RepoWriteNotStartedClassification | undefined {
  if (!(value instanceof Error)) return undefined;
  const failure = value as {
    readonly code?: unknown;
    readonly outcome?: unknown;
    readonly replay?: unknown;
  };
  if (failure.outcome !== "not-started"
    || failure.replay !== "caller-may-retry"
    || typeof failure.code !== "string"
    || failure.code.trim() === "") {
    return undefined;
  }
  return { code: failure.code, diagnostic: value.message };
}
