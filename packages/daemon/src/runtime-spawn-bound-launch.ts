import { prepareBoundRuntimeLaunch } from "./runtime-spawn-context.ts";
import { launchRuntimeProcess } from "./runtime-spawn-process.ts";

/** Bind execution credentials before the provider process is launched. */
export async function launchBoundRuntimeProcess(
  launch: Parameters<typeof launchRuntimeProcess>[0],
  input: Parameters<typeof prepareBoundRuntimeLaunch>[0],
  stream: Parameters<typeof launchRuntimeProcess>[2],
  providerSessionId: Parameters<typeof launchRuntimeProcess>[3],
) {
  const workerLaunch = await prepareBoundRuntimeLaunch(input);
  return launchRuntimeProcess(launch, workerLaunch, stream, providerSessionId);
}
