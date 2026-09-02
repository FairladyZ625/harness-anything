import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";

// The autostart seam is imported lazily so the thin dist static import graph stays
// entry/parser/transport-only; it is only reachable on a connection-level failure.
// The autostart seam is imported lazily so the thin dist static import graph stays
// entry/parser/transport-only; it is only reachable on a connection-level failure.
export async function withAutostart(
  request: () => Promise<JsonObject>,
  launch: () => DaemonLaunchSpec,
  socketPath: string,
  options: { readonly autostart: boolean; readonly env: NodeJS.ProcessEnv; readonly invokingRoot: string },
): Promise<JsonObject> {
  try {
    return await request();
  } catch (error) {
    if (!options.autostart) throw error;
    const { DaemonAutostartError, ensureLocalDaemonRunning, isDaemonUnreachable, runtimeDaemonStartRefusal } =
      await import("../../../daemon/src/client/daemon-autostart.ts");
    const buildStale = isDaemonBuildStale(error);
    if (!buildStale && !isDaemonUnreachable(error)) throw error;
    if (buildStale) await waitForDaemonRestart(socketPath);
    // The failed connection (or the completed stale-daemon shutdown wait) already proves this
    // socket unavailable. A second socket probe can consume its full timeout without adding evidence.
    const refusal = runtimeDaemonStartRefusal(options.env);
    if (refusal) throw new DaemonAutostartError({ ok: false, ...refusal, attempts: 0 });
    const started = await ensureLocalDaemonRunning({
      socketPath,
      invokingRoot: options.invokingRoot,
      launch,
      onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
    });
    if (!started.ok) throw new DaemonAutostartError(started);
    return await request();
  }
}
function isDaemonBuildStale(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { readonly code?: unknown }).code === "daemon_build_stale"
  );
}
async function waitForDaemonRestart(socketPath: string): Promise<void> {
  const { daemonSocketProbe } = await import("../../../daemon/src/client/daemon-autostart.ts"),
    deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await daemonSocketProbe(socketPath))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
