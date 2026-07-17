// harness-test-tier: contract
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import type { RuntimeEventAppendInput } from "../../application/src/index.ts";
import { apiRouteContracts } from "../../gui/src/api/api-contract-registry.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import { commandSpecs } from "../../cli/src/cli/command-spec/index.ts";
import {
  composeIdentityProvider,
  currentDaemonProtocolVersion,
  jsonRpcServiceMethodContracts,
  jsonRpcMethodContracts,
  repoCommandRunClassifiedActionKinds,
  makePeopleRosterAuthorizationProvider,
  makeTransportDerivedIdentityProvider,
  type IdentityProvider,
  type JsonRpcRequest
} from "../src/index.ts";
import {
  commandRunRequest,
  createHarnessRoot,
  emptyLocalController,
  makeServer,
  readFixture,
  readJson,
  resultReceipt,
  rosterIdentityOptions,
  sampleRoster
} from "./json-rpc-protocol-fixtures.ts";

test("daemon JSON-RPC service method registry is derived from the API contract registry", () => {
  assert.deepEqual(
    jsonRpcServiceMethodContracts.map((contract) => ({
      method: contract.method,
      service: contract.service,
      serviceMethod: contract.serviceMethod,
      inputSchemaId: contract.inputSchemaId,
      outputSchemaId: contract.outputSchemaId
    })),
    apiRouteContracts
      .filter((contract) => contract.commandClass !== "admin")
      .map((contract) => ({
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
    commandSpecs
      .map((spec) => spec.kind)
      .filter((kind) => kind !== "doc-sync-submit") // Uses the dedicated repo.doc.sync.submit method.
      .sort()
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


test("repo methods fail closed when the repo runtime is unavailable", async () => {
  let serviceCalls = 0;
  const server = makeServer({
    repos: [
      { repoId: "canonical", canonicalRoot: "/tmp/canonical" },
      { repoId: "locked", canonicalRoot: "/tmp/locked" }
    ],
    resolveRepoAvailability: (repo) => repo.repoId === "locked"
      ? {
          code: "repo_lock_held",
          repo: {
            repoId: repo.repoId,
            canonicalRoot: repo.canonicalRoot,
            state: "unavailable",
            lockPath: ".harness/locks/global.lock",
            lockOwnerToken: null,
            lastError: "lock already held: daemon owner"
          }
        }
      : undefined,
    services: {
      LocalControllerService: {
        ...emptyLocalController(),
        getTasks: () => {
          serviceCalls += 1;
          return { ok: true, tasks: [], warnings: [] };
        }
      },
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    ...readFixture("repo-request.json"),
    params: { repo: { repoId: "locked" }, payload: {} }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "repo_lock_held");
  assert.equal(receipt.error?.hint, "Repo locked is not attached to this daemon.");
  assert.equal((receipt.details.repo as { state?: string }).state, "unavailable");
  assert.deepEqual(receipt.next, [{
    command: "ha --repo locked daemon status --json",
    description: "Inspect this repo's daemon attachment state; unavailable repos are retried automatically."
  }, {
    command: "ha daemon repo register --repo-id locked --root /tmp/locked",
    description: "Register or re-enable this repo if it is missing or disabled, then retry the original command."
  }]);
  assert.equal(serviceCalls, 0);
});

test("repo methods fail closed when the repo runtime context is missing", async () => {
  let serviceCalls = 0;
  const server = makeServer({
    resolveRepoAvailability: (repo) => ({
      code: "repo_unavailable",
      repo: {
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        state: "unavailable",
        lockPath: null,
        lockOwnerToken: null,
        lastError: "runtime context not found"
      }
    }),
    services: {
      LocalControllerService: {
        ...emptyLocalController(),
        getTasks: () => {
          serviceCalls += 1;
          return { ok: true, tasks: [], warnings: [] };
        }
      },
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle(readFixture("repo-request.json"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "repo_unavailable");
  assert.equal(receipt.error?.hint, "Repo canonical is not attached to this daemon.");
  assert.equal((receipt.details.repo as { lastError?: string }).lastError, "runtime context not found");
  assert.deepEqual(receipt.next?.map((action: { command: string }) => action.command), [
    "ha --repo canonical daemon status --json",
    "ha daemon repo register --repo-id canonical --root /tmp/canonical"
  ]);
  assert.equal(serviceCalls, 0);
});

test("repo.daemon.status rejects a v1-shaped service result", async () => {
  const server = makeServer({
    repos: [
      { repoId: "canonical", canonicalRoot: "/tmp/canonical" },
      { repoId: "locked", canonicalRoot: "/tmp/locked" }
    ],
    resolveRepoAvailability: (repo) => repo.repoId === "locked"
      ? {
          code: "repo_unavailable",
          repo: {
            repoId: repo.repoId,
            canonicalRoot: repo.canonicalRoot,
            state: "unavailable",
            lockPath: null,
            lockOwnerToken: null,
            lastError: "recovery failed"
          }
        }
      : undefined,
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DaemonStatusService: {
        getStatus: (context) => ({
          schema: "daemon-status/v1",
          requestedRepoId: context?.repo.repoId ?? null,
          repos: [
            { repoId: "canonical", canonicalRoot: "/tmp/canonical", state: "attached" },
            { repoId: "locked", canonicalRoot: "/tmp/locked", state: "unavailable", lastError: "recovery failed" }
          ]
        })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "status-locked",
    method: "repo.daemon.status",
    params: { repo: { repoId: "locked" } }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "daemon_status_result_invalid");
});

test("daemon control returns accepted data before exposing the stop action", async () => {
  let stopRequested = false;
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
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
            operationId: "control-restart",
            kind,
            scope: "service",
            requestedAt: "2026-07-16T08:30:00.000Z",
            before: {
              pid: 41001,
              loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              repoCount: 2,
              queueDepth: 1
            }
          },
          afterResponse: () => {
            stopRequested = true;
          }
        })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "restart",
    method: "admin.daemon.restart",
    params: { payload: { reason: "operator request", drainTimeoutMs: 5000 } }
  });
  const receipt = resultReceipt(response);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.details.data.schema, "daemon-control-accepted/v1");
  assert.equal(stopRequested, false);
  server.afterResponse?.();
  assert.equal(stopRequested, true);
});

test("repo.command.run rejects payload rootDir that does not match the repo namespace", async () => {
  const calls: string[] = [];
  const server = makeServer({
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async () => {
          calls.push("called");
          return {
            ok: true,
            schema: "command-receipt/v2",
            command: "version",
            action: "version",
            summary: "version",
            details: {},
            meta: { generatedAt: "2026-07-07T00:00:00.000Z", compatibility: { legacyReceipt: "CommandReceipt/v1" } }
          };
        }
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle(commandRunRequest("version", "root-mismatch", "/tmp/other"));
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "repo_command_root_mismatch");
  assert.deepEqual(calls, []);
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
    ...rosterIdentityOptions(roster),
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
  const resolved = await provider.authenticate({
    transportKind: "ssh-exec",
    sshExecUser: { username: "mallory", host: "team-host", source: "ssh-authenticated-exec" }
  });

  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.code, "credential_unknown");
});

test("SSH forced-command authentication fails closed when the people roster provider is unavailable", async () => {
  const server = makeServer({
    authContext: {
      transportKind: "unix-socket",
      sshForcedCommand: {
        personId: "person_alice",
        canonicalRoot: "/tmp/canonical",
        source: "sshd-authorized-keys-forced-command"
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const request = commandRunRequest("version", "forced-no-roster");
  const response = await server.handle({
    ...request,
    params: {
      repo: { repoId: "canonical", canonicalRoot: "/tmp/canonical" },
      payload: { command: { rootDir: "/tmp/canonical", json: true, action: { kind: "version" } } }
    }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "provider_unavailable");
  assert.match(receipt.error?.hint ?? "", /identity provider/iu);
});

test("mock email provider proves provider extension without daemon call-site changes", async () => {
  const roster = sampleRoster();
  const emailProvider: IdentityProvider = composeIdentityProvider({
    providerId: "email-session/v1",
    authenticate: async (evidence) => {
      const claims = evidence.sshTunnelToken?.subject.claims;
      const email = claims && typeof claims.email === "string" ? claims.email.toLowerCase() : "";
      return roster.resolveCredential({ kind: "email-address", issuer: "email:primary", subject: email }, "email-session/v1");
    }
  }, makePeopleRosterAuthorizationProvider(roster));

  const resolved = await emailProvider.authenticate({
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
  });

  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.personId, "person_alice");
    assert.equal(resolved.providerId, "email-session/v1");
  }
});

test("RBAC rejects non-arbiter methods and records a runtime event with actor", async () => {
  const rootDir = createHarnessRoot();
  let event: RuntimeEventAppendInput | undefined;
  try {
    const roster = sampleRoster();
    const server = makeServer({
      ...rosterIdentityOptions(roster),
      authContext: {
        transportKind: "ssh-exec",
        sshExecUser: { username: "viewer", host: "team-host", source: "ssh-authenticated-exec" }
      },
      appendRuntimeEvent: async (input) => { event = input; }
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
    assert.ok(event);
    assert.equal(event.actor?.principal?.personId, "person_viewer");
    assert.equal(event.actor?.executor, null);
    assert.equal("responsibleHuman" in event.actor, false);
    assert.equal(event.result?.errorCode, "rbac_forbidden");
    assert.equal(event.tool?.toolName, "repo.tasks.review");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime event append receives the validated repo namespace", async () => {
  const eventRepos: string[] = [];
  const roster = sampleRoster();
  const server = makeServer({
    ...rosterIdentityOptions(roster),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "maint", host: "team-host", source: "ssh-authenticated-exec" }
    },
    appendRuntimeEvent: async (_input, context) => {
      eventRepos.push(context?.repo.repoId ?? "none");
    },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      DocSyncService: {
        submit: async () => ({
          ok: true,
          schema: "daemon.doc-sync-submit-result/v1",
          status: "accepted",
          intentId: "intent-event-repo",
          baseLedgerSha: "base",
          appliedLedgerSha: "applied",
          appliedChanges: []
        })
      }
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const response = await server.handle({
    jsonrpc: "2.0",
    id: "repo-event",
    method: "repo.doc.sync.submit",
    params: {
      repo: { repoId: "canonical" },
      payload: {
        baseLedgerSha: "base",
        intentId: "intent-event-repo",
        declaredIntent: "prose-edit",
        changes: []
      }
    }
  });
  const receipt = resultReceipt(response);

  assert.equal(receipt.ok, true);
  assert.deepEqual(eventRepos, ["canonical"]);
});

test("repo.command.run derives RBAC from the inner CLI command", async () => {
  const roster = sampleRoster();
  const calls: string[] = [];
  const server = makeServer({
    ...rosterIdentityOptions(roster),
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

  const arbiterReceipt = resultReceipt(await server.handle(commandRunRequest("decision-transition", "rbac-arbiter")));
  assert.equal(arbiterReceipt.ok, false);
  assert.equal(arbiterReceipt.error?.code, "rbac_forbidden");
  assert.equal(arbiterReceipt.details.commandClass, "arbiter");
  assert.deepEqual(calls, ["version", "new-task"]);
});
