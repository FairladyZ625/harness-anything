import { rmSync } from "node:fs";
import { setTimeout as waitFor } from "node:timers/promises";

/**
 * Removing a temporary root races whatever still holds handles inside it: a resident daemon, a
 * forked writer, or the long-lived `git cat-file --batch` reader. Windows reports that as EPERM
 * and Linux as ENOTEMPTY, and both are transient — the owner exits a moment later. A bounded
 * retry lets the removal finish without hiding a genuine permission problem, since EACCES and
 * anything else outside the transient set still throws on the first attempt.
 *
 * This lives under tools/ rather than one package's test helpers because both packages/cli and
 * packages/daemon tests need it, the same way tools/test-child-process-lifecycle.mjs is shared.
 */
const retriableRemovalCodes = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM"
]);

export async function removeTemporaryTestRoot(rootDir, options = {}) {
  const remove = options.remove ?? ((candidateRoot) => {
    rmSync(candidateRoot, { recursive: true, force: true });
  });
  const wait = options.wait ?? ((milliseconds) => waitFor(milliseconds));
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

function isRetriableRemovalError(error) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && retriableRemovalCodes.has(String(error.code));
}
