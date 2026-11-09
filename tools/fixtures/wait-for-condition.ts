/**
 * Durable predicate waits (owner ruling 2026-11-09 on task_6ddecd04b58fe29d6aa32c9736): read the
 * state again until the predicate holds. There is no deadline and no "timed out after N ms"
 * failure; the node:test `timeout` option is the hang guard. The yield is setImmediate, not a
 * wall-clock interval, so the wait never judges by elapsed time.
 */
export interface WaitOptions {
  readonly describeLast?: (value: unknown) => string;
}

export async function waitForValue<T>(
  read: () => T | null | undefined | Promise<T | null | undefined>,
  _label: string,
  _options: WaitOptions = {},
): Promise<T> {
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  label: string,
  options: WaitOptions = {},
): Promise<void> {
  await waitForValue(async () => ((await check()) ? true : null), label, options);
}

export async function waitForPromise<T>(promise: Promise<T>, label: string, options: WaitOptions = {}): Promise<T> {
  let result: T | undefined,
    failure: unknown,
    settled = false;
  void promise.then(
    (value) => {
      result = value;
      settled = true;
    },
    (error: unknown) => {
      failure = error;
      settled = true;
    },
  );
  await waitForCondition(() => settled, label, options);
  if (failure !== undefined) throw failure;
  return result as T;
}
