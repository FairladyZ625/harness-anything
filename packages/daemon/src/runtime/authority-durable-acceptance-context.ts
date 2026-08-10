import { AsyncLocalStorage } from "node:async_hooks";
import { isIndeterminateFlushReport, type DeterminateFlushReport, type FlushReport } from "@harness-anything/kernel";

export interface AuthorityDurableAcceptance {
  readonly sessionId: string;
  readonly acceptedCommitSha: string;
  readonly flush: DeterminateFlushReport & {
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

/** Identify every authority publication admitted by the same outer command. */
export function currentAuthoritySettlementReleaseSignal(): Promise<void> | undefined {
  return settlementReleaseStorage.getStore();
}

/** Explicitly carry both acceptance scopes across a deferred publication executor. */
export function captureCurrentAuthorityPublicationContext(): <Result>(
  operation: () => Result
) => Result {
  const acceptance = storage.getStore();
  const settlementRelease = settlementReleaseStorage.getStore();
  return <Result>(operation: () => Result): Result => {
    const runWithSettlementRelease = () => settlementRelease
      ? settlementReleaseStorage.run(settlementRelease, operation)
      : operation();
    return acceptance
      ? storage.run(acceptance, runWithSettlementRelease)
      : runWithSettlementRelease();
  };
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

export interface HeldBackgroundAuthoritySettlement<Result> {
  readonly result: Result;
  readonly releaseAfterResponse: () => void;
}

/**
 * Hold same-command canonical settlement until the child has delivered the
 * durable acceptance receipt. A failed command releases immediately so no
 * background publication can remain parked without a response owner.
 */
export async function holdBackgroundAuthoritySettlement<Result>(
  operation: () => Promise<Result>
): Promise<HeldBackgroundAuthoritySettlement<Result>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let scheduled = false;
  const releaseAfterResponse = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(release);
  };
  try {
    const result = await runWithAuthoritySettlementRelease(released, operation);
    return { result, releaseAfterResponse };
  } catch (error) {
    releaseAfterResponse();
    throw error;
  }
}

export async function runBeforeBackgroundAuthoritySettlement<Result>(
  operation: () => Promise<Result>
): Promise<Result> {
  const held = await holdBackgroundAuthoritySettlement(operation);
  held.releaseAfterResponse();
  return held.result;
}

export function reportCurrentAuthorityDurableAcceptance(
  sessionId: string,
  acceptedCommitSha: string,
  flush: FlushReport
): void {
  if (isIndeterminateFlushReport(flush) || !flush.committed || !flush.watermark) return;
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
