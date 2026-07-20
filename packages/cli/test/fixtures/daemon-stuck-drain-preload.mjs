import { existsSync, writeFileSync } from "node:fs";

const markerPath = process.env.HARNESS_TEST_DAEMON_STUCK_DRAIN_MARKER;

if (process.env.HARNESS_DAEMON_SERVER_HOST === "1" && markerPath && !existsSync(markerPath)) {
  writeFileSync(markerPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  process.env.HARNESS_TEST_DAEMON_RUNTIME_DRAIN_STUCK = "1";
}
