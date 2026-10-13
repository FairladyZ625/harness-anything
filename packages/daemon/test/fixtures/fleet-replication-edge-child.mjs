// Fleet replication edge child: a real OS process acting as one edge replica.
// It runs the new replication receiver (A 分片 packages/daemon/src/fleet/walreceiver.ts) against a
// live center over TLS, with a PATH that contains no Git — the "干净 Git-less edge" of the
// process-level 1 中心 + 3 边缘 fixture. Communication with the driving test:
//   stdout  one JSON line per receiver event (see emit() below)
//   stdin   {"control":"release-acks"} opens an ACK gate previously held by config.holdAcks
// Exit codes follow the fleet-edge-child convention: 73 killed on a watched frame schema,
// 74 killed after basebackup install before its ACK, 75 killed after a durable record write
// before its ACK, 76 killed after package verification before generation install.
// 待对齐(dec_9284BD61 C 分片): runFleetWalReceiver 的入参与事件名是本任务拟定的接口,
// A 分片落地 walreceiver.ts 时按本文件与 fleet-replication.fixture.ts 的对齐表核对。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runFleetWalReceiver } from "../../src/fleet/walreceiver.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!spawnSync("git", ["--version"]).error) throw new Error("edge test PATH unexpectedly contains Git");

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let acksReleased = !config.holdAcks;
const releaseAcks = () => {
  acksReleased = true;
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    const control = JSON.parse(line);
    if (control.control === "release-acks") releaseAcks();
    else throw new Error(`unknown edge child control: ${line}`);
  }
});
if (!acksReleased) emit({ event: "acks-held" });

const killpoints = new Set(config.killpoints ?? []);
const exitCodeFor = {
  "after-package-verified-before-install": 76,
  "after-install-before-ack": 74,
  "after-durable-before-ack": 75,
};
let attempts = 0;
for (;;) {
  try {
    const settled = await runFleetWalReceiver({
      port: config.port,
      ca: readFileSync(config.caFile),
      servername: config.servername,
      nodeId: config.nodeId,
      credential: config.credential,
      repoId: config.repoId,
      mirrorRoot: config.mirrorRoot,
      readAccessToken: async () => `device-token-${config.nodeId}`,
      onEvent: (event) => {
        emit(event);
        if (config.killOnSchema === event.frameSchema) process.exit(73);
      },
      killpoint: (point) => {
        if (!killpoints.has(point)) return false;
        emit({ event: "killpoint", point });
        process.exit(exitCodeFor[point] ?? 73);
      },
      ackGate: () => (acksReleased ? undefined : heldAckGate()),
    });
    emit({ event: "exit", reason: "settled", historyId: settled.historyId, sequence: settled.sequence });
    break;
  } catch (error) {
    attempts += 1;
    if (!config.retry || attempts >= (config.maxAttempts ?? 3)) {
      emit({
        event: "error",
        code: error && typeof error.code === "string" ? error.code : null,
        message: String(error && error.message ? error.message : error),
      });
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The ACK gate resolves only on the release-acks control, so a held edge keeps its durable
// cursor without confirming it — the state a lagging node is in when the retention window moves.
function heldAckGate() {
  return new Promise((resolve) => {
    const wasReleased = () => {
      if (!acksReleased) {
        setTimeout(wasReleased, 10);
        return;
      }
      resolve(undefined);
    };
    wasReleased();
  });
}
