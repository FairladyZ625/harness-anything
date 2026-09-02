import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";

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
    if (!isDaemonUnreachable(error)) throw error;
    // The failed connection already proves this socket unavailable. A second socket probe can
    // consume its full timeout without adding evidence.
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
