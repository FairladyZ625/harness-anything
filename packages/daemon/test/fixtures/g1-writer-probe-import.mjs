// Worker preload for the G1 write-cost-scaling gate: installs the shared cost probe inside the
// canonical Writer and orchestration host, with a separate test-owned control port in each.
import { parentPort, workerData } from "node:worker_threads";
import { installCostProbe, resetCostProbe, snapshotCostProbe } from "./g1-cost-probe.mjs";

installCostProbe();

const control = workerData?.g1CostProbePort ?? parentPort;
control?.on("message", (message) => {
  if (message?.schema !== "g1-cost-probe-control/v1") return;
  if (message.command === "reset") {
    resetCostProbe();
    control.postMessage({ schema: "g1-cost-probe-ack/v1", requestId: message.requestId });
  } else if (message.command === "snapshot") {
    // The request queued the host publication turn before returning its receipt.
    // Snapshot one immediate later without issuing another production request.
    setImmediate(() =>
      control.postMessage({
        schema: "g1-cost-probe-result/v1",
        requestId: message.requestId,
        counters: snapshotCostProbe(),
      }),
    );
  }
});
