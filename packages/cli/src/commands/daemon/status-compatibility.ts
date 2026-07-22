export async function readDaemonStatusWithGenerationFallback(
  includeGenerationAxes: boolean,
  request: (includeAxes: boolean) => Promise<Record<string, unknown>>
): Promise<Record<string, unknown> | undefined> {
  const attempts = includeGenerationAxes ? [true, false] : [false];
  for (const [index, includeAxes] of attempts.entries()) {
    try {
      const receipt = await request(includeAxes);
      const details = isDaemonStatusRecord(receipt.details) ? receipt.details : {};
      const data = isDaemonStatusRecord(details.data) ? details.data : undefined;
      if (receipt.ok === true && data) return data;
      if (index === attempts.length - 1) return { rpcError: receipt };
    } catch {
      if (index === attempts.length - 1) return undefined;
    }
  }
  return undefined;
}

function isDaemonStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
