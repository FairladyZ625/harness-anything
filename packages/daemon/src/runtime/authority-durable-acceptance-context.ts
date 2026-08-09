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

const storage = new AsyncLocalStorage<AuthorityDurableAcceptanceObserver>();
const settlementReleaseStorage = new AsyncLocalStorage<Promise<void>>();

export function runWithAuthorityDurableAcceptance<Result>(
  observer: AuthorityDurableAcceptanceObserver,
  operation: () => Result
): Result {
  return storage.run(observer, operation);
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
