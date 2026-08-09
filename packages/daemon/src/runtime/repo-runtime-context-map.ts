import type { WriteError } from "@harness-anything/kernel";

export function sortedContexts<Context extends { readonly repoId: string; readonly rootDir: string }>(
  contexts: Map<string, Context>
): ReadonlyArray<Context> {
  return [...contexts.values()].sort(
    (left, right) => left.repoId.localeCompare(right.repoId) || left.rootDir.localeCompare(right.rootDir)
  );
}

export function requireContext<Context>(contexts: Map<string, Context>, repoId: string): Context {
  const context = contexts.get(repoId);
  if (!context) {
    throw {
      _tag: "JournalUnavailable",
      cause: new Error(`unknown daemon repo "${repoId}"`)
    } satisfies WriteError;
  }
  return context;
}
