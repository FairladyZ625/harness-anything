import type { CanonicalEventPage, CanonicalEventReadRequest } from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";

/** One host-side wait set per repository. Reader workers only execute the short snapshot reads. */
export function makeCanonicalEventWait() {
  const waiters = new Set<(revision: number) => void>();
  const closing = new AbortController();
  let published = 0;
  return {
    observeCommit(revision: number | undefined) {
      if (revision === undefined || revision <= published) return;
      published = revision;
      for (const notify of waiters) notify(revision);
    },
    close() {
      closing.abort(cellCodedError("repo_unavailable", "RepoCell is closed."));
    },
    async read(
      request: CanonicalEventReadRequest,
      readPage: (signal: AbortSignal) => Promise<CanonicalEventPage>,
      connectionSignal?: AbortSignal,
    ): Promise<CanonicalEventPage> {
      const signal = AbortSignal.any(connectionSignal ? [connectionSignal, closing.signal] : [closing.signal]);
      const deadline = performance.now() + (request.waitMs ?? 0);
      signal.throwIfAborted();
      const page = await readPage(signal);
      const remaining = deadline - performance.now();
      if (page.events.length || remaining <= 0) return page;
      signal.throwIfAborted();
      // A commit can land between the empty snapshot and its reply from the reader worker.
      // Check the last notification before subscribing so that commit cannot be lost.
      if (published <= request.afterRevision)
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            waiters.delete(notify);
            signal.removeEventListener("abort", abort);
          };
          const resume = () => {
            finish();
            resolve();
          };
          const notify = (revision: number) => {
            if (revision > request.afterRevision) resume();
          };
          const abort = () => {
            finish();
            reject(signal.reason);
          };
          const timer = setTimeout(resume, remaining);
          waiters.add(notify);
          signal.addEventListener("abort", abort, { once: true });
        });
      signal.throwIfAborted();
      return readPage(signal);
    },
  };
}
