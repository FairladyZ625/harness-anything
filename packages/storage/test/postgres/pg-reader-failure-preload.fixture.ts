import { parentPort, workerData } from "node:worker_threads";

// Installed before the real worker entry to crash exactly when the first session begins.
parentPort!.on("message", ({ op }: { op: string }) => {
  if (op !== "begin") return;
  if (workerData.failureMode === "exit") process.exit(23);
  throw Object.assign(new Error("injected query worker crash"), { code: "injected_worker_crash" });
});
