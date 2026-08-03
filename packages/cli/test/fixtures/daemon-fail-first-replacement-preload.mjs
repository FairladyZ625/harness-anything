import { existsSync, rmSync } from "node:fs";

const markerPath = process.env.HARNESS_TEST_DAEMON_REPLACEMENT_FAILURE_MARKER;
const isReplacementServe = process.argv.includes("daemon")
  && process.argv.includes("serve")
  && !process.argv.includes("--check");

if (markerPath && isReplacementServe && existsSync(markerPath)) {
  rmSync(markerPath, { force: true });
  process.exit(72);
}
