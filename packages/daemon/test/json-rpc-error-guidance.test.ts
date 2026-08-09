// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskHolderService } from "../../application/src/index.ts";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import { jsonRpcMethodContract } from "../src/protocol/method-registry.ts";
import { validateTaskLeaseForServiceWrite } from "../src/protocol/task-holder-write-policy.ts";
import {
  commandRunRequest,
  emptyLocalController,
  makeServer,
  readFixture,
  resultReceipt,
  rosterIdentityOptions,
  sampleRoster
} from "./json-rpc-protocol-fixtures.ts";

test("missing daemon service composition gives observation-only recovery guidance", async () => {
  const server = makeServer({ resolveRepoServices: () => undefined });
  await server.handle(readFixture("hello-compatible.json"));
  const receipt = resultReceipt(await server.handle(readFixture("repo-request.json")));

  assert.equal(receipt.error?.code, "repo_service_unavailable");
  assert.equal(receipt.error?.hint, "Repo service host for canonical is absent from the running daemon composition. Run `ha daemon logs --errors --json` to capture the missing repo composition. Do not register, stop, or restart the repo; retry only after an operator supplies and verifies a composition for canonical.");
});

test("missing status and command services do not prescribe daemon replacement", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));

  const status = resultReceipt(await server.handle({
    jsonrpc: "2.0", id: "missing-status", method: "repo.daemon.status",
    params: { repo: { repoId: "canonical" }, payload: {} }
  }));
  assert.equal(status.error?.code, "daemon_status_service_unavailable");
  assert.equal(status.error?.hint, "Daemon status service is absent from the running composition. Run `ha daemon logs --errors --json` to capture the missing service. Leave the daemon running; an operator must verify a replacement composition before any restart.");

  const command = resultReceipt(await server.handle(commandRunRequest("version", "missing-command")));
  assert.equal(command.error?.code, "cli_command_service_unavailable");
  assert.equal(command.error?.hint, "Daemon command service is absent from the repository composition. Run `ha daemon logs --errors --json` to capture the missing command host. Leave the daemon running; retry only after an operator supplies and verifies a replacement composition.");
});

test("missing task-holder service and task id preserve lease state", async () => {
  const server = makeServer();
  await server.handle(readFixture("hello-compatible.json"));
  const missingService = resultReceipt(await server.handle({
    jsonrpc: "2.0", id: "missing-holder-service", method: "repo.task.holder",
    params: { repo: { repoId: "canonical" }, payload: { taskId: "task_RENDER" } }
  }));
  assert.equal(missingService.error?.code, "task_holder_service_unavailable");
  assert.equal(missingService.error?.hint, "Task holder service is absent from the running composition. Run `ha daemon logs --errors --json` to capture the missing service. Leave the daemon and current lease state unchanged; retry only after an operator verifies a replacement composition.");

  const taskHolderService = {
    holder: async () => null,
    claim: async () => null,
    release: async () => null,
    assertActiveLease: async () => undefined
  } as unknown as TaskHolderService;
  const missingTaskIdServer = makeServer({
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      TaskHolderService: taskHolderService
    }
  });
  await missingTaskIdServer.handle(readFixture("hello-compatible.json"));
  const missingTaskId = resultReceipt(await missingTaskIdServer.handle({
    jsonrpc: "2.0", id: "missing-task-id", method: "repo.task.holder",
    params: { repo: { repoId: "canonical" }, payload: {} }
  }));
  assert.equal(missingTaskId.error?.code, "task_id_required");
  assert.equal(missingTaskId.error?.hint, "Required payload.taskId is missing from the raw RPC request, so no holder lookup ran. Supply the intended concrete task id in payload.taskId and retry the same RPC; no task state was changed.");

  const missingLeaseTaskId = await validateTaskLeaseForServiceWrite(
    jsonRpcMethodContract("repo.tasks.status.set")!,
    { status: "in_progress" },
    { TaskHolderService: taskHolderService },
    undefined,
    { repoId: "canonical", canonicalRoot: "/tmp/canonical" },
    { leaseEnforcementEnabled: () => true }
  );
  assert.equal(missingLeaseTaskId?.error?.code, "task_id_required");
  assert.equal(missingLeaseTaskId?.error?.hint, "Required payload.taskId is missing from the raw RPC request, so lease enforcement did not run. Supply the intended concrete task id in payload.taskId and retry the same RPC; no task state was changed.");
});

test("missing admin roster reports the loaded-composition boundary without restart", async () => {
  const roster = sampleRoster();
  const identity = rosterIdentityOptions(roster);
  const server = makeServer({
    identityProvider: identity.identityProvider,
    personRegistry: identity.personRegistry,
    authContext: { transportKind: "ssh-exec", sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" } }
  });
  await server.handle(readFixture("hello-compatible.json"));
  const receipt = resultReceipt(await server.handle({ jsonrpc: "2.0", id: "missing-admin-roster", method: "admin.people.list", params: {} }));

  assert.equal(receipt.error?.code, "people_roster_unavailable");
  assert.equal(receipt.error?.hint, "Admin identity methods cannot run because the active daemon composition has no loaded people roster. Run `ha daemon status --check --json` and inspect the reported daemon user root and roster state. Leave the daemon running; an operator must load and verify the roster before retrying.");
});

test("missing doc-sync and lease services preserve the pending write", async () => {
  const roster = sampleRoster();
  const identity = rosterIdentityOptions(roster);
  const server = makeServer({
    identityProvider: identity.identityProvider,
    personRegistry: identity.personRegistry,
    authContext: { transportKind: "ssh-exec", sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" } },
    leaseEnforcementEnabled: () => true
  });
  await server.handle(readFixture("hello-compatible.json"));

  const docSync = resultReceipt(await server.handle({
    jsonrpc: "2.0", id: "missing-doc-sync", method: "repo.doc.sync.submit",
    params: { repo: { repoId: "canonical" }, payload: { baseLedgerSha: "base", intentId: "intent-preserved", declaredIntent: "prose-edit", changes: [] } }
  }));
  assert.equal(docSync.error?.code, "doc_sync_service_unavailable");
  assert.equal(docSync.error?.hint, "Required doc sync submit service is missing from the repository write composition, so no write was submitted. Run `ha doc status --json` to preserve and inspect the dirty prose. Leave the daemon running; do not resubmit until an operator verifies a replacement composition.");

  const lease = resultReceipt(await server.handle({
    jsonrpc: "2.0", id: "missing-lease-service", method: "repo.tasks.status.set",
    params: { repo: { repoId: "canonical" }, payload: { taskId: "task_RENDER", status: "in_progress" } }
  }));
  assert.equal(lease.error?.code, "task_holder_service_unavailable");
  assert.equal(lease.error?.hint, "Task holder service is absent from the running composition. Run `ha daemon logs --errors --json` to capture the missing service. Leave the daemon and current lease state unchanged; retry only after an operator verifies a replacement composition.");
});
