import { channel } from "node:diagnostics_channel";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Socket } from "node:net";
import { readDaemonPid } from "@harness-anything/daemon/internal/daemon-singleton";
import { readDaemonLifecycleRecords } from "@harness-anything/daemon/internal/lifecycle-log";
import type { timedDaemonRequest } from "../src/cli/timing.ts";

// Temporary evidence for the recurrent custom-Artifact connect failure. Delete this fixture and its
// caller once a failing CI trace identifies the cause and a deterministic regression covers the fix.
// Observe only sockets created synchronously by this request, never another fixture's connections.
export function artifactRpcDiagnostics(
  userRoot: string,
  daemonId: string,
  diagnostic: (line: string) => void,
): typeof timedDaemonRequest {
  return (request) =>
    async (...args) => {
      const { socketPath } = args[0] as { socketPath: string },
        before = snapshot(userRoot, daemonId, socketPath),
        startedAt = new Date().toISOString(),
        started = performance.now(),
        events: { event: string; elapsedMs: number; code?: string }[] = [],
        sockets: Socket[] = [],
        cleanups: (() => void)[] = [],
        socketChannel = channel("net.client.socket");
      let firstTimerTurnMs: number | null = null,
        outcome = "resolved";
      const turn = setTimeout(() => {
          firstTimerTurnMs = performance.now() - started;
        }, 0),
        observe = (message: unknown) => {
          const { socket } = message as { socket: Socket };
          sockets.push(socket);
          const connected = () => {
              events.push({ event: "connect", elapsedMs: performance.now() - started });
            },
            failed = (error: Error) => {
              events.push({ event: "error", elapsedMs: performance.now() - started, code: errorCode(error) });
            };
          events.push({ event: "created", elapsedMs: performance.now() - started });
          socket.once("connect", connected);
          socket.once("error", failed);
          cleanups.push(() => {
            socket.off("connect", connected);
            socket.off("error", failed);
          });
        };
      try {
        let pending;
        socketChannel.subscribe(observe);
        try {
          pending = request(...args);
        } finally {
          socketChannel.unsubscribe(observe);
        }
        return await pending;
      } catch (error) {
        outcome =
          error instanceof Error && error.message === "daemon_unavailable" ? "connect-deadline" : errorCode(error);
        throw error;
      } finally {
        const elapsedMs = performance.now() - started;
        clearTimeout(turn);
        for (const cleanup of cleanups) cleanup();
        diagnostic(
          JSON.stringify({
            schema: "release-artifact-rpc/v1",
            callerPid: process.pid,
            startedAt,
            endpoint: socketPath,
            transport: socketPath.startsWith("tcp://") ? "tcp" : process.platform === "win32" ? "pipe" : "unix",
            connectTimeoutMs: args[3],
            outcome,
            elapsedMs,
            firstTimerTurnMs,
            events,
            sockets: sockets.map((socket) => ({
              connecting: socket.connecting,
              destroyed: socket.destroyed,
              bytesRead: socket.bytesRead,
              bytesWritten: socket.bytesWritten,
            })),
            before,
            after: snapshot(userRoot, daemonId, socketPath),
            // Async server logs can lag; an absent conn_open is not proof that accept never happened.
            connections: connectionEvidence(userRoot, daemonId),
            // Only lifecycle fields relevant to startup/exit, never raw stderr, RPC params or credentials.
            lifecycle: lifecycleEvidence(userRoot, daemonId),
          }),
        );
      }
    };
}

function lifecycleEvidence(userRoot: string, daemonId: string) {
  try {
    return readDaemonLifecycleRecords(userRoot, daemonId)
      .slice(-12)
      .map(({ at, event, pid, endpoint, outcome, exitCode, signal }) => ({
        at,
        event,
        pid,
        endpoint,
        outcome,
        exitCode,
        signal,
      }));
  } catch (error) {
    return { readError: errorCode(error) };
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unclassified-error";
}

function snapshot(userRoot: string, daemonId: string, endpoint: string) {
  const pid = readDaemonPid(userRoot, daemonId);
  let processState = "no-pid",
    endpointState = "not-filesystem";
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      processState = "alive";
    } catch (error) {
      processState = errorCode(error);
    }
  }
  if (!endpoint.startsWith("tcp://") && process.platform !== "win32") {
    try {
      endpointState = statSync(endpoint, { bigint: true }).isSocket() ? "socket" : "not-socket";
    } catch (error) {
      endpointState = errorCode(error);
    }
  }
  return { pid, processState, endpointState };
}

function connectionEvidence(userRoot: string, daemonId: string) {
  try {
    const directory = path.join(userRoot, "logs"),
      stem = `daemon-${daemonId}-conn-`;
    return readdirSync(directory)
      .filter((name) => name.startsWith(stem))
      .sort()
      .slice(-2)
      .flatMap((name) =>
        readFileSync(path.join(directory, name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-12)
          .map((line) => {
            const { at, event, pid, conn, active, method, durationMs } = JSON.parse(line);
            return { at, event, pid, conn, active, method, durationMs };
          }),
      );
  } catch (error) {
    return { readError: errorCode(error) };
  }
}
