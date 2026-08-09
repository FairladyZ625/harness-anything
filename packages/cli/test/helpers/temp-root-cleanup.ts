import { rmSync } from "node:fs";
import { setTimeout as waitFor } from "node:timers/promises";

const retriableRemovalCodes = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM"
]);

interface TemporaryTestRootCleanupOptions {
  readonly remove?: (rootDir: string) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
}

export async function removeTemporaryTestRoot(
  rootDir: string,
  options: TemporaryTestRootCleanupOptions = {}
): Promise<void> {
  const remove = options.remove ?? ((candidateRoot: string) => {
    rmSync(candidateRoot, { recursive: true, force: true });
  });
  const wait = options.wait ?? ((milliseconds: number) => waitFor(milliseconds));
  const maxRetries = options.maxRetries ?? 7;
  const retryDelayMs = options.retryDelayMs ?? 25;

  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(rootDir);
      return;
    } catch (error) {
      if (!isRetriableRemovalError(error) || attempt >= maxRetries) throw error;
      await wait(retryDelayMs * (attempt + 1));
    }
  }
}

function isRetriableRemovalError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && retriableRemovalCodes.has(String((error as { readonly code?: unknown }).code));
}
