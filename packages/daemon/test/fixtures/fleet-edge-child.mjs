import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runFleetReplicaPullClient, runFleetWriteClient } from "../../src/fleet/edge.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!spawnSync("git", ["--version"]).error) throw new Error("edge test PATH unexpectedly contains Git");
if (config.startDelayMs) await delay(config.startDelayMs);
const body = readFileSync(config.bodyFile), startedAt = Date.now(); let attempts = 0;
for (;;) {
  try {
    const peer = { ...config, ca: readFileSync(config.caFile) }, diskQuotaBytes = config.diskQuotaBytes ?? 64 * 1024 * 1024; await runFleetReplicaPullClient({ ...peer, diskQuotaBytes }); const onFrame = (frame) => {
      if (config.killOnSchema === frame.schema) { if (config.markerFile) writeFileSync(config.markerFile, frame.schema); process.exit(73); }
      if (config.killAfterPartialUpload && frame.schema === "fleet.upload.ready/v1" && frame.resumeOffset > 0 && frame.resumeOffset < body.byteLength) { if (config.markerFile) writeFileSync(config.markerFile, String(frame.resumeOffset)); process.exit(74); }
    }; const write = await runFleetWriteClient({ ...peer, changes: [{ path: config.path, body, baseBlobSha256: config.baseBlobSha256 }], onFrame }); if (write.center.outcome !== "applied") throw new Error(`center write ${write.center.outcome}:${write.center.code ?? "retry"}`); const pulled = await runFleetReplicaPullClient({ ...peer, diskQuotaBytes, onFrame, edgeKillpoint: (point) => { if (config.edgeKillpoint === point) { if (config.markerFile) writeFileSync(config.markerFile, point); process.exit(75); } } });
    process.stdout.write(`${JSON.stringify({ ok: true, label: config.label, repoId: config.repoId, attempts: attempts + 1, gitAbsent: true, startedAt, endedAt: Date.now(), center: write.center, replica: pulled.replica })}\n`); break;
  } catch (error) { attempts += 1; if (!config.retry || attempts >= (config.maxAttempts ?? 40)) throw error; await delay(20 + Math.floor(Math.random() * 80)); if (config.markerFile && existsSync(config.markerFile)) break; }
}
