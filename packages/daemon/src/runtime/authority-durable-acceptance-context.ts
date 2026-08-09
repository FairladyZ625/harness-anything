import { AsyncLocalStorage } from "node:async_hooks";
import type { FlushReport } from "@harness-anything/kernel";

export interface AuthorityDurableAcceptance {
  readonly sessionId: string;
  readonly acceptedCommitSha: string;
  readonly flush: FlushReport & {
    readonly committed: true;
    readonly watermark: string;
  };
}

interface AuthorityDurableAcceptanceObserver {
  readonly accept: (acceptance: AuthorityDurableAcceptance) => void;
}

interface AuthorityDurableAcceptanceScope {
  readonly accept: (acceptance: AuthorityDurableAcceptance) => void;
  readonly accepted: Promise<void>;
}

const storage = new AsyncLocalStorage<AuthorityDurableAcceptanceScope>();
const settlementReleaseStorage = new AsyncLocalStorage<Promise<void>>();

export function runWithAuthorityDurableAcceptance<Result>(
  observer: AuthorityDurableAcceptanceObserver,
  operation: () => Result
): Result {
  let signal!: () => void;
  const accepted = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let reported = false;
  return storage.run({
    accepted,
    accept: (acceptance) => {
      if (reported) return;
      reported = true;
      signal();
      observer.accept(acceptance);
    }
  }, operation);
}

/** Capture the command observer before crossing the shared write queue. */
export function captureCurrentAuthorityDurableAcceptanceReporter():
  | ((acceptance: AuthorityDurableAcceptance) => void)
  | undefined {
  const scope = storage.getStore();
  return scope ? (acceptance) => scope.accept(acceptance) : undefined;
}

/** Release a shared publication slot at the durable cut, not full settlement. */
export function currentAuthorityDurableAcceptanceSignal(): Promise<void> | undefined {
  return storage.getStore()?.accepted;
}

/**
 * Keep same-command authority publications durable while preventing an early
 * publication's synchronous materializer from overtaking later admissions in
 * that command. The caller releases after it has built the acceptance receipt.
 */
export function runWithAuthoritySettlementRelease<Result>(
  release: Promise<void>,
  operation: () => Result
): Result {
  return settlementReleaseStorage.run(release, operation);
}

export function waitForCurrentAuthoritySettlementRelease(): Promise<void> {
  return settlementReleaseStorage.getStore() ?? Promise.resolve();
}

export async function runBeforeBackgroundAuthoritySettlement<Result>(
  operation: () => Promise<Result>
): Promise<Result> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    return await runWithAuthoritySettlementRelease(released, operation);
  } finally {
    // Let the operation host construct and return its durable receipt before a
    // synchronous materializer can occupy this child process.
    setImmediate(release);
  }
}

export function reportCurrentAuthorityDurableAcceptance(
  sessionId: string,
  acceptedCommitSha: string,
  flush: FlushReport
): void {
  if (!flush.committed || !flush.watermark) return;
  storage.getStore()?.accept({
    sessionId,
    acceptedCommitSha,
    flush: {
      ...flush,
      committed: true,
      watermark: flush.watermark
    }
  });
}
