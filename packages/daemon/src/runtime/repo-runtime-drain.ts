import { DaemonDrainTimeoutError } from "@harness-anything/kernel";
import type { DaemonWriteQueue } from "./write-queue.ts";

export async function waitForDaemonQueueIdle(
  queue: DaemonWriteQueue,
  rootDir: string,
  drainTimeoutMs: number | undefined
): Promise<void> {
  if (drainTimeoutMs === undefined) return queue.idle();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.idle(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new DaemonDrainTimeoutError(rootDir, drainTimeoutMs, queue.drainTargets())), drainTimeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
