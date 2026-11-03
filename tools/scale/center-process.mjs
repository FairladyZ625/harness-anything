// Benchmark-owned child: product runtime, product transports, and IPC-only fault/measurement controls.
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { startDaemon } from "../../packages/daemon/src/runtime.ts";
import { openRepoCell } from "../../packages/daemon/src/repo-cell-open.ts";
import { openSqliteEventStore } from "../../packages/storage/src/store/sqlite-event-store.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let daemon,
  drifted = false,
  closeGate = null,
  releaseClose = null,
  generation = 0;
let lastCpu = process.cpuUsage(),
  lastTime = performance.now();
const send = (message) => process.send?.(message);
async function launch() {
  daemon = await startDaemon({
    daemonId: "center-bench",
    userRoot: config.userRoot,
    runtimeDiscover: () => [],
    shutdownDeadlineMs: 5000,
    buildObserver: {
      status: () => ({
        commit: null,
        entry: "dist",
        loadedBuildId: "bench-a",
        diskBuildId: drifted ? "bench-b" : "bench-a",
        drifted,
      }),
    },
    openCell: async (input) => {
      const cell = await openRepoCell(input);
      return {
        ...cell,
        close: async () => {
          if (closeGate) {
            send({ event: "drain-entered" });
            await closeGate;
          }
          await cell.close();
        },
      };
    },
    onSupersededExit: async () => {
      send({ event: "build_superseded", generation });
      drifted = false;
      await launch();
    },
  });
  if (!("stop" in daemon)) throw new Error("benchmark child failed singleton claim");
  generation++;
  send({ event: "listening", endpoint: daemon.endpoint, generation });
}

process.on("message", (message) => {
  void (async () => {
    if (message.command === "sample") {
      const at = performance.now(),
        cpu = process.cpuUsage(),
        elapsedMs = at - lastTime;
      const result = {
        rssBytes: process.memoryUsage().rss,
        cpuPercent: ((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000 / elapsedMs) * 100,
        eventLoopP99Ms: loop.percentile(99) / 1e6,
        eventLoopMaxMs: loop.max / 1e6,
        elapsedMs,
        generation,
      };
      lastCpu = cpu;
      lastTime = at;
      loop.reset();
      send({ id: message.id, result });
    } else if (message.command === "position") {
      const store = openSqliteEventStore({ rootInput: config.rootDir, repoId: config.repoId, readOnly: true });
      try {
        send({ id: message.id, result: { position: store.replicationPosition(), epoch: store.writerFence()?.epoch } });
      } finally {
        store.close();
      }
    } else if (message.command === "hold-drain") {
      closeGate = new Promise((resolve) => {
        releaseClose = resolve;
      });
      send({ id: message.id, result: true });
    } else if (message.command === "release-drain") {
      releaseClose?.();
      closeGate = null;
      releaseClose = null;
      send({ id: message.id, result: true });
    } else if (message.command === "supersede") {
      drifted = true;
      send({ id: message.id, result: true });
    } else if (message.command === "stop") {
      releaseClose?.();
      closeGate = null;
      await daemon.stop();
      loop.disable();
      send({ id: message.id, result: true });
      process.disconnect();
    } else throw new Error(`unknown benchmark control: ${message.command}`);
  })().catch((error) => send({ id: message.id, error: error.stack ?? String(error) }));
});
await launch();
