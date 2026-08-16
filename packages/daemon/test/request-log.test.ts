// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonHost } from "../src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { daemonRequestLogPath, openDaemonRequestLog, type DaemonRequestLogEntry, type DaemonRequestLogRecord } from "../src/request-log.ts";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "harness-request-log-"));
}

function stubHost(rootDir: string): DaemonHost {
  return {
    run: async () => ({ outcome: "applied" as const, opId: "op_test_0001", revision: 7 }),
    status: () => ({ daemonId: "test-daemon", pid: 1, repos: [{ repoId: "logged", rootDir, state: "attached" as const, generation: 1, queueDepth: 0, lastError: null, recoveryMs: 0 }] })
  } as unknown as DaemonHost;
}

async function handshake(server: ReturnType<typeof createJsonRpcProtocolServer>): Promise<void> {
  await server.handle({ jsonrpc: "2.0", id: 1, method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });
}

function readRecords(rootDir: string): readonly DaemonRequestLogRecord[] {
  return readFileSync(daemonRequestLogPath(rootDir), "utf8").split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DaemonRequestLogRecord);
}

function openServerWithLog(rootDir: string, host: DaemonHost = stubHost(rootDir)) {
  const log = openDaemonRequestLog({ resolveRootDir: (repoId) => host.status().repos.find((repo) => repo.repoId === repoId)?.rootDir });
  return createJsonRpcProtocolServer({ host, authContext: { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: 501, source: "unix-socket-filesystem-owner-boundary" } }, emit: async () => undefined, recordRequest: log.record });
}

test("a repo-scoped read request is recorded in the repository local root", async () => {
  const rootDir = tempRoot(), server = openServerWithLog(rootDir);
  await handshake(server);
  await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.run", params: { repo: { repoId: "logged" }, payload: { action: { kind: "task-show", taskId: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV" } } } });
  server.close();

  const records = readRecords(rootDir);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.schema, "daemon-request-log/v1");
  assert.equal(record.method, "repo.task.run");
  // The user-facing command, not just the transport method: this is what "which commands did I run" asks for.
  assert.equal(record.command, "task-show");
  assert.equal(record.commandClass, "repo-read");
  assert.equal(record.repoId, "logged");
  assert.equal(record.transport, "unix-socket");
  assert.equal(record.ownerUid, 501);
  assert.equal(record.opId, "op_test_0001");
  assert.equal(record.outcome, "applied");
  assert.equal(typeof record.durationMs, "number");
  assert.ok(Date.parse(record.at) > 0);
  // The log is local-only state, never the authored ledger.
  assert.ok(daemonRequestLogPath(rootDir).startsWith(path.join(rootDir, ".harness")));
});

test("the declared agent executor is recorded so a request can be attributed to the agent that made it", async () => {
  const rootDir = tempRoot(), server = openServerWithLog(rootDir);
  await handshake(server);
  // The CLI puts the declared executor inside payload.action for repo.task.run; that is the shape
  // the daemon attributes from, so it is the shape the log has to read.
  await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.run", params: { repo: { repoId: "logged" }, payload: { action: { kind: "task-show", taskId: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV", executor: { kind: "agent", id: "codex-worker" } } } } });
  server.close();

  assert.deepEqual(readRecords(rootDir)[0].executor, { kind: "agent", id: "codex-worker" });
});

test("requests from one connection share a connection id", async () => {
  const rootDir = tempRoot(), server = openServerWithLog(rootDir);
  await handshake(server);
  const payload = { repo: { repoId: "logged" }, payload: { action: { kind: "task-show", taskId: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV" } } };
  await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.run", params: payload });
  await server.handle({ jsonrpc: "2.0", id: 3, method: "repo.task.run", params: payload });
  server.close();

  const records = readRecords(rootDir);
  assert.equal(records.length, 2);
  assert.equal(records[0].connectionId, records[1].connectionId);
  assert.ok(records[0].connectionId.length > 0);
});

test("a rejected request is recorded with its error code", async () => {
  const rootDir = tempRoot(), host = stubHost(rootDir);
  const rejecting = { ...host, run: async () => ({ outcome: "rejected" as const, opId: "rejected:task-show", code: "repo_unavailable", nextAction: "Attach the repository." }) } as unknown as DaemonHost;
  const server = openServerWithLog(rootDir, rejecting);
  await handshake(server);
  await server.handle({ jsonrpc: "2.0", id: 2, method: "repo.task.run", params: { repo: { repoId: "logged" }, payload: { action: { kind: "task-show", taskId: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV" } } } });
  server.close();

  const records = readRecords(rootDir);
  assert.equal(records.length, 1);
  assert.equal(records[0].ok, false);
  assert.equal(records[0].code, "repo_unavailable");
  assert.equal(records[0].outcome, "rejected");
});

test("a request that binds no repository is not recorded", async () => {
  const rootDir = tempRoot(), server = openServerWithLog(rootDir);
  await handshake(server);
  await server.handle({ jsonrpc: "2.0", id: 2, method: "daemon.status", params: {} });
  server.close();

  // protocol.hello and daemon.status have no repository whose local root could hold the record.
  assert.equal(readdirSync(rootDir).length, 0);
});

test("rotation holds the log to a bounded number of files", () => {
  const rootDir = tempRoot();
  const log = openDaemonRequestLog({ resolveRootDir: () => rootDir, maxBytes: 512, keptFiles: 2 });
  for (let index = 0; index < 400; index += 1) log.record(entry({ opId: `op_${index}` }));

  const logDir = path.dirname(daemonRequestLogPath(rootDir)), files = readdirSync(logDir).sort();
  assert.deepEqual(files, ["requests.jsonl", "requests.jsonl.1", "requests.jsonl.2"]);
  // The ceiling is the point: without it an always-on request log is an unbounded disk write.
  for (const file of files) assert.ok(readFileSync(path.join(logDir, file), "utf8").length < 512 + 1024);
  // The newest record survives rotation; the oldest is the one that was dropped.
  const live = readRecords(rootDir);
  assert.equal(live.at(-1)?.opId, "op_399");
});

test("a sink that cannot write neither throws nor keeps reporting", () => {
  const rootDir = tempRoot();
  // A file where the log directory must be: mkdir fails for every record.
  mkdirSync(path.join(rootDir, ".harness"), { recursive: true });
  writeFileSync(path.join(rootDir, ".harness", "requests"), "not a directory", "utf8");
  const failures: unknown[] = [];
  const log = openDaemonRequestLog({ resolveRootDir: () => rootDir, onFailure: (error) => failures.push(error) });

  assert.doesNotThrow(() => { log.record(entry({})); log.record(entry({})); log.record(entry({})); });
  // Reported once, then silent: an observability sink must not become a log spammer either.
  assert.equal(failures.length, 1);
});

function entry(overrides: Partial<DaemonRequestLogEntry>): DaemonRequestLogEntry {
  return {
    method: "repo.task.run", repoId: "logged", command: "task-show", commandClass: "repo-read",
    connectionId: "connection-1", auth: { transportKind: "unix-socket" }, executor: null,
    ok: true, outcome: "applied", code: null, opId: "op_test", durationMs: 1, ...overrides
  };
}
