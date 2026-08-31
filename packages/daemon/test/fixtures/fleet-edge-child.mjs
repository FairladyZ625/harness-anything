import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runFleetReplicaPullClient, runFleetWriteClient } from "../../src/fleet/edge.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!spawnSync("git", ["--version"]).error) throw new Error("edge test PATH unexpectedly contains Git");
if (config.startDelayMs) await delay(config.startDelayMs);
const body = readFileSync(config.bodyFile);
let attempts = 0,
  released = !config.writeBarrier;
async function waitForWriteRelease() {
  process.stdout.write(`${JSON.stringify({ event: "write-ready", label: config.label })}\n`);
  await new Promise((resolve, reject) => {
    let input = "";
    const cleanup = () => {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        process.stdin.off("error", onError);
        process.stdin.pause();
      },
      onData = (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        cleanup();
        released = true;
        resolve();
      },
      onEnd = () => {
        cleanup();
        reject(new Error("write barrier closed before release"));
      },
      onError = (error) => {
        cleanup();
        reject(error);
      };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}
for (;;) {
  try {
    const peer = { ...config, ca: readFileSync(config.caFile) },
      diskQuotaBytes = config.diskQuotaBytes ?? 64 * 1024 * 1024;
    await runFleetReplicaPullClient({ ...peer, diskQuotaBytes });
    if (!released) await waitForWriteRelease();
    const startedAt = Date.now();
    const onFrame = (frame) => {
      if (config.killOnSchema === frame.schema) {
        if (config.markerFile) writeFileSync(config.markerFile, frame.schema);
        process.exit(73);
      }
      if (
        config.killAfterPartialUpload &&
        frame.schema === "fleet.upload.ready/v1" &&
        frame.resumeOffset > 0 &&
        frame.resumeOffset < body.byteLength
      ) {
        if (config.markerFile) writeFileSync(config.markerFile, String(frame.resumeOffset));
        process.exit(74);
      }
    };
    const write = await runFleetWriteClient({
      ...peer,
      channel: "replica",
      changes: [{ path: config.path, body, baseBlobSha256: config.baseBlobSha256 }],
      onFrame,
    });
    if (write.center.outcome !== "applied")
      throw new Error(`center write ${write.center.outcome}:${write.center.code ?? "retry"}`);
    const pulled = await runFleetReplicaPullClient({
      ...peer,
      diskQuotaBytes,
      onFrame,
      edgeKillpoint: (point) => {
        if (config.edgeKillpoint === point) {
          if (config.markerFile) writeFileSync(config.markerFile, point);
          process.exit(75);
        }
      },
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, label: config.label, repoId: config.repoId, attempts: attempts + 1, gitAbsent: true, startedAt, endedAt: Date.now(), center: write.center, replica: pulled.replica })}\n`,
    );
    break;
  } catch (error) {
    attempts += 1;
    if (!config.retry || attempts >= (config.maxAttempts ?? 40)) throw error;
    await delay(20 + Math.floor(Math.random() * 80));
    if (config.markerFile && existsSync(config.markerFile)) break;
  }
}
