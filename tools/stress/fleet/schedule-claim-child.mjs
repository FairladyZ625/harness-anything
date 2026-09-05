import { readFileSync } from "node:fs";
import { runFleetScheduleCommandClient } from "../../../packages/daemon/src/fleet/edge.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));

process.stdout.write(`${JSON.stringify({ event: "ready", nodeId: config.nodeId })}\n`);
await new Promise((resolve, reject) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.includes("\n")) resolve();
  });
  process.stdin.on("error", reject);
  process.stdin.on("end", () => reject(new Error("claim barrier closed before release")));
});

const result = await runFleetScheduleCommandClient({
  hostname: config.host,
  port: config.port,
  ca: readFileSync(config.caFile),
  servername: config.servername,
  nodeId: config.nodeId,
  credential: config.credential,
  assignmentId: config.assignmentId,
  repoId: config.repoId,
  scheduleId: config.scheduleId,
  opId: config.opId,
  action: config.action,
});

process.stdout.write(`${JSON.stringify({ event: "result", nodeId: config.nodeId, result })}\n`);
