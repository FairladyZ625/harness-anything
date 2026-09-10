// Worker preload for the G1 write-cost-scaling gate: installs the shared cost probe inside the
// writer worker thread (where durable writes actually execute) and answers reset/snapshot
// control messages from the parent thread over the existing worker message channel.
import { parentPort } from "node:worker_threads";
import { installCostProbe, resetCostProbe, snapshotCostProbe } from "./g1-cost-probe.mjs";

installCostProbe();

parentPort?.on("message", (message) => {
  if (message?.schema !== "g1-cost-probe-control/v1") return;
  if (message.command === "reset") {
    resetCostProbe();
    parentPort.postMessage({ schema: "g1-cost-probe-ack/v1", requestId: message.requestId });
  } else if (message.command === "snapshot") {
    // An append settles the Git/worktree follower from a setImmediate it queues before the
    // response goes out (sqlite-task-event-store.ts scheduleFollower). Snapshotting one immediate
    // turn later closes the window after that settlement without scheduling another one.
    setImmediate(() =>
      parentPort.postMessage({
        schema: "g1-cost-probe-result/v1",
        requestId: message.requestId,
        counters: snapshotCostProbe(),
      }),
    );
  }
});
