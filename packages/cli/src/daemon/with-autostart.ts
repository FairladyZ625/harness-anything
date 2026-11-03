import type { DaemonLaunchSpec } from "@harness-anything/daemon/internal/client/daemon-autostart";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { renderCliGuidance } from "../cli/guidance-plane.ts";

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
    readonly commandCategory: "operation" | "daemon-lifecycle";
  },
): Promise<JsonObject> {
  const startedAt = Date.now(),
    budgetMs = options.restartBudgetMs ?? 30_000;
  // The pid before the request is the only daemon this request can legitimately be answered by.
  // Reading it after a daemon_stopping answer instead races the replacement: a build-superseded
  // handoff answers a parked request and its successor rewrites the pid file within milliseconds,
  // so the post-answer read can already name the new generation and the generation wait below would
  // never observe a change.
  const { readDaemonPid } = await import("@harness-anything/daemon/internal/daemon-singleton"),
    outgoingPid = options.userRoot && options.daemonId ? readDaemonPid(options.userRoot, options.daemonId) : null;
  // Every request on every recovery branch passes through this one state machine. A successor may
  // bind its socket before its Keycloak identity authority is ready; that refusal proves nothing was
  // applied, so resend it once. The previous version only wrapped the first request, which let the
  // same refusal escape after a daemon_stopping handoff or an autostart reconnect.
  const requestWithIdentityRecovery = async (): Promise<{ result: JsonObject; identityRetries: number }> => {
    const first = await request();
    if (options.commandCategory === "daemon-lifecycle" || !isRetryableIdentityRefusal(first))
      return { result: first, identityRetries: 0 };
    await delay(250);
    return { result: await request(), identityRetries: 1 };
  };
  try {
    const attempt = await requestWithIdentityRecovery();
    let result = attempt.result,
      identityRetries = attempt.identityRetries;
    if (
      !isDaemonStopping(result) ||
      options.commandCategory === "daemon-lifecycle" ||
      !options.userRoot ||
      !options.daemonId
    )
      return withIdentityRetryMetadata(result, identityRetries, startedAt);
    const { DaemonAutostartError, ensureLocalDaemonRunning, waitForDaemonGenerationChange } = await import(
        "@harness-anything/daemon/internal/client/daemon-autostart"
      ),
      changed = await waitForDaemonGenerationChange({
        previousPid: outgoingPid,
        readPid: () => readDaemonPid(options.userRoot!, options.daemonId!),
        timeoutMs: Math.max(0, budgetMs - (Date.now() - startedAt)),
      });
    if (!changed.ok) return daemonRestartingReceipt(Date.now() - startedAt, 0);
    // A caller without autostart (a parked wait) must never spawn a daemon, and readiness probing
    // spawns one whenever the successor's socket is not bound yet. It resends straight away and a
    // still-unbound socket reaches that caller's own reconnect loop as an unreachable error.
    if (options.autostart) {
      // Leave room for autostart's two bounded socket probes so the whole
      // recovery path, including an unreachable Unix socket, stays inside the
      // caller-visible budget. A successor that records attach progress keeps
      // the wait alive within the same extension ceiling every other autostart
      // caller uses: the canonical checkout alone takes 20-30s to attach, so
      // abandoning a demonstrably progressing startup at the quiet budget is
      // what turned a daemon build handoff into a post-merge failure.
      const probeReserveMs = 550,
        remainingMs = budgetMs - (Date.now() - startedAt) - probeReserveMs;
      if (remainingMs <= 0) return daemonRestartingReceipt(Date.now() - startedAt, 0);
      const started = await ensureLocalDaemonRunning({
        socketPath,
        invokingRoot: options.invokingRoot,
        launch,
        readyTimeoutMs: remainingMs,
        onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
      });
      if (!started.ok) {
        // A runtime or worktree caller is allowed to wait for a supervisor-owned
        // replacement, but it must never inherit authority to spawn that daemon.
        if (started.code === "daemon_start_runtime_forbidden" || started.code === "daemon_start_noncanonical_checkout")
          return daemonRestartingReceipt(Date.now() - startedAt, 0);
        throw new DaemonAutostartError(started);
      }
    }
    try {
      const successor = await requestWithIdentityRecovery();
      result = successor.result;
      identityRetries += successor.identityRetries;
      if (isDaemonStopping(result))
        return daemonRestartingReceipt(Date.now() - startedAt, 1 + successor.identityRetries);
      return withIdentityRetryMetadata(result, 1 + identityRetries, startedAt);
    } catch (error) {
      const { isDaemonUnreachable } = await import("@harness-anything/daemon/internal/client/daemon-autostart");
      if (options.autostart && isDaemonUnreachable(error)) return daemonRestartingReceipt(Date.now() - startedAt, 1);
      throw error;
    }
  } catch (error) {
    if (!options.autostart) throw error;
    const {
      DaemonAutostartError,
      ensureLocalDaemonRunning,
      isDaemonUnreachable,
      readDaemonStoppedAt,
      runtimeDaemonStartRefusal,
    } = await import("@harness-anything/daemon/internal/client/daemon-autostart");
    if (!isDaemonUnreachable(error)) throw error;
    // The failed connection already proves this socket unavailable. A second socket probe can
    // consume its full timeout without adding evidence.
    const refusal = runtimeDaemonStartRefusal(options.env);
    if (refusal) throw new DaemonAutostartError({ ok: false, ...refusal, attempts: 0 });
    const stoppedAt =
      options.userRoot && options.daemonId ? readDaemonStoppedAt(options.userRoot, options.daemonId) : null;
    if (stoppedAt)
      throw new DaemonAutostartError({
        ok: false,
        code: "daemon_stopped_by_operator",
        hint: `The daemon was stopped by the operator at ${stoppedAt}. Run \`ha daemon start --service\` to start it.`,
        attempts: 0,
      });
    const started = await ensureLocalDaemonRunning({
      socketPath,
      invokingRoot: options.invokingRoot,
      launch,
      onProgress: (progress) => process.stderr.write(`${progress.message}\n`),
    });
    if (!started.ok) throw new DaemonAutostartError(started);
    const recovered = await requestWithIdentityRecovery();
    return withIdentityRetryMetadata(recovered.result, recovered.identityRetries, startedAt);
  }
}

/** Report a successful identity retry the same way a successful daemon restart is reported. */
function withIdentityRetryMetadata(result: JsonObject, retries: number, startedAt: number): JsonObject {
  if (retries === 0 || isKeycloakUnavailable(result) || isDaemonStopping(result)) return result;
  return { ...result, daemonRestart: { waitedMs: Date.now() - startedAt, retries } };
}

function isDaemonStopping(result: JsonObject): boolean {
  const error =
    result.error && typeof result.error === "object" && !Array.isArray(result.error)
      ? (result.error as JsonObject)
      : null;
  return result.code === "daemon_stopping" || error?.code === "daemon_stopping";
}

/** The daemon refused before applying the action because Keycloak did not answer in the startup window. */
function isKeycloakUnavailable(result: JsonObject): boolean {
  const error =
    result.error && typeof result.error === "object" && !Array.isArray(result.error)
      ? (result.error as JsonObject)
      : null;
  return result.code === "keycloak_unavailable" || error?.code === "keycloak_unavailable";
}

/** A refusal that proves the action never reached the ledger, so replaying it cannot duplicate a write. */
function isRetryableIdentityRefusal(result: JsonObject): boolean {
  return isKeycloakUnavailable(result) && (result.outcome === undefined || result.outcome === "op_rejected");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonRestartingReceipt(waitedMs: number, retries: number): JsonObject {
  const waitedSeconds = Math.ceil(waitedMs / 1_000),
    hint = renderCliGuidance("daemon-restarting", { waitedSeconds });
  return {
    ok: false,
    code: "daemon_restarting",
    error: { code: "daemon_restarting", hint },
    hint,
    daemonRestart: { waitedMs, retries },
  };
}
