export async function readDaemonStatusWithGenerationFallback(
  includeGenerationAxes: boolean,
  request: (includeAxes: boolean, includeDeploymentIdentity: boolean) => Promise<Record<string, unknown>>,
  includeDeploymentIdentity = false
): Promise<Record<string, unknown> | undefined> {
  const attempts = [
    ...(includeDeploymentIdentity ? [{ axes: includeGenerationAxes, deployment: true }] : []),
    ...(includeGenerationAxes ? [{ axes: true, deployment: false }] : []),
    { axes: false, deployment: false }
  ].filter((attempt, index, all) => all.findIndex((candidate) => candidate.axes === attempt.axes && candidate.deployment === attempt.deployment) === index);
  for (const [index, attempt] of attempts.entries()) {
    try {
      const receipt = await request(attempt.axes, attempt.deployment);
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
