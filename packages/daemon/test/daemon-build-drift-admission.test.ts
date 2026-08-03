// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import {
  commandRunRequest,
  emptyLocalController,
  makeServer,
  readFixture,
  rosterIdentityOptions,
  sampleRoster
} from "./json-rpc-protocol-fixtures.ts";
import type { JsonRpcResponse } from "../src/index.ts";

interface DriftReceipt {
  readonly ok: boolean;
  readonly error?: { readonly code?: string; readonly hint?: string };
  readonly next?: ReadonlyArray<{ readonly command: string; readonly description?: string }>;
  readonly items?: ReadonlyArray<unknown>;
  readonly details: Record<string, unknown>;
}

function driftReceipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined): DriftReceipt {
  assert.ok(response && !Array.isArray(response) && "result" in response);
  return response.result as unknown as DriftReceipt;
}

test("artifact drift rejects writes before mixed-version service dispatch and keeps reads available", async () => {
  const loadedIdentity = `sha256:${"a".repeat(64)}`;
  const installedIdentity = `sha256:${"b".repeat(64)}`;
  const dispatched: string[] = [];
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    },
    readBuildIdentity: () => ({ loadedIdentity, installedIdentity }),
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async (payload) => {
          const command = payload?.command as { readonly action?: { readonly kind?: string } } | undefined;
          dispatched.push(command?.action?.kind ?? "unknown");
          return {
            ok: true,
            schema: "command-receipt/v2",
            command: command?.action?.kind ?? "unknown",
            action: "run",
            summary: "dispatched",
            details: {},
            meta: {
              generatedAt: "2026-07-31T00:00:00.000Z",
              compatibility: {}
            }
          };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const write = driftReceipt(await server.handle(commandRunRequest("task-complete", "write-stale")));
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, "daemon_build_stale");
  assert.match(write.error?.hint ?? "", new RegExp(loadedIdentity, "u"));
  assert.match(write.error?.hint ?? "", new RegExp(installedIdentity, "u"));
  assert.match(write.error?.hint ?? "", /ha daemon restart/u);
  assert.deepEqual(write.details.data, {
    loadedIdentity,
    installedIdentity,
    nextCommand: "ha daemon restart"
  });
  assert.deepEqual(write.next, [{
    command: "ha daemon restart",
    description: "Restart the daemon on the current dist build, then retry the original write."
  }]);
  assert.deepEqual(dispatched, []);

  const read = driftReceipt(await server.handle(commandRunRequest("task-show", "read-stale")));
  assert.equal(read.ok, true);
  assert.deepEqual(dispatched, ["task-show"]);
});

test("matching artifact identities allow writes", async () => {
  const identity = `sha256:${"c".repeat(64)}`;
  const dispatched: string[] = [];
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    },
    readBuildIdentity: () => ({ loadedIdentity: identity, installedIdentity: identity }),
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async (payload) => {
          const command = payload?.command as { readonly action?: { readonly kind?: string } } | undefined;
          dispatched.push(command?.action?.kind ?? "unknown");
          return {
            ok: true,
            schema: "command-receipt/v2",
            command: command?.action?.kind ?? "unknown",
            action: "run",
            summary: "dispatched",
            details: {},
            meta: { generatedAt: "2026-07-31T00:00:00.000Z", compatibility: {} }
          };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const write = driftReceipt(await server.handle(commandRunRequest("task-complete", "write-current")));
  assert.equal(write.ok, true);
  assert.deepEqual(dispatched, ["task-complete"]);
});

test("temporarily unavailable artifact identity fails closed and automatically recovers", async () => {
  const identity = `sha256:${"d".repeat(64)}`;
  let available = false;
  const dispatched: string[] = [];
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    },
    readBuildIdentity: () => {
      if (!available) throw new Error("identity file is being replaced");
      return { loadedIdentity: identity, installedIdentity: identity };
    },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async (payload) => {
          const command = payload?.command as { readonly action?: { readonly kind?: string } } | undefined;
          dispatched.push(command?.action?.kind ?? "unknown");
          return {
            ok: true,
            schema: "command-receipt/v2",
            command: command?.action?.kind ?? "unknown",
            action: "run",
            summary: "dispatched",
            details: {},
            meta: { generatedAt: "2026-07-31T00:00:00.000Z", compatibility: {} }
          };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const unavailable = driftReceipt(await server.handle(commandRunRequest("task-complete", "write-unavailable")));
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error?.code, "daemon_build_identity_unavailable");
  assert.match(unavailable.error?.hint ?? "", /ha daemon restart/u);
  assert.deepEqual(dispatched, []);

  const read = driftReceipt(await server.handle(commandRunRequest("task-show", "read-unavailable")));
  assert.equal(read.ok, true);
  assert.deepEqual(dispatched, ["task-show"]);

  available = true;
  const recovered = driftReceipt(await server.handle(commandRunRequest("task-complete", "write-recovered")));
  assert.equal(recovered.ok, true);
  assert.deepEqual(dispatched, ["task-show", "task-complete"]);
});

test("explicit read and lifecycle admin methods remain available during artifact drift", async () => {
  const roster = sampleRoster();
  let identityReads = 0;
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    },
    readBuildIdentity: () => {
      identityReads += 1;
      return {
        loadedIdentity: `sha256:${"e".repeat(64)}`,
        installedIdentity: `sha256:${"f".repeat(64)}`
      };
    },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DaemonControlService: {
        requestControl: (kind) => ({
          ok: true,
          accepted: {
            schema: "daemon-control-accepted/v1",
            accepted: true,
            operationId: "control-during-drift",
            kind,
            scope: "service",
            requestedAt: "2026-07-31T00:00:00.000Z",
            before: {
              pid: 41001,
              loadedIdentity: `sha256:${"e".repeat(64)}`,
              repoCount: 1,
              queueDepth: 0
            }
          },
          afterResponse: () => undefined
        })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "admin-during-drift",
    method: "admin.people.list",
    params: {}
  });
  const receipt = driftReceipt(response);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.items?.length, 4);

  const restart = driftReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "restart-during-drift",
    method: "admin.daemon.restart",
    params: { payload: { reason: "artifact drift", drainTimeoutMs: 5_000 } }
  }));
  assert.equal(restart.ok, true);
  assert.equal(identityReads, 0);
});
