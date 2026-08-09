import { rmSync } from "node:fs";
import { setTimeout as waitFor } from "node:timers/promises";
import {
  openPublicationGitObjectReadersWithin
} from "../packages/daemon/src/authority/production/publication-object-reader.ts";

/**
 * Removing a temporary root can race a resident daemon or forked writer that is already exiting.
 * Windows reports that as EPERM and Linux as ENOTEMPTY, and bounded retry is the right treatment
 * for that transient window. An unclosed `git cat-file --batch` reader is an ownership bug instead,
 * so retry exhaustion reports it without silently shutting down a root-scoped shared reader.
 * EACCES and anything else outside the transient set still throws on the first attempt.
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
      if (!isRetriableRemovalError(error)) throw error;
      if (attempt >= maxRetries) {
        throw appendPublicationReaderDiagnostic(error, rootDir);
      }
      await wait(retryDelayMs * (attempt + 1));
    }
  }
}

function appendPublicationReaderDiagnostic(error, rootDir) {
  const readers = openPublicationGitObjectReadersWithin(rootDir);
  if (!(error instanceof Error) || readers.length === 0) return error;
  const roots = readers.map((reader) => `root=${reader.root}`).join(", ");
  const readerNoun = readers.length === 1 ? "reader" : "readers";
  error.message = `${error.message}; temporary test root still has ${readers.length} unclosed publication ${readerNoun}(${roots})`;
  return error;
}

function isRetriableRemovalError(error) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && retriableRemovalCodes.has(String(error.code));
}
