import { Session } from "node:inspector";
import { parentPort } from "node:worker_threads";

// An in-process Inspector session does not expose a TCP port. Capture only function locations;
// automatic resume happens in this worker, which stays responsive when the main thread pauses.
const session = new Session();
session.on("Debugger.paused", ({ params }) => {
  const stack = params.callFrames.slice(0, 32).map((frame) => ({
    functionName: frame.functionName,
    url: frame.url,
    lineNumber: frame.location.lineNumber,
    columnNumber: frame.location.columnNumber ?? 0,
  }));
  session.post("Debugger.resume", (error) => {
    parentPort!.postMessage({ status: error ? `resume_failed: ${error.message}` : "captured", stack });
    session.disconnect();
  });
});
session.connectToMainThread();
session.post("Debugger.enable", (error) => {
  if (error) {
    parentPort!.postMessage({ status: `unavailable: ${error.message}`, stack: [] });
    return;
  }
  session.post("Debugger.pause", (pauseError) => {
    if (pauseError) parentPort!.postMessage({ status: `unavailable: ${pauseError.message}`, stack: [] });
  });
});
