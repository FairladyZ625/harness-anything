import { existsSync } from "node:fs";
import os from "node:os";

if (process.argv.includes("--check") && process.env.HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_BACKGROUND === "1") {
  if (process.platform !== "win32") os.setPriority(19);
  const delayMs = Number(process.env.HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_DELAY_MS);
  const markerPath = process.env.HARNESS_TEST_DAEMON_REFRESH_PREFLIGHT_DELAY_MARKER;
  if (Number.isSafeInteger(delayMs) && delayMs > 0 && markerPath && existsSync(markerPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}
