import { readFileSync, writeFileSync } from "node:fs";
import { runFleetWriteClient } from "../../../src/fleet/edge.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8")),
  body = readFileSync(config.bodyFile);

if (config.readyFile) {
  writeFileSync(config.readyFile, "ready\n");
  await new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) resolve();
    });
    process.stdin.on("end", () => reject(new Error("upload barrier closed before release")));
    process.stdin.on("error", reject);
  });
}

const pause = (boundary, frame) => {
  writeFileSync(config.boundaryFile, `${JSON.stringify({ boundary, frame })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const result = await runFleetWriteClient({
  port: config.port,
  ca: readFileSync(config.caFile),
  servername: "localhost",
  nodeId: config.nodeId,
  credential: config.credential,
  assignmentId: config.assignmentId,
  channel: "collaborator",
  executionId: null,
  baseLedgerSha: config.baseLedgerSha,
  changes: [{ path: config.path, body, baseBlobSha256: config.baseBlobSha256 ?? null }],
  onFrame: (frame) => {
    if (
      config.pauseAt === "durable-prefix" &&
      frame.schema === "fleet.upload.ready/v1" &&
      frame.resumeOffset > 0 &&
      frame.resumeOffset < body.byteLength
    )
      pause("durable-prefix-before-finish", frame);
    if (config.pauseAt === "upload-commit" && frame.schema === "fleet.upload.result/v1")
      pause("upload-commit-before-client-ack", frame);
  },
});
writeFileSync(config.resultFile, `${JSON.stringify(result)}\n`);
