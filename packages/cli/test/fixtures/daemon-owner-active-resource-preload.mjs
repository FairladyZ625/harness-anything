import { existsSync, writeFileSync } from "node:fs";

const markerPath = process.env.HARNESS_TEST_DAEMON_OWNER_RESOURCE_MARKER;
const evidencePath = process.env.HARNESS_TEST_DAEMON_OWNER_RESOURCE_EVIDENCE;

if (process.env.HARNESS_DAEMON_SERVER_HOST === "1" && markerPath && evidencePath && !existsSync(markerPath)) {
  writeFileSync(markerPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  setInterval(() => {
    writeFileSync(evidencePath, `${JSON.stringify({
      pid: process.pid,
      resources: process.getActiveResourcesInfo()
    })}\n`, "utf8");
  }, 25);
}
