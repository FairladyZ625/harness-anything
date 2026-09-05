import type { DaemonLaunchSpec } from "../../../daemon/src/client/daemon-autostart.ts";
import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";

// The autostart seam is imported lazily so the thin dist static import graph stays
// entry/parser/transport-only; it is only reachable on a connection-level failure.
export async function withAutostart(
  request: () => Promise<JsonObject>,
  launch: () => DaemonLaunchSpec,
  socketPath: string,
  options: {
    readonly autostart: boolean;
    readonly env: NodeJS.ProcessEnv;
    readonly invokingRoot: string;
    readonly userRoot?: string;
    readonly daemonId?: string;
    readonly restartBudgetMs?: number;
  },
): Promise<JsonObject> {
  const startedAt = Date.now();
  try {
    const result = await request();
    if (!isDaemonStopping(result) || !options.userRoot || !options.daemonId) return result;
    const { readDaemonPid } = await import("../../../daemon/src/daemon-singleton.ts"),
      { DaemonAutostartError, ensureLocalDaemonRunning, waitForDaemonGenerationChange } = await import(
        "../../../daemon/src/client/daemon-autostart.ts"
      ),
      outgoingPid = readDaemonPid(options.userRoot, options.daemonId),
      budgetMs = options.restartBudgetMs ?? 30_000,
      changed = await waitForDaemonGenerationChange({
        previousPid: outgoingPid,
        readPid: () => readDaemonPid(options.userRoot!, options.daemonId!),
        timeoutMs: Math.max(0, budgetMs - (Date.now() - startedAt)),
      });
    if (!changed.ok) return daemonRestartingReceipt(Date.now() - startedAt, 0);
    // Leave room for autostart's two bounded socket probes so the whole
    // recovery path, including an unreachable Unix socket, stays inside the
    // caller-visible budget.
    const probeReserveMs = 550,
      remainingMs = budgetMs - (Date.now() - startedAt) - probeReserveMs;
    if (remainingMs <= 0) return daemonRestartingReceipt(Date.now() - startedAt, 0);
    const started = await ensureLocalDaemonRunning({
      socketPath,
      invokingRoot: options.invokingRoot,
      launch,
      readyTimeoutMs: remainingMs,
      extendTimeoutWhileProgressing: false,
      onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
    });
    if (!started.ok) {
      // A runtime or worktree caller is allowed to wait for a supervisor-owned
      // replacement, but it must never inherit authority to spawn that daemon.
      if (started.code === "daemon_start_runtime_forbidden" || started.code === "daemon_start_noncanonical_checkout")
        return daemonRestartingReceipt(Date.now() - startedAt, 0);
      throw new DaemonAutostartError(started);
    }
    try {
      const retried = await request();
      if (isDaemonStopping(retried)) return daemonRestartingReceipt(Date.now() - startedAt, 1);
      return { ...retried, daemonRestart: { waitedMs: Date.now() - startedAt, retries: 1 } };
    } catch (error) {
      const { isDaemonUnreachable } = await import("../../../daemon/src/client/daemon-autostart.ts");
      if (isDaemonUnreachable(error)) return daemonRestartingReceipt(Date.now() - startedAt, 1);
      throw error;
    }
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

function isDaemonStopping(result: JsonObject): boolean {
  const error =
    result.error && typeof result.error === "object" && !Array.isArray(result.error)
      ? (result.error as JsonObject)
      : null;
  return result.code === "daemon_stopping" || error?.code === "daemon_stopping";
}

function daemonRestartingReceipt(waitedMs: number, retries: number): JsonObject {
  const waitedSeconds = Math.ceil(waitedMs / 1_000),
    hint = `daemon is restarting (old build -> new build); waited ${waitedSeconds}s but it is not ready`;
  return {
    ok: false,
    code: "daemon_restarting",
    error: { code: "daemon_restarting", hint },
    hint,
    daemonRestart: { waitedMs, retries },
  };
}
