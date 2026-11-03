import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { runFleetWriteClient, runFleetReplicaStream } from "../../packages/daemon/src/fleet/peer.ts";
import { createServer } from "node:tls";
import { readFileSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import {
  FleetUtf8LineDecoder,
  FLEET_FRAME_BYTES,
  FLEET_CHUNK_BYTES,
  serializeFleetFrame,
} from "../../packages/daemon/src/fleet/command-protocol.ts";
import { replayTraffic } from "./center-replay.mjs";
import { openSyntheticReplica } from "./center-replica.mjs";
import { syntheticJson } from "./center-ledger.mjs";
import { withWatchdog } from "../stress/core/controller.mjs";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../packages/kernel/src/domain/artifact-text-classification.ts";

const status = (fixture) => requestDaemonJsonRpcAt(fixture.endpoint, "daemon.status", {}, 5000, 10_000);
const event = (fixture, name, after = 0) =>
  withWatchdog(
    async () => {
      for (;;) {
        const observed = fixture.events.slice(after).find((row) => row.event === name);
        if (observed) return observed;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    { timeoutMs: 30_000, label: `center ${name}` },
  );

export async function measureCenter(fixture, operation) {
  const samples = [],
    probes = [];
  const pending = new Set();
  const monitor = (operation) => {
    const running = operation().finally(() => pending.delete(running));
    pending.add(running);
  };
  const started = performance.now();
  let sampling = false,
    probing = false;
  await fixture.request("sample");
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      samples.push({ atMs: performance.now() - started, ...(await fixture.request("sample")) });
    } catch (error) {
      samples.push({ atMs: performance.now() - started, error: error.message });
    } finally {
      sampling = false;
    }
  };
  const probe = async () => {
    if (probing) return;
    probing = true;
    const atMs = performance.now() - started;
    try {
      const receipt = await requestDaemonJsonRpcAt(
        fixture.endpoint,
        "repo.tasks.list",
        { repo: { repoId: fixture.repoId }, payload: { limit: 1 } },
        5000,
        10_000,
      );
      probes.push({ atMs, endMs: performance.now() - started, ok: receipt.ok === true && receipt.status === "ready" });
    } catch (error) {
      probes.push({ atMs, endMs: performance.now() - started, ok: false, code: error.code ?? error.message });
    } finally {
      probing = false;
    }
  };
  const sampleTimer = setInterval(() => {
      monitor(sample);
    }, 1000),
    probeTimer = setInterval(() => {
      monitor(probe);
    }, 250);
  try {
    await probe();
    const result = await operation();
    clearInterval(sampleTimer);
    clearInterval(probeTimer);
    await Promise.all(pending);
    await sample();
    await probe();
    let unavailableMs = 0,
      since = null;
    for (const row of probes) {
      if (!row.ok && since === null) since = row.atMs;
      if (row.ok && since !== null) {
        unavailableMs += row.endMs - since;
        since = null;
      }
    }
    if (since !== null) unavailableMs += performance.now() - started - since;
    return {
      ...result,
      daemonSamples: samples,
      probes,
      unavailableMs,
      unavailableDefinition:
        "failed ready-state repo.tasks.list(limit=1) probe start to next successful probe completion; 250ms probe cadence",
      instrumentation:
        "CPU/RSS and event loop histograms sampled inside the dedicated product daemon process; excludes load generator",
    };
  } finally {
    clearInterval(sampleTimer);
    clearInterval(probeTimer);
    await Promise.all(pending);
  }
}

export async function connectReplicas(fixture, nodes, { fresh = false, timeoutMs = 600_000 } = {}) {
  const position = fresh ? null : (await fixture.request("position")).position,
    started = performance.now();
  const settled = await Promise.allSettled(
    Array.from({ length: nodes }, async (_, index) => {
      const replica = await openSyntheticReplica(fixture.peer(index), { position, timeoutMs });
      return { replica, recoveryMs: performance.now() - started };
    }),
  );
  const connected = settled.filter((row) => row.status === "fulfilled").map((row) => row.value);
  return {
    clients: connected.map(({ replica }) => replica),
    report: {
      nodes,
      recovered: connected.length,
      recoveryMs: performance.now() - started,
      nodeRecoveryMs: connected.map((row) => row.recoveryMs),
      errors: settled.filter((row) => row.status === "rejected").map((row) => row.reason.message),
      backupCount: connected.reduce((sum, row) => sum + row.replica.state.backups, 0),
      positionMode: fresh ? "null: actual base backup" : "head: synthetic warm edge, no disk clone",
    },
  };
}

export const faultScenarios = Object.freeze([
  "reconnect",
  "base-backup",
  "legacy-frame",
  "drain-hang",
  "build-switch",
  "large-document",
  "slow-read",
]);

export async function runFaultScenario(name, { fixture, model, bindings = {}, nodes = 1, durationMs = 1000 }) {
  if (!faultScenarios.includes(name)) throw new Error(`unknown fault scenario: ${name}`);
  return measureCenter(fixture, async () => {
    const at = performance.now();
    let observations;
    if (name === "drain-hang") {
      const after = fixture.events.length;
      await fixture.request("hold-drain");
      try {
        await fixture.request("supersede");
        await status(fixture);
        await event(fixture, "drain-entered", after);
        const whileHeld = await status(fixture);
        observations = {
          heldCloseEntered: true,
          statusWhileHeld: whileHeld.ok,
          drainSummary: whileHeld.summary,
          historicalMatch: "controlled RepoCell.close stall; not proof of the original stuck owner's root cause",
        };
      } finally {
        await fixture.request("release-drain");
      }
      await event(fixture, "build_superseded", after);
      await event(fixture, "listening", after);
      await fixture.waitReady();
    } else if (name === "build-switch") {
      const after = fixture.events.length;
      observations = await replayTraffic({
        model,
        fixture,
        bindings,
        nodes,
        durationMs,
        onRequest: async ({ serial }) => {
          if (serial === 1) {
            await fixture.request("supersede");
            await status(fixture);
          }
        },
      });
      await event(fixture, "build_superseded", after);
      await event(fixture, "listening", after);
      await fixture.waitReady();
    } else if (name === "reconnect") {
      const first = await connectReplicas(fixture, nodes);
      for (const replica of first.clients) replica.close();
      const reconnect = await connectReplicas(fixture, nodes);
      try {
        observations = { initial: first.report, reconnect: reconnect.report };
      } finally {
        for (const replica of reconnect.clients) replica.close();
      }
    } else if (name === "base-backup") {
      const result = await connectReplicas(fixture, 1, { fresh: true });
      try {
        observations = { ...result.report, bytes: result.clients.reduce((sum, row) => sum + row.state.backupBytes, 0) };
      } finally {
        for (const replica of result.clients) replica.close();
      }
    } else if (name === "large-document" || name === "slow-read") {
      const largest = [...fixture.ledger.sampleDocuments].sort((a, b) => b.size - a.size)[0];
      const read = async () => {
        const start = performance.now();
        try {
          const receipt = await requestDaemonJsonRpcAt(
            fixture.endpoint,
            "repo.task.read",
            {
              repo: { repoId: fixture.repoId },
              payload: { action: { kind: "doc-show", path: largest.path } },
            },
            10_000,
            30_000,
          );
          return {
            ok: receipt.ok !== false,
            outcome: receipt.outcome,
            code: receipt.code ?? null,
            elapsedMs: performance.now() - start,
          };
        } catch (error) {
          return { ok: false, code: error.code ?? error.message, elapsedMs: performance.now() - start };
        }
      };
      const reads = await Promise.all(Array.from({ length: name === "slow-read" ? 8 : 1 }, read));
      observations = {
        bytes: largest.size,
        reads,
        historicalMatch:
          "real canonical document reads; whether they block the event loop is measured, not injected as a synthetic CPU spin",
      };
      if (name === "large-document") {
        const body = syntheticJson("fault-write", 0, largest.size),
          writeAt = performance.now();
        try {
          const receipt = await runFleetWriteClient({
            ...fixture.peer(0),
            channel: "collaborator",
            changes: [
              {
                path: "context/center-bench/fault-write.json",
                body,
                mediaType: "application/json",
                policyId: OPAQUE_TEXTUAL_POLICY_ID,
              },
            ],
          });
          observations.write = {
            outcome: receipt.center.outcome,
            code: receipt.center.code,
            elapsedMs: performance.now() - writeAt,
          };
        } catch (error) {
          observations.write = {
            outcome: "failed",
            code: error.code ?? error.message,
            elapsedMs: performance.now() - writeAt,
          };
        }
      }
    } else {
      observations = await legacyFrameProbe(fixture);
    }
    return { scenario: name, elapsedMs: performance.now() - at, observations };
  });
}

async function legacyFrameProbe(fixture) {
  const root = path.dirname(fixture.rootDir),
    sockets = new Set();
  let faultSent = false;
  const server = createServer(
    { key: readFileSync(path.join(root, "tls.key")), cert: readFileSync(path.join(root, "tls.crt")) },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const decoder = new FleetUtf8LineDecoder();
      socket.on("data", (chunk) => {
        for (const line of decoder.push(chunk)) {
          const frame = JSON.parse(line);
          if (frame.schema === "fleet.session.hello/v1")
            socket.write(
              serializeFleetFrame({
                schema: "fleet.session.ready/v1",
                messageId: "legacy-ready",
                inReplyTo: frame.messageId,
                sessionId: "legacy-fixture",
                maxFrameBytes: FLEET_FRAME_BYTES,
                chunkBytes: FLEET_CHUNK_BYTES,
              }),
            );
          if (frame.type === "replica.start") {
            faultSent = true;
            socket.write(
              JSON.stringify({
                type: "replica.backup",
                metadata: { schema: "fleet-basebackup/v2" },
                size: 0,
                sha256: "0".repeat(64),
              }) + "\n",
            );
          }
        }
      });
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await withWatchdog(
      (signal) =>
        runFleetReplicaStream({
          ...fixture.peer(0),
          port: server.address().port,
          viewRoot: path.join(root, "legacy-edge"),
          diskQuotaBytes: 64 * 1024 ** 2,
          signal,
        }),
      { timeoutMs: 10_000, label: "old frame on real edge callback" },
    );
    return { accepted: true, faultSent };
  } catch (error) {
    return {
      accepted: false,
      faultSent,
      code: error.code ?? null,
      message: error.message,
      processSurvived: true,
      historicalMatch:
        "old v2 metadata through a real current TLS edge stream; historical #4253 binary remains unverified",
    };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
