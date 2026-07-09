import assert from "node:assert/strict";
import test from "node:test";
import type { LocalControllerService } from "../../application/src/index.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import {
  createJsonRpcProtocolServer,
  currentDaemonProtocolVersion,
  jsonRpcMethodContracts,
  type JsonRpcResponse
} from "../src/index.ts";

test("daemon method registry exposes repo.doc.sync.submit as an active repo write", () => {
  const contract = jsonRpcMethodContracts.find((entry) => entry.method === "repo.doc.sync.submit");
  assert.ok(contract);
  assert.equal(contract.mode, "active");
  assert.equal(contract.namespace, "repo");
  assert.equal(contract.requiresRepo, true);
  assert.equal(contract.commandClass, "repo-write");
  assert.equal(contract.inputSchemaId, "daemon.doc-sync-submit-request/v1");
  assert.equal(contract.outputSchemaId, "daemon.doc-sync-submit-result/v1");
});

test("repo.doc.sync.submit appends dual-axis actor fields without inventing a human anchor", async () => {
  const events: Record<string, any>[] = [];
  const server = createJsonRpcProtocolServer({
    daemonId: "daemon-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    appendRuntimeEvent: async (input) => {
      events.push(input as Record<string, any>);
    },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DocSyncService: {
        submit: async () => ({
          ok: true,
          schema: "daemon.doc-sync-submit-result/v1",
          status: "accepted",
          intentId: "intent-daemon-event",
          baseLedgerSha: "base",
          appliedLedgerSha: "applied",
          appliedChanges: []
        })
      }
    }
  });
  await server.handle({ jsonrpc: "2.0", id: "hello", method: "protocol.hello", params: { protocolVersion: currentDaemonProtocolVersion } });

  const receipt = resultReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "doc-sync-1",
    method: "repo.doc.sync.submit",
    params: {
      repo: { repoId: "canonical" },
      session: { sessionId: "codex-doc-sync", runtime: "codex" },
      payload: {
        baseLedgerSha: "base",
        intentId: "intent-daemon-event",
        declaredIntent: "prose-edit",
        changes: []
      }
    }
  }));

  assert.equal(receipt.ok, true);
  assert.equal(receipt.command, "repo.doc.sync.submit");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actorAxes?.principal, null);
  assert.deepEqual(events[0]?.actorAxes?.executor, { runtime: "codex", sessionId: "codex-doc-sync" });
  assert.equal(events[0]?.actorAxes?.responsibleHuman, null);
});

function emptyLocalController(): LocalControllerService {
  return {
    getTasks: () => ({ ok: true, tasks: [], warnings: [] }),
    getTaskDetail: async () => ({ ok: true }),
    getTaskDocument: async () => ({ ok: true }),
    getRelationGraph: () => ({ ok: true, edges: [], coverageRows: [], factAnchors: [], warnings: [] }),
    getDecisions: () => ({ ok: true, decisions: [], warnings: [] }),
    getDecisionDetail: () => ({ ok: false, error: { code: "decision_not_found", hint: "missing" } }),
    getTaskFacts: async (payload) => ({ ok: true, taskId: payload.taskId, path: "harness/tasks/task/facts.md", facts: [] }),
    setTaskStatus: async () => ({ ok: true }),
    reviewTask: async () => ({ ok: true }),
    appendTaskProgress: async () => ({ ok: true }),
    rebuildGovernance: () => ({ ok: true, tasks: [], warnings: [] }),
    archiveTask: () => ({ ok: true }),
    openShell: () => ({ ok: true, policy: { displayOnly: true, outputCreatesTaskState: false } })
  };
}

function resultReceipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined): {
  readonly ok: boolean;
  readonly command: string;
} {
  assert.ok(response && !Array.isArray(response));
  assert.equal("result" in response, true);
  return response.result as { readonly ok: boolean; readonly command: string };
}
