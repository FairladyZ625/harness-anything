import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { withDaemonObservation, markDaemonOperationPhase } from "../src/daemon-operation.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import { startDaemon } from "../src/runtime.ts";
import { existsSync } from "node:fs";
import path from "node:path";

const userRoot = process.argv[2]!,
  endpoint = process.argv[3]!,
  mode = process.argv[4]!,
  control = new Int32Array(new SharedArrayBuffer(4));
let armed = false;
if (mode === "drain") {
  let release!: () => void;
  const drain = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = await startDaemon({
    userRoot,
    endpoint,
    daemonId: "diagnostics-fixture",
    runtimeDiscover: () => [],
    managedRbac: {
      run: async () => ({ ok: true }),
      resume: async () => {},
      loginListenerCertificate: () => null,
      stop: async () => {
        process.send!({ draining: true });
        await drain;
      },
    },
  });
  if (!("stop" in running)) throw new Error("Fixture singleton not acquired");
  process.on("message", (message) => {
    if (message === "stop") void running.stop().then(() => process.disconnect());
    if (message === "release") release();
  });
} else {
  const diagnostics = await openDaemonDiagnostics({
    userRoot,
    endpoint,
    daemonId: "diagnostics-fixture",
    heartbeatMs: 20,
    stallThresholdMs: 150,
    metricsIntervalMs: 50,
  });
  const transport = createUnixSocketTransportServer({
    daemonId: "diagnostics-fixture",
    socketPath: endpoint,
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({
        operationObserver: diagnostics.observer,
        host: {
          status: () => {
            if (armed) {
              markDaemonOperationPhase(mode);
              process.send!({ blocking: true });
              // Fault injection: the stall lasts at least 2.5 s (the test asserts a stall of 2 s or more)
              // and ends only after the test has observed it and written the release file, so the
              // test never races a stall that the wall clock ended first.
              const release = path.join(userRoot, "release-stall"),
                minimumEnd = performance.now() + 2_500;
              while (!existsSync(release) || performance.now() < minimumEnd) {
                if (mode === "native") Atomics.wait(control, 0, 0, 50);
              }
              armed = false;
            }
            return { daemonId: "diagnostics-fixture", pid: process.pid, repos: [], summary: "fixture" };
          },
        } as unknown as DaemonHost,
        build: { loadedBuildId: null, commit: null, builtAt: null },
        authContext,
        emit,
      }),
  });
  await withDaemonObservation(diagnostics.observer, () => transport.start());
  diagnostics.state("running");
  process.on("message", (message) => {
    if (message === "arm") {
      armed = true;
      process.send!({ armed: true });
    }
    if (message === "close")
      void transport
        .stop()
        .then(() => diagnostics.close())
        .then(() => process.disconnect());
  });
}
process.send!({ ready: true });
