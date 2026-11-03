import { connect } from "node:tls";
import { EventEmitter, once } from "node:events";
import {
  FleetUtf8LineDecoder,
  currentFleetProtocolVersion,
  parseFleetFrame,
  serializeFleetFrame,
} from "../../packages/daemon/src/fleet/command-protocol.ts";
import {
  parseReplicationFrame,
  parseReplicationCommit,
  serializeReplicationFrame,
} from "../../packages/daemon/src/fleet/protocol.ts";
import { withWatchdog } from "../stress/core/controller.mjs";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "../../packages/kernel/src/index.ts";
import { daemonBuildStamp } from "../../packages/daemon/src/build-identity.ts";

/** A protocol sink, not a durable edge. One socket and one bounded commit envelope per node.
 * ACKs intentionally omit edge disk/projection cost: these runs measure center capacity only.
 * Complete frames are split by the production decoder before the pending remainder is capped.
 */
export async function openSyntheticReplica(options, { position, pauseAtBackup = false, timeoutMs = 30_000 } = {}) {
  const socket = connect({
    host: options.hostname,
    port: options.port,
    ca: options.ca,
    servername: options.servername,
  });
  const changed = new EventEmitter(),
    decoder = new FleetUtf8LineDecoder();
  const state = {
    authenticated: false,
    caughtUp: false,
    backupStarted: false,
    backups: 0,
    backupBytes: 0,
    dataBytes: 0,
    frames: 0,
    commits: 0,
    position,
    error: null,
    closed: false,
  };
  let metadata,
    mode = null,
    commitChunks = [],
    commitBytes = 0,
    commitPosition = null,
    expectedClose = false;
  const send = (frame) => socket.write(serializeReplicationFrame(frame));
  const acknowledge = (head) => send({ type: "replica.ack", durable: head, applied: head });
  const parseCommit = () => {
    if (commitChunks.length) {
      commitPosition = parseReplicationCommit(Buffer.concat(commitChunks, commitBytes)).position;
      commitChunks = [];
      commitBytes = 0;
    }
  };
  const fail = (error) => {
    state.error = error;
    socket.destroy();
    changed.emit("change");
  };
  socket.on("error", fail);
  socket.on("close", () => {
    state.closed = true;
    if (!expectedClose && !state.error) state.error = new Error("replica connection closed");
    changed.emit("change");
  });
  socket.on("data", (chunk) => {
    try {
      for (const line of decoder.push(chunk)) {
        state.frames++;
        if (!state.authenticated) {
          const frame = parseFleetFrame(line);
          if (frame.schema === "fleet.error/v1") throw Object.assign(new Error(frame.message), { code: frame.code });
          if (frame.schema !== "fleet.session.ready/v1") throw new Error("fleet hello response expected");
          state.authenticated = true;
          send({
            type: "replica.start",
            repoId: options.repoId,
            position: position ?? null,
            edgeBuildCommit: daemonBuildStamp().commit,
            taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
          });
          continue;
        }
        const frame = parseReplicationFrame(line);
        if (frame.type === "replica.failure" || frame.type === "replica.reject")
          throw Object.assign(new Error(frame.message), { code: frame.code });
        if (frame.type === "replica.backup") {
          metadata = frame.metadata;
          mode = "backup";
          state.backupStarted = true;
          state.backups++;
          if (pauseAtBackup) socket.pause();
        } else if (frame.type === "replica.commit") {
          mode = "commit";
          commitChunks = [];
          commitBytes = 0;
          commitPosition = null;
          if (frame.size > 64 * 1024 ** 2) throw new Error("synthetic receiver commit exceeds 64 MiB");
        } else if (frame.type === "replica.object") {
          parseCommit();
          mode = "object";
        } else if (frame.type === "replica.data") {
          const bytes = Buffer.from(frame.data, "base64");
          state.dataBytes += bytes.length;
          if (mode === "backup") state.backupBytes += bytes.length;
          if (mode === "commit") {
            commitChunks.push(bytes);
            commitBytes += bytes.length;
            if (commitBytes > 64 * 1024 ** 2) throw new Error("synthetic receiver commit exceeds 64 MiB");
          }
        } else if (frame.type === "replica.backup.end") {
          state.position = metadata.position;
          acknowledge(state.position);
          mode = null;
        } else if (frame.type === "replica.commit.end") {
          parseCommit();
          state.position = commitPosition;
          state.commits++;
          mode = null;
        } else if (frame.type === "replica.progress") {
          state.position = frame.head;
          acknowledge(frame.head);
          state.caughtUp = true;
        }
      }
      changed.emit("change");
    } catch (error) {
      fail(error);
    }
  });
  const waitFor = (predicate, label) =>
    withWatchdog(
      async () => {
        while (!predicate(state)) {
          if (state.error) throw state.error;
          await once(changed, "change");
        }
        return state;
      },
      { timeoutMs, label },
    );
  try {
    await withWatchdog(
      async (signal) => {
        const abort = () => socket.destroy();
        signal.addEventListener("abort", abort, { once: true });
        try {
          await once(socket, "secureConnect");
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      { timeoutMs, label: "synthetic replica TLS handshake" },
    );
    const accessToken = await options.readAccessToken();
    socket.write(
      serializeFleetFrame({
        schema: "fleet.session.hello/v1",
        messageId: "synthetic-replica-hello",
        protocolVersion: currentFleetProtocolVersion,
        nodeId: options.nodeId,
        credential: options.credential,
        buildCommit: daemonBuildStamp().commit,
        accessToken,
      }),
    );
    await waitFor((s) => (pauseAtBackup ? s.backupStarted : s.caughtUp), "synthetic replica ready");
    return {
      state,
      close: () => {
        expectedClose = true;
        socket.destroy();
      },
      resume: () => socket.resume(),
      waitFor,
    };
  } catch (error) {
    expectedClose = true;
    socket.destroy();
    throw error;
  }
}
