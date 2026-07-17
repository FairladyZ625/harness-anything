import { DaemonDrainTimeoutError } from "../../../kernel/src/index.ts";
import type { AuthorityRepoLifecycleController } from "./authority-lifecycle.ts";

export async function drainDaemonRuntime(input: {
  readonly authorityLifecycle: AuthorityRepoLifecycleController | undefined;
  readonly runtime: { readonly stop: (options?: { readonly drainTimeoutMs?: number }) => Promise<void> };
  readonly drainTimeoutMs: number | undefined;
}): Promise<void> {
  if (input.drainTimeoutMs === undefined) {
    await input.authorityLifecycle?.stopAll("daemon-shutdown");
    await input.runtime.stop();
    return;
  }
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await input.authorityLifecycle?.stopAll("daemon-shutdown");
        if (expired) return;
        await input.runtime.stop({ drainTimeoutMs: input.drainTimeoutMs });
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          expired = true;
          reject(new DaemonDrainTimeoutError("daemon authority/runtime drain", input.drainTimeoutMs!, []));
        }, input.drainTimeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function isDaemonDrainTimeout(error: unknown): boolean {
  if (error instanceof DaemonDrainTimeoutError) return true;
  return error instanceof AggregateError && error.errors.some((candidate) => isDaemonDrainTimeout(candidate));
}
