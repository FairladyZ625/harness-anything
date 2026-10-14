// Fleet replication edge child: a real OS process acting as one edge replica.
// It composes the A-shard replication core (runWalReceiver + replica-generation) over an
// authenticated TLS session, with a PATH that contains no Git — the "干净 Git-less edge" of the
// process-level 1 中心 + 3 边缘 fixture. Communication with the driving test:
//   stdout  one JSON line per event: backup-header / installed / applied / ack /
//           resync-required / killpoint / error / exit
//   stdin   {"control":"release-acks"} opens an ACK gate previously held by config.holdAcks
// Exit codes follow the fleet-edge-child convention: 74 killed after basebackup install
// before its ACK, 75 killed after a durable commit apply before its ACK, 76 killed after
// package verification before generation install.
// 会话接线说明: 中心 listener 尚未在已认证会话上服务复制帧(A/B 分片剩余工作)。本子进程
// 自行组合 session hello(contract.ts)与复制流(protocol.ts);产品接线落地后,此处应改用
// 产品的边缘入口,组合逻辑不进生产码。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";
import { parseFleetFrame, serializeFleetFrame } from "../../src/fleet/command-protocol.ts";
import { parseReplicationFrame, serializeReplicationFrame } from "../../src/fleet/protocol.ts";
import { runWalReceiver, openWalReceiverGeneration } from "../../src/fleet/walreceiver.ts";
import {
  createReplicaGenerationReader,
  installReplicaGeneration,
  readReplicaGeneration,
} from "../../src/fleet/replica-generation.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!spawnSync("git", ["--version"]).error) throw new Error("edge test PATH unexpectedly contains Git");

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

let acksReleased = !config.holdAcks;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    const control = JSON.parse(line);
    if (control.control === "release-acks") acksReleased = true;
    else throw new Error(`unknown edge child control: ${line}`);
  }
});
if (!acksReleased) emit({ event: "acks-held" });
const ackGate = () =>
  new Promise((resolve) => {
    const poll = () => (acksReleased ? resolve(undefined) : setTimeout(poll, 10));
    poll();
  });

const killpoints = new Set(config.killpoints ?? []);
const exitCodeFor = {
  "after-package-verified-before-install": 76,
  "after-install-before-ack": 74,
  "after-durable-before-ack": 75,
};
const maybeKill = (point) => {
  if (!killpoints.has(point)) return;
  emit({ event: "killpoint", point });
  process.exit(exitCodeFor[point] ?? 73);
};

const mirrorRoot = config.mirrorRoot,
  quotaBytes = config.diskQuotaBytes ?? 64 * 1024 * 1024,
  readers = createReplicaGenerationReader(mirrorRoot);
let attempts = 0;
for (;;) {
  try {
    await runOneSession();
    emit({ event: "exit", reason: "settled" });
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

async function runOneSession() {
  const socket = await new Promise((resolve, reject) => {
    const candidate = connect(
      { host: "127.0.0.1", port: config.port, ca: readFileSync(config.caFile), servername: config.servername },
      () => resolve(candidate),
    );
    candidate.once("error", reject);
  });
  socket.on("error", () => undefined);
  let buffer = "";
  const lines = [];
  const waiters = [];
  const rejects = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const waiter = waiters.shift();
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  socket.on("close", () => {
    while (rejects.length) rejects.shift()(new Error("replication socket closed"));
  });
  const nextLine = () =>
    lines.length
      ? Promise.resolve(lines.shift())
      : new Promise((resolve, reject) => {
          waiters.push(resolve);
          rejects.push(reject);
        });
  socket.write(
    serializeFleetFrame({
      schema: "fleet.session.hello/v1",
      messageId: "hello",
      protocolVersion: { major: 1, minor: 0 },
      nodeId: config.nodeId,
      credential: config.credential,
      accessToken: `device-token-${config.nodeId}`,
    }),
  );
  const ready = parseFleetFrame(await nextLine());
  if (ready.schema !== "fleet.session.ready/v1") throw new Error(`session rejected: ${ready.schema}`);
  emit({ event: "connected", sessionId: ready.sessionId });

  const observed = [];
  const peer = {
    send: async (frame) => {
      if (frame.type === "replica.ack") {
        await ackGate();
        emit({ event: "ack", durable: frame.durable, applied: frame.applied });
      }
      socket.write(serializeReplicationFrame(frame));
    },
    receive: async () => {
      const frame = parseReplicationFrame(await nextLine());
      if (frame.type === "replica.backup") {
        emit({
          event: "backup-header",
          position: frame.metadata.position,
          ledgerGeneration: frame.metadata.ledgerGeneration,
          projectionSchema: frame.metadata.projectionSchema,
          size: frame.size,
          sha256: frame.sha256,
        });
      } else if (frame.type === "replica.resync") {
        emit({ event: "resync-required", reason: frame.reason });
      }
      observed.push(frame.type);
      return frame;
    },
  };

  let opened = null;
  const existing = readReplicaGeneration(mirrorRoot);
  if (existing) {
    opened = openWalReceiverGeneration(existing);
    emit({
      event: "resumed",
      generationDir: existing.rootDir,
      ledgerPath: existing.ledgerPath,
      projectionPath: existing.projectionPath,
      position: opened.position(),
    });
  }
  const target = {
    position: () => (opened ? opened.position() : null),
    install: async (archive, metadata, size, sha256) => {
      maybeKill("after-package-verified-before-install");
      const installed = await installReplicaGeneration({
        root: mirrorRoot,
        archive,
        metadata,
        sha256,
        size,
        quotaBytes,
      });
      const generation = readReplicaGeneration(mirrorRoot);
      emit({
        event: "installed",
        generationDir: installed.rootDir,
        currentPointer: `${mirrorRoot}/current.json`,
        ledgerPath: generation.ledgerPath,
        projectionPath: generation.projectionPath,
        position: installed.metadata.position,
      });
      const previous = opened;
      opened = openWalReceiverGeneration(generation);
      await previous?.close();
      maybeKill("after-install-before-ack");
      await readers.collect();
    },
    apply: (commit, blobs) => {
      opened.apply(commit, blobs);
      emit({
        event: "applied",
        position: commit.position,
        events: commit.events.length,
        outcomeStatus: commit.outcome === null ? null : commit.outcome.status,
        rejectionCode: commit.outcome === null ? null : commit.outcome.rejectionCode,
      });
      maybeKill("after-durable-before-ack");
    },
    project: async () => {
      await opened.project();
    },
  };

  const signal = new AbortController().signal;
  try {
    await runWalReceiver({
      peer,
      repoId: config.repoId,
      target,
      directory: `${mirrorRoot}/staging`,
      quotaBytes,
      maxBufferedBytes: 16 * 1024 * 1024,
      signal,
    });
  } finally {
    await opened?.close();
    socket.destroy();
  }
}
