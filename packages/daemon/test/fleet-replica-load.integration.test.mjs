// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const centerWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), "fleet-replica-load-center-worker.mjs");
const edgeWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), "fleet-replica-load-edge-worker.mjs");

test("real Fleet daemon processes sustain center writes and report edge revision arrival", async (t) => {
  const nodes = boundedInteger(process.env.FLEET_STRESS_NODES, 3, 1, 100, "FLEET_STRESS_NODES"),
    durationMs = boundedInteger(
      process.env.FLEET_STRESS_DURATION_MS,
      3_000,
      1_000,
      120_000,
      "FLEET_STRESS_DURATION_MS",
    ),
    ratePerSecond = boundedNumber(process.env.FLEET_STRESS_RATE, 0, 0, 1_000, "FLEET_STRESS_RATE"),
    delayMs = boundedInteger(process.env.FLEET_STRESS_DELAY_MS, 0, 0, 200, "FLEET_STRESS_DELAY_MS"),
    bandwidthKbps = boundedNumber(
      process.env.FLEET_STRESS_BANDWIDTH_KBPS,
      0,
      0,
      1_000_000,
      "FLEET_STRESS_BANDWIDTH_KBPS",
    );
  const center = child(centerWorker);
  let proxy;
  const edges = [];
  t.after(async () => {
    const failures = [];
    const stopped = await Promise.allSettled(edges.map((edge) => edge.stop()));
    failures.push(...stopped.filter((result) => result.status === "rejected").map((result) => result.reason));
    try {
      if (proxy) await proxy.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await center.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Fleet stress workers did not stop cleanly");
  });
  const centerInfo = await center.ready;
  t.diagnostic(`FLEET_STRESS_STARTUP_JSON ${JSON.stringify({ role: "center", rssBytes: centerInfo.rssBytes })}`);
  proxy = await startProxy(centerInfo.port, delayMs, bandwidthKbps);
  let startupBatch = [];
  for (let index = 0; index < nodes; index += 1) {
    const nodeId = `load-edge-${index + 1}`;
    await center.request({ type: "register", nodeId });
    const edge = child(edgeWorker, {
      nodeId,
      repoId: centerInfo.repoId,
      repoRoot: centerInfo.repoRoot,
      centerPort: proxy.port,
      certPath: centerInfo.certPath,
      keycloakUrl: centerInfo.keycloakUrl,
    });
    edges.push(edge);
    startupBatch.push(edge.ready);
    if (startupBatch.length === 4) {
      const ready = await Promise.all(startupBatch);
      t.diagnostic(
        `FLEET_STRESS_STARTUP_JSON ${JSON.stringify({ role: "edges", count: edges.length, rssBytes: ready.map(({ nodeId, rssBytes }) => ({ nodeId, rssBytes })) })}`,
      );
      startupBatch = [];
    }
  }
  if (startupBatch.length > 0) {
    const ready = await Promise.all(startupBatch);
    t.diagnostic(
      `FLEET_STRESS_STARTUP_JSON ${JSON.stringify({ role: "edges", count: edges.length, rssBytes: ready.map(({ nodeId, rssBytes }) => ({ nodeId, rssBytes })) })}`,
    );
  }

  const arrivals = new Map(),
    writes = [],
    edgeHeads = new Map(),
    centerSamples = [],
    startedAt = Date.now(),
    deadline = startedAt + durationMs;
  let maximumObservedRevisionLag = 0;
  for (const edge of edges) {
    edge.onMessage((message) => {
      if (message.type === "arrival") {
        const list = arrivals.get(message.revision) ?? [];
        list.push({ nodeId: message.nodeId, arrivedAt: message.arrivedAt });
        arrivals.set(message.revision, list);
      }
      if (message.type === "progress") {
        edgeHeads.set(message.nodeId, { revision: message.revision, sampledAt: message.sampledAt });
        if (writes.length > 0)
          maximumObservedRevisionLag = Math.max(
            maximumObservedRevisionLag,
            writes.at(-1).revision - Math.min(...[...edgeHeads.values()].map(({ revision }) => revision)),
          );
      }
    });
  }
  center.onMessage((message) => {
    if (message.type === "resource") centerSamples.push(message.sample);
  });
  let nextWriteAt = startedAt;
  while (Date.now() < deadline) {
    if (ratePerSecond > 0 && Date.now() < nextWriteAt) {
      await sleep(Math.min(nextWriteAt - Date.now(), deadline - Date.now()));
      continue;
    }
    const written = await center.request({ type: "write", sequence: writes.length + 1 });
    writes.push(written);
    if (edgeHeads.size === edges.length)
      maximumObservedRevisionLag = Math.max(
        maximumObservedRevisionLag,
        written.revision - Math.min(...[...edgeHeads.values()].map(({ revision }) => revision)),
      );
    for (const edge of edges)
      edge.send({
        type: "target",
        revision: written.revision,
        writtenAt: written.writtenAt,
        sequence: written.sequence,
      });
    if (ratePerSecond > 0) nextWriteAt += 1_000 / ratePerSecond;
  }
  const lastRevision = writes.at(-1)?.revision ?? centerInfo.baseRevision;
  const catchupDeadline = Date.now() + Math.max(15_000, delayMs * 30);
  while (Date.now() < catchupDeadline && [...edgeHeads.values()].some(({ revision }) => revision < lastRevision))
    await sleep(50);
  await sleep(100);

  const edgeResults = edges.map((edge) => {
      const progress = edgeHeads.get(edge.nodeId);
      const samples = writes.map((write) => {
        const arrival = (arrivals.get(write.revision) ?? []).find((entry) => entry.nodeId === edge.nodeId);
        return arrival
          ? {
              sequence: write.sequence,
              revision: write.revision,
              writtenAt: write.writtenAt,
              arrivedAt: arrival.arrivedAt,
              latencyMs: arrival.arrivedAt - write.writtenAt,
            }
          : null;
      });
      return {
        nodeId: edge.nodeId,
        finalRevision: progress?.revision ?? null,
        samples,
        missing: samples.filter((sample) => sample === null).length,
      };
    }),
    latencySamples = edgeResults.flatMap(({ samples }) => samples.filter(Boolean).map(({ latencyMs }) => latencyMs)),
    writeWindowMs = writes.length ? writes.at(-1).writtenAt - startedAt : 0,
    elapsedMs = Date.now() - startedAt,
    report = {
      schema: "fleet-real-daemon-load/v1",
      generatedAt: new Date().toISOString(),
      parameters: {
        nodes,
        durationMs,
        requestedRatePerSecond: ratePerSecond || "unpaced",
        delayMsPerDirection: delayMs,
        bandwidthKbpsPerDirection: bandwidthKbps,
      },
      center: {
        writes: writes.length,
        elapsedMs,
        observedWritesPerSecond: writeWindowMs > 0 ? (writes.length * 1_000) / writeWindowMs : 0,
        writeWindowMs,
        finalRevision: lastRevision,
        resources: centerSamples.filter(
          ({ sampledAt }) => sampledAt >= startedAt && sampledAt <= (writes.at(-1)?.writtenAt ?? startedAt),
        ),
      },
      proxy: proxy.stats(),
      edgeResults,
      edgeProcessRssBytes: edges.map((edge) => ({ nodeId: edge.nodeId, rssBytes: edge.readyInfo.rssBytes })),
      propagation: {
        sampleCount: latencySamples.length,
        missingSamples: writes.length * nodes - latencySamples.length,
        p50Ms: percentile(latencySamples, 0.5),
        p95Ms: percentile(latencySamples, 0.95),
        p99Ms: percentile(latencySamples, 0.99),
        maximumMs: latencySamples.length ? Math.max(...latencySamples) : null,
      },
      boundedLag: {
        allEdgesCaughtUp: edgeResults.every(
          ({ finalRevision }) => finalRevision !== null && finalRevision >= lastRevision,
        ),
        maximumObservedRevisionLag: Math.max(0, maximumObservedRevisionLag),
      },
    };
  t.diagnostic(`FLEET_STRESS_RAW_JSON ${JSON.stringify(report)}`);
  assert.equal(writes.length > 0, true, "center must accept sustained writes");
  assert.equal(report.boundedLag.allEdgesCaughtUp, true, `not all edge daemons reached revision ${lastRevision}`);
  assert.equal(report.propagation.missingSamples, 0, "every edge must report every target revision arrival");
});

function child(modulePath, config) {
  const process = fork(modulePath, [], {
    cwd: root,
    execArgv: [],
    env: { ...globalThis.process.env, ...(config ? { FLEET_WORKER_CONFIG: JSON.stringify(config) } : {}) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "",
    stderr = "";
  process.stdout.setEncoding("utf8");
  process.stderr.setEncoding("utf8");
  process.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  process.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  let requestId = 0;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new Error(
          `${path.basename(modulePath)} startup timed out (${process.nodeId ?? "center"}): ${stderr.slice(-2000)}`,
        ),
      );
    }, 150_000);
    process.on("message", (message) => {
      if (message.type === "ready" && !settled) {
        settled = true;
        clearTimeout(timer);
        process.nodeId = message.nodeId;
        process.readyInfo = message;
        resolve(message);
      }
      if (message.type === "startup-error" && !settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(message.error));
      }
      if (message.type === "response") {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error));
          else entry.resolve(message.value);
        }
      }
      process.emit(`worker:${message.type}`, message);
    });
    process.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `${path.basename(modulePath)} exited before ready (code=${code}, signal=${signal}): ${stderr.slice(-2000)}${stdout.slice(-1000)}`,
          ),
        );
      }
    });
  });
  process.sendMessage = (message) => process.send(message);
  process.send = process.send.bind(process);
  process.ready = ready;
  process.onMessage = (callback) => {
    for (const type of ["arrival", "progress", "resource"]) process.on(`worker:${type}`, callback);
  };
  process.request = (message) =>
    new Promise((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      try {
        process.send({ ...message, id });
      } catch (error) {
        pending.delete(id);
        reject(
          new Error(`worker request failed (exit=${process.exitCode}, signal=${process.signalCode}): ${error.message}`),
        );
      }
    });
  process.once("exit", (code, signal) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(
        new Error(
          `${path.basename(modulePath)} exited during request (code=${code}, signal=${signal}): ${stderr.slice(-2000)}`,
        ),
      );
    }
  });
  process.stop = async () => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, "exit");
    let timer;
    process.send({ type: "stop" });
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          process.kill("SIGKILL");
          resolve();
        }, 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (process.exitCode !== 0)
      throw new Error(`daemon worker exited ${process.exitCode}: ${stderr.slice(-2000)}${stdout.slice(-1000)}`);
  };
  process.nodeId = config?.nodeId;
  return process;
}

async function startProxy(centerPort, delayMs, bandwidthKbps) {
  let bytesSent = 0,
    connections = 0;
  const proxy = createServer((client) => {
    connections += 1;
    const upstream = connect(centerPort, "127.0.0.1");
    const pipeDirection = (source, destination) => {
      let tail = Promise.resolve();
      source.on("data", (chunk) => {
        source.pause();
        const value = Buffer.from(chunk);
        tail = tail
          .then(() => new Promise((resolve) => setTimeout(resolve, delayMs)))
          .then(async () => {
            if (bandwidthKbps > 0) await sleep(((value.length * 8) / (bandwidthKbps * 1_000)) * 1_000);
            bytesSent += value.length;
            if (destination.destroyed) return;
            if (!destination.write(value)) await once(destination, "drain");
          })
          .finally(() => source.resume());
      });
      source.on("end", () => destination.end());
      source.on("error", () => destination.destroy());
    };
    pipeDirection(client, upstream);
    pipeDirection(upstream, client);
    upstream.on("error", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return {
    port: proxy.address().port,
    stats: () => ({ connections, bytesSent }),
    close: () => new Promise((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve()))),
  };
}

function boundedInteger(value, fallback, min, max, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return parsed;
}
function boundedNumber(value, fallback, min, max, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be from ${min} through ${max}`);
  return parsed;
}
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
