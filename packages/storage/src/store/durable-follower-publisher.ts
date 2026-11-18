import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { WriteFence } from "../durable-file.ts";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import type {
  MaterializationHealth,
  MaterializationReceipt,
  MaterializationRequest,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";

const initialRetryMs = storageReadPolicy.defaultValue.backoff.followerInitial,
  maximumRetryMs = storageReadPolicy.defaultValue.backoff.followerMaximum;

/** Serializes detached publication and retries from the publisher's durable checkpoint. */
export function createDurableFollowerPublisher(input: {
  readonly publish: (request?: MaterializationRequest) => MaterializationReceipt;
  readonly publishAsync?: (request?: MaterializationRequest) => Promise<MaterializationReceipt>;
  readonly withFence?: WriteFence;
  readonly revision: () => number;
  readonly checkpoint: () => number;
  readonly onFailure?: (reason: string) => void;
  readonly onHealthChange?: (health: MaterializationHealth) => void;
}) {
  let closed = false,
    scheduled: Promise<void> | null = null,
    inFlight = false,
    inFlightRevision = 0,
    rerunRequested = false,
    retry: NodeJS.Timeout | null = null,
    retryDelay: number = initialRetryMs,
    lastError: string | undefined,
    checkpointAt: string | null = null;

  const health = (): MaterializationHealth => {
    const checkpoint = input.checkpoint(),
      pending = input.revision() - checkpoint;
    return {
      state: lastError ? "failed" : pending > 0 ? "retrying" : "ok",
      lastCheckpointRevision: checkpoint,
      lastCheckpointAt: checkpointAt,
      pendingWalEvents: pending,
      ...(lastError ? { reason: "deterministic_failure", lastError } : {}),
    };
  };
  const completePublish = (
    receipt: MaterializationReceipt,
    request?: MaterializationRequest,
  ): MaterializationReceipt => {
    if (!request?.preview) {
      // A takeover after the last mutation (or on a no-op certified cut) must not report success.
      // Actual mutations fence themselves; no publication I/O runs in this final ownership check.
      input.withFence?.(() => undefined);
      lastError = undefined;
      checkpointAt = new Date().toISOString();
      retryDelay = initialRetryMs;
      input.onHealthChange?.(health());
    }
    return receipt;
  };
  const publish = (request?: MaterializationRequest): MaterializationReceipt => {
    const receipt = input.publish(request);
    return completePublish(receipt, request);
  };
  const publishAsync = async (request?: MaterializationRequest): Promise<MaterializationReceipt> => {
    const receipt = await (input.publishAsync ? input.publishAsync(request) : input.publish(request));
    return completePublish(receipt, request);
  };

  const scheduleRetry = () => {
    if (closed) return;
    retry = setTimeout(() => {
      retry = null;
      void request();
    }, retryDelay);
    retry.unref();
    retryDelay = Math.min(retryDelay * 2, maximumRetryMs);
  };
  const request = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    if (scheduled) {
      if (inFlight && input.revision() > inFlightRevision) rerunRequested = true;
      return scheduled;
    }
    scheduled = new Promise((resolve) =>
      setImmediate(async () => {
        inFlight = true;
        try {
          do {
            inFlightRevision = input.revision();
            rerunRequested = false;
            if (input.publishAsync) await publishAsync();
            else publish();
          } while (rerunRequested);
        } catch (error) {
          consumeKnownError(error);
          lastError = error instanceof Error ? error.message : String(error);
          input.onFailure?.(lastError);
          input.onHealthChange?.(health());
          scheduleRetry();
        } finally {
          inFlight = false;
          scheduled = null;
          resolve();
        }
      }),
    );
    return scheduled;
  };

  return {
    request,
    publish,
    health,
    drain: async () => {
      closed = true;
      if (retry) clearTimeout(retry);
      retry = null;
      await scheduled;
    },
  };
}
