import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { LocalControllerService } from "../../application/src/index.ts";
import { makeRuntimeEventAppendPromise, makeRuntimeEventLedgerService } from "../../application/src/index.ts";
import { apiRouteContracts } from "../../gui/src/api/api-contract-registry.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import { commandSpecs } from "../../cli/src/cli/command-spec/index.ts";
import {
  createJsonRpcProtocolServer,
  currentDaemonProtocolVersion,
  jsonRpcServiceMethodContracts,
  jsonRpcMethodContracts,
  repoCommandRunClassifiedActionKinds,
  makeTransportDerivedIdentityProvider,
  peopleRosterFromDocument,
  type IdentityProvider,
  type PeopleRoster,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "../src/index.ts";

const fixtureRoot = path.resolve(fileURLToPath(new URL("../fixtures/protocol", import.meta.url)));

test("daemon JSON-RPC service method registry is derived from the API contract registry", () => {
  assert.deepEqual(
    jsonRpcServiceMethodContracts.map((contract) => ({
      method: contract.method,
      service: contract.service,
      serviceMethod: contract.serviceMethod,
      inputSchemaId: contract.inputSchemaId,
      outputSchemaId: contract.outputSchemaId
    })),
    apiRouteContracts.map((contract) => ({
      method: `repo.${contract.id}`,
      service: contract.service,
      serviceMethod: contract.serviceMethod,
      inputSchemaId: contract.inputSchemaId,
      outputSchemaId: contract.outputSchemaId
    }))
  );
});

test("daemon method registry classifies every non-hello method exactly once", () => {
  for (const contract of jsonRpcMethodContracts) {
    if (contract.method === "protocol.hello") {
      assert.equal(contract.commandClass, undefined);
      continue;
    }
    const hasStaticClass = typeof contract.commandClass === "string";
    const hasDerivedClass = contract.commandClassDerivation === "repo-command-run-action";
    assert.equal(Number(hasStaticClass) + Number(hasDerivedClass), 1, contract.method);
    if (hasStaticClass) assert.match(contract.commandClass ?? "", /^(admin|repo-write|repo-read|arbiter)$/u, contract.method);
  }
});

test("repo.command.run classification covers every parsed CLI action kind", () => {
  assert.deepEqual(
    repoCommandRunClassifiedActionKinds,
    commandSpecs.map((spec) => spec.kind).sort()
  );
});

test("protocol.hello accepts the current daemon protocol version", async () => {
  const server = makeServer();
  const response = await server.handle(readFixture("hello-compatible.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.schema, "command-receipt/v2");
  assert.equal(receipt.command, "protocol.hello");
  assert.equal(receipt.details.data.protocolVersion, currentDaemonProtocolVersion);
  assert.deepEqual(receipt.details.data.repos, [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }]);
  const methods = receipt.details.data.methods as ReadonlyArray<string>;
  assert.equal(methods.includes("repo.tasks.list"), true);
  assert.equal(methods.includes("admin.people.list"), true);
});

test("protocol.hello rejects incompatible daemon protocol versions with receipt/v2 evidence", async () => {
  const server = makeServer();
  const response = await server.handle(readFixture("hello-incompatible.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.schema, "command-receipt/v2");
  assert.equal(receipt.command, "protocol.hello");
  assert.equal(receipt.error.code, "incompatible_protocol_version");
  assert.equal(receipt.details.supported?.currentProtocolVersion, currentDaemonProtocolVersion);
});

test("repo methods require hello before service dispatch", async () => {
  const server = makeServer();
  const response = await server.handle(readFixture("repo-request.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "hello_required");
});

test("repo methods require a known repo namespace and wrap service output in command-receipt/v2", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle(readFixture("repo-request.json"));
  const receipt = resultReceipt(response);
  const fixtureReceipt = readJson("receipt-success.json");

  assert.equal(receipt.ok, true);
  assert.equal(receipt.schema, fixtureReceipt.schema);
  assert.equal(receipt.command, fixtureReceipt.command);
  assert.equal(receipt.action, fixtureReceipt.action);
  assert.deepEqual(receipt.items, fixtureReceipt.items);
  const fixtureDetails = fixtureReceipt.details as { readonly data: Record<string, unknown> };
  assert.deepEqual(receipt.details.data, fixtureDetails.data);
});

test("repo namespace rejects unknown canonical repositories", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const request = {
    ...readFixture("repo-request.json"),
    params: { repo: { repoId: "missing" }, payload: {} }
  } satisfies JsonRpcRequest;
  const response = await server.handle(request);
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.code, "repo_namespace_unknown");
});

test("notification subscribe is a no-op socket and respects JSON-RPC notification semantics", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle(readFixture("notification-subscribe.json"));

  assert.equal(response, undefined);
});

test("admin people list returns roster data and stamps receipt actor", async () => {
  const roster = sampleRoster();
  const server = makeServer({
    peopleRoster: roster,
    identityProvider: makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" }),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "admin-1",
    method: "admin.people.list",
    params: {}
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.items?.length, 4);
  assert.equal((receipt.details.actor as { readonly personId?: string }).personId, "person_alice");
});

test("transport-derived provider rejects unknown credentials without anonymous fallback", async () => {
  const roster = sampleRoster();
  const provider = makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" });
  const resolved = await provider.resolveActor({
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "mallory", host: "team-host", source: "ssh-authenticated-exec" }
    },
    command: { method: "repo.tasks.list", namespace: "repo", requiresRepo: true }
  });

  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.code, "credential_unknown");
});

test("mock email provider proves provider extension without daemon call-site changes", async () => {
  const roster = sampleRoster();
  const emailProvider: IdentityProvider = {
    providerId: "email-session/v1",
    resolveActor: async ({ authContext }) => {
      const claims = authContext.sshTunnelToken?.subject.claims;
      const email = claims && typeof claims.email === "string" ? claims.email.toLowerCase() : "";
      return roster.resolveCredential({ kind: "email-address", issuer: "email:primary", subject: email }, "email-session/v1");
    }
  };

  const resolved = await emailProvider.resolveActor({
    authContext: {
      transportKind: "ssh-tunnel",
      sshTunnelToken: {
        tokenId: "token-1",
        tunnelNonce: "nonce-1",
        subject: {
          userId: "session-user",
          hostProfileId: "host-profile",
          daemonInstanceId: "daemon-test",
          claims: { email: "ALICE@EXAMPLE.COM" }
        }
      }
    },
    command: { method: "repo.tasks.list", namespace: "repo", requiresRepo: true }
  });

  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.actor.personId, "person_alice");
    assert.equal(resolved.actor.providerId, "email-session/v1");
  }
});

test("RBAC rejects non-arbiter methods and records a runtime event with actor", async () => {
  const rootDir = createHarnessRoot();
  try {
    const roster = sampleRoster();
    const server = makeServer({
      peopleRoster: roster,
      identityProvider: makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" }),
      authContext: {
        transportKind: "ssh-exec",
        sshExecUser: { username: "viewer", host: "team-host", source: "ssh-authenticated-exec" }
      },
      appendRuntimeEvent: makeRuntimeEventAppendPromise(makeRuntimeEventLedgerService({
        rootInput: rootDir,
        now: () => "2026-07-07T00:00:00.000Z",
        makeEventId: () => "evt_20260707_rbacdeny"
      }))
    });
    await server.handle(readFixture("hello-compatible.json"));

    const response = await server.handle({
      jsonrpc: "2.0",
      id: "rbac-1",
      method: "repo.tasks.review",
      params: {
        repo: { repoId: "canonical" },
        session: { sessionId: "codex-session-rbac", runtime: "codex" },
        payload: { taskId: "task-1" }
      }
    });
    const receipt = resultReceipt(response);

    assert.equal(receipt.ok, false);
    assert.equal(receipt.error?.code, "rbac_forbidden");
    assert.equal((receipt.details.actor as { readonly personId?: string }).personId, "person_viewer");
    const event = JSON.parse(readFileSync(path.join(rootDir, ".harness/generated/runtime-events/codex-session-rbac.jsonl"), "utf8")) as {
      readonly actor?: { readonly personId?: string };
      readonly result?: { readonly errorCode?: string };
      readonly tool?: { readonly toolName?: string };
    };
    assert.equal(event.actor?.personId, "person_viewer");
    assert.equal(event.result?.errorCode, "rbac_forbidden");
    assert.equal(event.tool?.toolName, "repo.tasks.review");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repo.command.run derives RBAC from the inner CLI command", async () => {
  const roster = sampleRoster();
  const calls: string[] = [];
  const server = makeServer({
    peopleRoster: roster,
    identityProvider: makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" }),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "maint", host: "team-host", source: "ssh-authenticated-exec" }
    },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async (payload) => {
          const kind = (((payload?.command as Record<string, unknown> | undefined)?.action as Record<string, unknown> | undefined)?.kind);
          calls.push(String(kind));
          return {
            ok: true,
            schema: "command-receipt/v2",
            command: String(kind),
            action: String(kind),
            summary: `completed ${String(kind)}`,
            details: {},
            meta: {
              generatedAt: "2026-07-07T00:00:00.000Z",
              compatibility: { legacyReceipt: "CommandReceipt/v1" }
            }
          };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const readReceipt = resultReceipt(await server.handle(commandRunRequest("version", "rbac-read")));
  assert.equal(readReceipt.ok, true);
  const writeReceipt = resultReceipt(await server.handle(commandRunRequest("new-task", "rbac-write")));
  assert.equal(writeReceipt.ok, true);

  const arbiterReceipt = resultReceipt(await server.handle(commandRunRequest("decision-accept", "rbac-arbiter")));
  assert.equal(arbiterReceipt.ok, false);
  assert.equal(arbiterReceipt.error?.code, "rbac_forbidden");
  assert.equal(arbiterReceipt.details.commandClass, "arbiter");
  assert.deepEqual(calls, ["version", "new-task"]);
});

function makeServer(overrides: Partial<Parameters<typeof createJsonRpcProtocolServer>[0]> = {}) {
  return createJsonRpcProtocolServer({
    daemonId: "daemon-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    },
    ...overrides
  });
}

function emptyLocalController(): LocalControllerService {
  return {
    getTasks: () => ({ ok: true, tasks: [], warnings: [] }),
    getTaskDetail: () => ({ ok: true }),
    getTaskDocument: () => ({ ok: true }),
    setTaskStatus: async () => ({ ok: true }),
    reviewTask: async () => ({ ok: true }),
    appendTaskProgress: async () => ({ ok: true }),
    rebuildGovernance: () => ({ ok: true, tasks: [], warnings: [] }),
    archiveTask: () => ({ ok: true }),
    openShell: () => ({ ok: true, policy: { displayOnly: true, outputCreatesTaskState: false } })
  };
}

function commandRunRequest(actionKind: string, id: string): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "repo.command.run",
    params: {
      repo: { repoId: "canonical" },
      payload: {
        command: {
          rootDir: "/tmp/canonical",
          json: true,
          action: { kind: actionKind }
        }
      }
    }
  };
}

function readFixture(name: string): JsonRpcRequest {
  return readJson(name) as JsonRpcRequest;
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function resultReceipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined): {
  readonly ok: boolean;
  readonly schema: string;
  readonly command: string;
  readonly action?: string;
  readonly error?: { readonly code?: string };
  readonly items?: ReadonlyArray<unknown>;
  readonly details: Record<string, any>;
} {
  assert.ok(response && !Array.isArray(response));
  assert.equal("result" in response, true);
  return response.result as {
    readonly ok: boolean;
    readonly schema: string;
    readonly command: string;
    readonly action?: string;
    readonly error?: { readonly code?: string };
    readonly items?: ReadonlyArray<unknown>;
    readonly details: Record<string, any>;
  };
}

function sampleRoster(): PeopleRoster {
  return peopleRosterFromDocument([
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_alice",
    "    displayName: Alice Admin",
    "    primaryEmail: alice@example.com",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: alice",
    "      - kind: email-address",
    "        issuer: email:primary",
    "        subject: alice@example.com",
    "  - personId: person_viewer",
    "    displayName: Victor Viewer",
    "    roles: [observer]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: viewer",
    "  - personId: person_maint",
    "    displayName: Mina Maintainer",
    "    primaryEmail: maint@example.com",
    "    roles: [maintainer]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: maint",
    "  - personId: person_arbiter",
    "    displayName: Ari Arbiter",
    "    primaryEmail: ari@example.com",
    "    roles: [arbiter]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: ari",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: observer",
    "    commandClasses: [repo-read]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    "  - roleId: arbiter",
    "    commandClasses: [arbiter, repo-write, repo-read]",
    ""
  ].join("\n"));
}

function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-rbac-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}
