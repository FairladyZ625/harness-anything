export function describeRepoRuntimeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return describeRepoRuntimeError((error as { readonly cause?: unknown }).cause);
  }
  return String(error);
}
