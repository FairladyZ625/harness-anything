import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { openDaemonDiagnostics } from "../src/daemon-diagnostics.ts";
import { withDaemonObservation, markDaemonOperationPhase } from "../src/daemon-operation.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import { startDaemon } from "../src/runtime.ts";

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
        host: {
          status: () => {
            if (armed) {
              markDaemonOperationPhase(mode);
              process.send!({ blocking: true });
              if (mode === "native") Atomics.wait(control, 0, 0, 2_500);
              else {
                const until = performance.now() + 2_500;
                while (performance.now() < until) {
                  /* fault injection */
                }
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
