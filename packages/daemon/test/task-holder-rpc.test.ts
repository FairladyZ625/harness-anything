import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LocalControllerService, RuntimeEventAppendInput } from "../../application/src/index.ts";
import { makeTaskHolderService } from "../../application/src/index.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import {
  createJsonRpcProtocolServer,
  makeTransportDerivedIdentityProvider,
  peopleRosterFromDocument,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PeopleRoster
} from "../src/index.ts";
import { leaseEnforcementEnabled } from "../../cli/src/commands/settings.ts";

test("task holder RPC claims, reports collisions with holder and expiry, and releases", async () => {
  const rootDir = createHarnessRoot();
  try {
    const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
    const { alice, maint } = makeActorServers(rootDir);
    await hello(alice);
    await hello(maint);

    const claimed = resultReceipt(await alice.handle(taskHolderRequest("repo.task.claim", taskId, { ttlMs: 60_000 })));
    assert.equal(claimed.ok, true);
    assert.equal(claimed.command, "repo.task.claim");
    assert.equal(claimed.details.data.leaseExpiresAt, "2026-07-10T00:01:00.000Z");
    assert.equal(claimed.details.data.effectiveHolder.principal.personId, "person_alice");
    assert.equal(claimed.details.data.effectiveHolder.executor, null);
    assert.equal(claimed.details.data.effectiveHolder.responsibleHuman, "person:person_alice");

    const collision = resultReceipt(await maint.handle(taskHolderRequest("repo.task.claim", taskId, { ttlMs: 60_000 })));
    assert.equal(collision.ok, false);
    assert.equal(collision.error?.code, "task_claim_collision");
    assert.equal(collision.details.holder.principal.personId, "person_alice");
    assert.equal(collision.details.leaseExpiresAt, "2026-07-10T00:01:00.000Z");

    const holder = resultReceipt(await maint.handle(taskHolderRequest("repo.task.holder", taskId)));
    assert.equal(holder.ok, true);
    assert.equal(holder.details.data.effectiveHolder.principal.personId, "person_alice");

    const released = resultReceipt(await alice.handle(taskHolderRequest("repo.task.release", taskId)));
    assert.equal(released.ok, true);
    assert.equal(released.details.data.previousHolder.principal.personId, "person_alice");
    assert.equal(released.details.data.effectiveHolder, null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task holder RPC records asserted executor and responsible human in holder events", async () => {
  const rootDir = createHarnessRoot();
  const events: RuntimeEventAppendInput[] = [];
  try {
    const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
    const { alice } = makeActorServers(rootDir, emptyLocalController(), (event) => {
      events.push(event);
      return Promise.resolve();
    });
    await hello(alice);

    const executor = { kind: "agent", id: "codex" } as const;
    const claimed = resultReceipt(await alice.handle(taskHolderRequest("repo.task.claim", taskId, { ttlMs: 60_000, executor })));
    assert.equal(claimed.ok, true);
    assert.deepEqual(claimed.details.data.effectiveHolder.executor, executor);
    assert.equal(claimed.details.data.effectiveHolder.responsibleHuman, "person:person_alice");

    const released = resultReceipt(await alice.handle(taskHolderRequest("repo.task.release", taskId, { executor })));
    assert.equal(released.ok, true);

    const claimEvent = events.find((event) => event.tool?.toolName === "repo.task.claim");
    const releaseEvent = events.find((event) => event.tool?.toolName === "repo.task.release");
    assert.equal(claimEvent?.actor?.principal.personId, "person_alice");
    assert.deepEqual(claimEvent?.actor?.executor, executor);
    assert.equal(claimEvent?.actor?.responsibleHuman, "person:person_alice");
    assert.equal(releaseEvent?.actor?.principal.personId, "person_alice");
    assert.deepEqual(releaseEvent?.actor?.executor, executor);
    assert.equal(releaseEvent?.actor?.responsibleHuman, "person:person_alice");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task lease enforcement guards daemon task progress API writes when enabled by workspace configuration", async () => {
  const previous = process.env.HARNESS_TASK_LEASE_ENFORCEMENT;
  const rootDir = createHarnessRoot(["settings:", "  tasks:", "    leaseEnforcement: true"]);
  try {
    delete process.env.HARNESS_TASK_LEASE_ENFORCEMENT;
    let progressWrites = 0;
    const { alice, maint } = makeActorServers(rootDir, {
      ...emptyLocalController(),
      appendTaskProgress: async () => {
        progressWrites += 1;
        return { ok: true };
      }
    });
    await hello(alice);
    await hello(maint);

    const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
    const claimed = resultReceipt(await alice.handle(taskHolderRequest("repo.task.claim", taskId, { ttlMs: 60_000 })));
    assert.equal(claimed.ok, true);

    const denied = resultReceipt(await maint.handle({
      jsonrpc: "2.0",
      id: "progress-lease-denied",
      method: "repo.tasks.progress.append",
      params: {
        repo: { repoId: "canonical" },
        payload: { taskId, text: "try append" }
      }
    }));
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, "task_lease_required");
    assert.equal(denied.details.holder.principal.personId, "person_alice");
    assert.equal(denied.details.leaseExpiresAt, "2026-07-10T00:01:00.000Z");
    assert.equal(progressWrites, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_TASK_LEASE_ENFORCEMENT;
    } else {
      process.env.HARNESS_TASK_LEASE_ENFORCEMENT = previous;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("daemon lease enforcement accepts explicit environment disable over workspace configuration", async () => {
  const previous = process.env.HARNESS_TASK_LEASE_ENFORCEMENT;
  const rootDir = createHarnessRoot(["settings:", "  tasks:", "    leaseEnforcement: true"]);
  try {
    process.env.HARNESS_TASK_LEASE_ENFORCEMENT = "0";
    let progressWrites = 0;
    const { maint } = makeActorServers(rootDir, {
      ...emptyLocalController(),
      appendTaskProgress: async () => {
        progressWrites += 1;
        return { ok: true };
      }
    });
    await hello(maint);

    const result = resultReceipt(await maint.handle({
      jsonrpc: "2.0",
      id: "progress-lease-env-disabled",
      method: "repo.tasks.progress.append",
      params: {
        repo: { repoId: "canonical" },
        payload: { taskId: "task_01KX19GEKWMEJNGSMRT6JJH6HY", text: "allowed by env" }
      }
    }));
    assert.equal(result.ok, true);
    assert.equal(progressWrites, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.HARNESS_TASK_LEASE_ENFORCEMENT;
    } else {
      process.env.HARNESS_TASK_LEASE_ENFORCEMENT = previous;
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function makeActorServers(
  rootDir: string,
  localController: LocalControllerService = emptyLocalController(),
  appendRuntimeEvent?: Parameters<typeof createJsonRpcProtocolServer>[0]["appendRuntimeEvent"]
) {
  const roster = sampleRoster();
  const taskHolderService = makeTaskHolderService({
    rootInput: rootDir,
    now: () => new Date("2026-07-10T00:00:00.000Z")
  });
  const services = {
    LocalControllerService: localController,
    TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
    TaskHolderService: taskHolderService
  };
  return {
    alice: createActorServer(rootDir, roster, "alice", services, appendRuntimeEvent),
    maint: createActorServer(rootDir, roster, "maint", services, appendRuntimeEvent)
  };
}

function createActorServer(
  rootDir: string,
  roster: PeopleRoster,
  username: "alice" | "maint",
  services: Parameters<typeof createJsonRpcProtocolServer>[0]["services"],
  appendRuntimeEvent?: Parameters<typeof createJsonRpcProtocolServer>[0]["appendRuntimeEvent"]
) {
  return createJsonRpcProtocolServer({
    daemonId: "daemon-task-holder-test",
    repos: [{ repoId: "canonical", canonicalRoot: rootDir }],
    peopleRoster: roster,
    identityProvider: makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" }),
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username, host: "team-host", source: "ssh-authenticated-exec" }
    },
    services,
    leaseEnforcementEnabled: (repo) => leaseEnforcementEnabled(repo.canonicalRoot),
    appendRuntimeEvent
  });
}

async function hello(server: ReturnType<typeof createJsonRpcProtocolServer>): Promise<void> {
  const receipt = resultReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "hello",
    method: "protocol.hello",
    params: { protocolVersion: 1 }
  }));
  assert.equal(receipt.ok, true);
}

function taskHolderRequest(method: "repo.task.claim" | "repo.task.holder" | "repo.task.release", taskId: string, extraPayload: Record<string, unknown> = {}): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: `${method}-${taskId}`,
    method,
    params: {
      repo: { repoId: "canonical" },
      payload: { taskId, ...extraPayload }
    }
  };
}

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
  readonly error?: { readonly code?: string };
  readonly details: Record<string, any>;
} {
  assert.ok(response && !Array.isArray(response));
  assert.equal("result" in response, true);
  return response.result as {
    readonly ok: boolean;
    readonly command: string;
    readonly error?: { readonly code?: string };
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
    "  - personId: person_maint",
    "    displayName: Mina Maintainer",
    "    primaryEmail: maint@example.com",
    "    roles: [maintainer]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: maint",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    ""
  ].join("\n"));
}

function createHarnessRoot(settings: ReadonlyArray<string> = []): string {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-task-holder-rpc-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), ["schema: harness-anything/v1", "layout:", "  authoredRoot: harness", ...settings, ""].join("\n"), "utf8");
  return rootDir;
}
