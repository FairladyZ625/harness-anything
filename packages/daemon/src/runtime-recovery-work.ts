import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";

/** Recovery owns external work; only its prepared mutations enter the repository writer. */
export function makeRuntimeRecoveryWork(
  enqueue: <T>(work: () => T | Promise<T>, binding: RuntimeBinding) => Promise<T>,
) {
  const recovering = new AsyncLocalStorage<boolean>();
  return {
    run: <T>(work: () => T): T => recovering.run(true, work),
    queued: <T>(work: () => T): T => recovering.exit(work),
    write: <T>(work: () => T | Promise<T>, binding: RuntimeBinding): Promise<T> =>
      recovering.getStore() ? enqueue(() => recovering.exit(work), binding) : Promise.resolve().then(work),
  };
}
