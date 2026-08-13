import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runFleetEdgeClient } from "../../src/fleet/edge.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!spawnSync("git", ["--version"]).error) throw new Error("edge test PATH unexpectedly contains Git");
if (config.startDelayMs) await delay(config.startDelayMs);
const body = readFileSync(config.bodyFile), startedAt = Date.now(); let attempts = 0;
for (;;) {
  try {
    const result = await runFleetEdgeClient({ ...config, ca: readFileSync(config.caFile), changes: [{ path: config.path, body, baseBlobSha256: config.baseBlobSha256 }], onFrame: (frame) => {
      if (config.killOnSchema === frame.schema) { if (config.markerFile) writeFileSync(config.markerFile, frame.schema); process.exit(73); }
      if (config.killAfterPartialUpload && frame.schema === "fleet.upload.ready/v1" && frame.resumeOffset > 0 && frame.resumeOffset < body.byteLength) { if (config.markerFile) writeFileSync(config.markerFile, String(frame.resumeOffset)); process.exit(74); }
    }, edgeKillpoint: (point) => { if (config.edgeKillpoint === point) { if (config.markerFile) writeFileSync(config.markerFile, point); process.exit(75); } } });
    process.stdout.write(`${JSON.stringify({ ok: true, label: config.label, repoId: config.repoId, attempts: attempts + 1, gitAbsent: true, startedAt, endedAt: Date.now(), center: result.center, replica: result.replica })}\n`); break;
  } catch (error) { attempts += 1; if (!config.retry || attempts >= (config.maxAttempts ?? 40)) throw error; await delay(20 + Math.floor(Math.random() * 80)); if (config.markerFile && existsSync(config.markerFile)) break; }
}
