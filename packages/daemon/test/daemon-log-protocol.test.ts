// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import {
  emptyLocalController,
  makeServer,
  readFixture,
  resultReceipt
} from "./json-rpc-protocol-fixtures.ts";

test("repo.daemon.logs.list dispatches typed filters and remains available for unavailable repos", async () => {
  const calls: Array<{ readonly input: unknown; readonly repoId: string }> = [];
  const server = makeServer({
    resolveRepoAvailability: (repo) => ({
      code: "repo_unavailable",
      repo: {
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        state: "unavailable",
        lockPath: null,
        lockOwnerToken: null,
        lastError: "recovery failed"
      }
    }),
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DaemonLogService: {
        append: async () => { throw new Error("not used"); },
        list: async (input, context) => {
          calls.push({ input, repoId: context.repo.repoId });
          return { schema: "daemon-log-page/v1", entries: [], nextCursor: null, truncated: false, droppedCount: 0 };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "logs",
    method: "repo.daemon.logs.list",
    params: {
      repo: { repoId: "canonical" },
      payload: { limit: 25, levels: ["error"], errorOnly: true }
    }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.details.data.schema, "daemon-log-page/v1");
  assert.deepEqual(calls, [{ input: { limit: 25, levels: ["error"], errorOnly: true }, repoId: "canonical" }]);
});

test("daemon protocol appends bounded operational outcomes to the shared log sink", async () => {
  const appended: Array<Record<string, unknown>> = [];
  const server = makeServer({
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DaemonLogService: {
        append: async (input, context) => {
          appended.push({ ...input, repoId: context.repo.repoId });
          return {
            schema: "daemon-log-entry/v1",
            timestamp: "2026-07-16T12:00:00.000Z",
            sequence: 0,
            ...input,
            repoId: context.repo.repoId,
            redaction: { policy: "runtime-log-redaction/v1", fieldsRemoved: [], truncated: false }
          };
        },
        list: async () => ({ schema: "daemon-log-page/v1", entries: [], nextCursor: null, truncated: false, droppedCount: 0 })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));
  await server.handle({
    jsonrpc: "2.0",
    id: "tasks",
    method: "repo.tasks.list",
    params: { repo: { repoId: "canonical" }, payload: {} }
  });

  assert.deepEqual(appended.at(-1), {
    level: "info",
    source: "daemon",
    component: "protocol.json-rpc",
    event: "repo.tasks.list",
    message: "completed repo.tasks.list",
    requestId: "tasks",
    repoId: "canonical"
  });
});

test("daemon protocol does not make command receipts wait for the operational log sink", async () => {
  const server = makeServer({
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DaemonLogService: {
        append: () => new Promise(() => undefined),
        list: async () => ({ schema: "daemon-log-page/v1", entries: [], nextCursor: null, truncated: false, droppedCount: 0 })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const outcome = await Promise.race([
    server.handle({
      jsonrpc: "2.0",
      id: "tasks-with-blocked-log",
      method: "repo.tasks.list",
      params: { repo: { repoId: "canonical" }, payload: {} }
    }).then(() => "receipt"),
    new Promise<string>((resolve) => setImmediate(() => resolve("blocked")))
  ]);

  assert.equal(outcome, "receipt");
});

test("repo.daemon.logs.list converts store failures to a bounded protocol error", async () => {
  const server = makeServer({
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DaemonLogService: {
        append: async () => { throw new Error("not used"); },
        list: async () => { throw new Error("/private/root/logs unavailable"); }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));
  const response = await server.handle({
    jsonrpc: "2.0",
    id: "logs-failed",
    method: "repo.daemon.logs.list",
    params: { repo: { repoId: "canonical" }, payload: {} }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "daemon_log_unavailable");
  assert.equal(JSON.stringify(receipt).includes("/private/root"), false);
});
