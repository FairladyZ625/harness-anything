export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly describeLast?: (value: unknown) => string;
}

export async function waitForValue<T>(
  read: () => T | null | undefined | Promise<T | null | undefined>,
  label: string,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000,
    intervalMs = options.intervalMs ?? 10,
    deadline = performance.now() + timeoutMs;
  let last: T | null | undefined;
  do {
    last = await read();
    if (last !== null && last !== undefined) return last;
    if (performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (performance.now() < deadline);
  const observed = options.describeLast?.(last) ?? JSON.stringify(last);
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last observed: ${observed}`);
}

export async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  label: string,
  options: WaitOptions = {},
): Promise<void> {
  await waitForValue(async () => ((await check()) ? true : null), label, {
    ...options,
    describeLast: options.describeLast ?? (() => "false"),
  });
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
  await waitForCondition(() => settled, label, {
    ...options,
    describeLast: options.describeLast ?? (() => "pending"),
  });
  if (failure !== undefined) throw failure;
  return result as T;
}
