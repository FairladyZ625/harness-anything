import type { DaemonQueueDrainTarget, DaemonWriteQueue } from "./daemon-runtime-queue.ts";

export class DaemonDrainTimeoutError extends Error {
  readonly targets: ReadonlyArray<DaemonQueueDrainTarget>;

  constructor(rootDir: string, drainTimeoutMs: number, targets: ReadonlyArray<DaemonQueueDrainTarget>) {
    super(`daemon queue drain timed out after ${drainTimeoutMs}ms for ${rootDir}: ${targets.map(describeDrainTarget).join(", ") || "unknown in-flight operation"}`);
    this.name = "DaemonDrainTimeoutError";
    this.targets = targets;
  }
}

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

function describeDrainTarget(target: DaemonQueueDrainTarget): string {
  return target.kind === "interactive"
    ? `interactive command ${target.commandId} (${target.opIds.join(",")})`
    : `background source ${target.source}`;
}
