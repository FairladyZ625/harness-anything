import net from "node:net";
import { once } from "node:events";
import { JsonRpcLineClient } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { currentDaemonProtocolVersion } from "../../packages/daemon/src/protocol/version.ts";
import { allDaemonProtocolMethods } from "../../packages/daemon/src/protocol/daemon-protocol-commands.ts";
import { requestAccumulator, replaySchedule } from "./center-model.mjs";
import { withWatchdog } from "../stress/core/controller.mjs";
let nextReplayId = 0;

// Bindings are workload choices, not copies of the action catalog. Unbound commands fail before load starts.
export function syntheticParams(row, fixture, serial = 0, bindings = {}) {
  const repo = { repoId: fixture.repoId },
    taskId = fixture.ledger.sampleTasks[serial % fixture.ledger.sampleTasks.length];
  const custom = bindings[`${row.method}:${row.command}`] ?? bindings[row.method];
  if (custom) return structuredClone(custom);
  if (row.method === "protocol.hello") return { protocolVersion: currentDaemonProtocolVersion, reportStaleBuild: true };
  if (
    [
      "daemon.status",
      "daemon.gui.system.read",
      "daemon.gui.home.read",
      "daemon.runtimeInstance.list",
      "daemon.provider.list",
    ].includes(row.method)
  )
    return {};
  if (row.method === "repo.task.read") {
    const actions = {
      "task-show": { kind: "task-show", taskId },
      "doc-show": { kind: "doc-show", path: fixture.ledger.sampleDocuments.at(-1).path },
      "task-list": { kind: "task-list" },
      "settings-read": { kind: "settings-read" },
    };
    if (actions[row.command]) return { repo, payload: { action: actions[row.command] } };
  }
  if (row.method === "repo.task.run" && row.command === "fact-record")
    return {
      repo,
      payload: {
        action: {
          kind: "fact-record",
          statement: `Synthetic observation ${serial}`,
          evidenceSource: "center-bench",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
        },
      },
    };
  if (row.method === "repo.task.create")
    return { repo, payload: { taskId: `task-bench-replay-${serial}`, title: `Replay ${serial}` } };
  if (row.method === "observe.tail") return { repo, payload: { kind: "events", direction: "history" } };
  if (row.method === "repo.agentRuntime.overview") return { repo, payload: { limit: 20 } };
  if (row.method === "repo.task.dispatches") return { repo, payload: { taskId } };
  if (row.method === "repo.tasks.assignmentDirectory") return { repo, payload: { taskId } };
  if (row.method === "repo.agentRuntime.sessions.read") return { repo, payload: {} };
  const descriptor = allDaemonProtocolMethods.find((candidate) => candidate.method === row.method);
  // A no-payload repository read is fully specified by its production schema.
  if (row.kind === "read" && descriptor?.requiresRepo && !descriptor.params.fields.payload) return { repo };
  if (
    [
      "repo.tasks.list",
      "repo.triadic.relationGraph",
      "repo.agenda.read",
      "repo.todo.list",
      "repo.decisions.list",
      "repo.artifacts.list",
      "repo.agentRuntime.tokenUsage",
    ].includes(row.method)
  )
    return { repo, payload: {} };
  throw new Error(`synthetic binding required for ${row.method}:${row.command}`);
}

async function openSession(endpoint, timeoutMs) {
  const socket = net.createConnection(endpoint),
    client = new JsonRpcLineClient(socket, socket);
  try {
    await withWatchdog(
      async (signal) => {
        const abort = () => socket.destroy();
        signal.addEventListener("abort", abort, { once: true });
        try {
          await once(socket, "connect");
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      { timeoutMs, label: "replay connection" },
    );
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function replayTraffic({
  model,
  fixture,
  nodes = 1,
  speed = 1,
  durationMs = 10_000,
  maxInFlight = 4096,
  timeoutMs = 10_000,
  bindings = {},
  onRequest = async () => undefined,
}) {
  const window = model.requests.filter((row) => row.offsetMs / speed < durationMs);
  for (const row of window) syntheticParams(row, fixture, 0, bindings);
  const lastByConnection = new Map();
  for (const [index, row] of window.entries()) lastByConnection.set(row.connection, index);
  const sessions = new Map(),
    observeCursors = new Map(),
    observePolls = { history: 0, follow: 0 },
    pending = new Set(),
    accumulator = requestAccumulator();
  const started = performance.now();
  const traceTag = `center-bench-trace-${++nextReplayId}`;
  let serial = 0,
    implicitHellos = 0,
    highWater = 0;
  const releaseFinished = async (key, session) => {
    if (!session || session.active || !session.lastIssued) return;
    sessions.delete(key);
    const opened = await Promise.allSettled([session.opening]);
    if (opened[0].status === "fulfilled") opened[0].value.close();
  };
  const issue = async (row, number) => {
    const startedMs = performance.now() - started,
      key = `${row.node}:${row.connection}`;
    let ok = false,
      code = null;
    try {
      if (!sessions.has(key)) {
        const opening = openSession(fixture.endpoint, timeoutMs);
        const session = { opening, active: 0, lastIssued: false };
        // The trace may start mid-connection. Only that case adds an explicitly counted hello.
        session.ready = opening.then(async (client) => {
          if (row.method !== "protocol.hello") implicitHellos++;
          session.helloResult = await client.request(
            "protocol.hello",
            { ...syntheticParams({ ...row, method: "protocol.hello" }, fixture, number), invokingCommand: traceTag },
            timeoutMs,
          );
          return client;
        });
        sessions.set(key, session);
      }
      const session = sessions.get(key);
      session.active++;
      session.lastIssued ||= row.index === lastByConnection.get(row.connection);
      const client = await session.ready;
      const params = syntheticParams(row, fixture, number, bindings);
      const managedObserve =
        row.method === "observe.tail" && !(bindings[`${row.method}:${row.command}`] ?? bindings[row.method]);
      if (managedObserve) {
        const cursor = observeCursors.get(row.node);
        if (cursor) params.payload = { kind: "events", direction: "follow", cursor };
        observePolls[params.payload.direction]++;
      }
      const result =
        row.method === "protocol.hello" ? session.helloResult : await client.request(row.method, params, timeoutMs);
      if (managedObserve && result.liveCursor) observeCursors.set(row.node, result.liveCursor);
      ok = result.ok !== false && !["op_rejected", "indeterminate"].includes(result.outcome);
      code = ok ? null : (result.code ?? result.error?.code ?? result.outcome ?? "request_failed");
    } catch (error) {
      code = error.code ?? error.message;
    } finally {
      const endedMs = performance.now() - started;
      accumulator.record({
        ...row,
        ok,
        code,
        scheduledMs: row.offsetMs,
        startedMs,
        endedMs,
        latencyMs: endedMs - row.offsetMs,
      });
      const session = sessions.get(key);
      if (session) session.active--;
      await releaseFinished(key, session);
    }
  };
  try {
    for (const row of replaySchedule(model, { nodes, speed, durationMs })) {
      const waitMs = row.offsetMs - (performance.now() - started);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      await onRequest({ serial, row });
      if (pending.size >= maxInFlight) {
        const now = performance.now() - started;
        accumulator.record({
          ...row,
          ok: false,
          code: "generator_concurrency_limit",
          scheduledMs: row.offsetMs,
          startedMs: now,
          endedMs: now,
          latencyMs: now - row.offsetMs,
        });
        const key = `${row.node}:${row.connection}`,
          session = sessions.get(key);
        if (session && row.index === lastByConnection.get(row.connection)) {
          session.lastIssued = true;
          await releaseFinished(key, session);
        }
      } else {
        const operation = issue(row, serial).finally(() => pending.delete(operation));
        pending.add(operation);
        highWater = Math.max(highWater, pending.size);
      }
      serial++;
      // Yield without delaying scheduled arrivals behind a request's completion.
      if (serial % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(pending);
    const elapsedMs = performance.now() - started;
    return {
      nodes,
      traceTag,
      elapsedMs,
      implicitHellos,
      observePolls,
      maxInFlightObserved: highWater,
      plannedMethods: Object.fromEntries(
        [...new Set(window.map((row) => row.method))].map((method) => [
          method,
          window.filter((row) => row.method === method).length * nodes,
        ]),
      ),
      ...accumulator.result(elapsedMs),
      latencyDefinition:
        "arrival-to-terminal-reply, including generator lag; percentiles include successful requests only",
    };
  } finally {
    const openings = await Promise.allSettled([...sessions.values()].map((session) => session.opening));
    for (const opened of openings) if (opened.status === "fulfilled") opened.value.close();
  }
}
