export interface PollUntilOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export async function pollUntil<T>(
  inspect: () => T | Promise<T>,
  expected: (value: T) => boolean,
  diagnostic: (value: T | undefined, error: unknown) => string,
  options: PollUntilOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      lastValue = await inspect();
      lastError = undefined;
      if (expected(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() < deadline) await delay(intervalMs);
  }

  throw new Error(`condition did not converge within ${timeoutMs}ms: ${diagnostic(lastValue, lastError)}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
