// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLocalLifecycleEngine } from "../../adapters/local/src/index.ts";
import {
  makeLocalControllerService,
  makeTaskHolderService,
  type ExecutionRecord
} from "../../application/src/index.ts";
import {
  makeJournaledWriteCoordinator,
  makeMarkdownArtifactStore
} from "../../kernel/src/index.ts";
import { readTaskReturnToIdeaSnapshot } from "../../cli/src/commands/task-return-to-idea-snapshot.ts";
import { createInMemoryTerminalSessionService } from "../src/terminal/session-registry.ts";
import {
  createJsonRpcProtocolServer,
  makePeopleRosterIdentityAdminSnapshot,
  makeTransportDerivedIdentityProvider,
  peopleRosterFromDocument,
  personRegistryFromLegacyRoster,
  type JsonRpcRequest,
  type JsonRpcResponse
} from "../src/index.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const executionId = "exe_01KX7H00000000000000000001";

test("daemon status RPC rejects residual return to planned, guards blocked ownership, and permits cleaned return", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-return-planned-"));
  try {
    const taskRoot = createActiveTask(rootDir);
    writeExecution(taskRoot, "active");
    const taskHolderService = makeTaskHolderService({ rootInput: rootDir });
    const controller = makeLocalControllerService({
      rootDir,
      artifactStore: makeMarkdownArtifactStore({ rootDir }),
      readTaskReturnToIdeaSnapshot: (requestedTaskId) => readTaskReturnToIdeaSnapshot(
        rootDir,
        requestedTaskId
      ),
      taskWriter: makeLocalLifecycleEngine({
        rootDir,
        coordinator: makeJournaledWriteCoordinator({
          rootDir,
          attribution: {
            actor: {
              principal: { kind: "person", personId: "person_alice" },
              executor: { kind: "agent", id: "daemon-integration" }
            },
            principalSource: {
              kind: "local-configured",
              authority: "harness.yaml",
              authoritySha256: "sha256:test"
            },
            executorSource: "client-asserted"
          }
        })
      })
    });
    const roster = peopleRosterFromDocument([
      "schema: harness-people/v1",
      "people:",
      "  - personId: person_alice",
      "    displayName: Alice",
      "    roles: [owner]",
      "    credentials:",
      "      - kind: ssh-username",
      "        issuer: host:team-host",
      "        subject: alice",
      "roles:",
      "  - roleId: owner",
      "    commandClasses: [admin, repo-write, repo-read, arbiter]",
      ""
    ].join("\n"));
    const personRegistry = personRegistryFromLegacyRoster(roster);
    const server = createJsonRpcProtocolServer({
      daemonId: "daemon-return-planned-test",
      repos: [{ repoId: "canonical", canonicalRoot: rootDir }],
      personRegistry,
      identityAdminSnapshot: makePeopleRosterIdentityAdminSnapshot(roster, personRegistry),
      identityProvider: makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" }),
      authContext: {
        transportKind: "ssh-exec",
        sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
      },
      services: {
        LocalControllerService: controller,
        TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
        TaskHolderService: taskHolderService
      },
      leaseEnforcementEnabled: () => true
    });
    await hello(server);
    assert.equal(receipt(await server.handle(holderRequest("repo.task.claim"))).ok, true);

    const leased = receipt(await server.handle(statusRequest("planned")));
    assert.equal(leased.ok, false);
    assert.equal(leased.error?.code, "task_return_to_idea_blocked", JSON.stringify(leased));
    assert.match(leased.error?.hint ?? "", new RegExp(`ha task release ${taskId}`, "u"));
    assert.match(leased.error?.hint ?? "", new RegExp(
      `ha task retire-execution ${taskId} --execution-id ${executionId} --reason`,
      "u"
    ));
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);

    assert.equal(receipt(await server.handle(holderRequest("repo.task.release"))).ok, true);
    const executing = receipt(await server.handle(statusRequest("planned")));
    assert.equal(executing.ok, false);
    assert.equal(executing.error?.code, "task_return_to_idea_blocked");
    assert.match(executing.error?.hint ?? "", new RegExp(
      `ha task retire-execution ${taskId} --execution-id ${executionId} --reason`,
      "u"
    ));

    writeExecution(taskRoot, "abandoned");
    const blocked = receipt(await server.handle(statusRequest("blocked")));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "task_lease_required");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: active$/mu);

    const planned = receipt(await server.handle(statusRequest("planned")));
    assert.equal(planned.ok, true);
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /^  status: planned$/mu);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function createActiveTask(rootDir: string): string {
  const taskRoot = path.join(rootDir, "harness/tasks", `${taskId}-daemon-return-planned`);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  tasks:",
    "    leaseEnforcement: true",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Daemon return to planned",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref:",
    "  titleSnapshot: Daemon return to planned",
    "  url:",
    "  bindingCreatedAt: 2026-07-31T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"codex\", sessionId: \"daemon-return-planned\", boundAt: \"2026-07-31T00:00:00.000Z\"}",
    "---",
    "",
    "# Daemon return to planned",
    ""
  ].join("\n"), "utf8");
  return taskRoot;
}

function writeExecution(taskRoot: string, state: "active" | "abandoned"): void {
  const execution: ExecutionRecord = {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state,
    primary_actor: {
      principal: { kind: "person", personId: "person_alice" },
      executor: { kind: "agent", id: "daemon-integration" },
      responsibleHuman: "person:person_alice"
    },
    claimed_at: "2026-07-31T00:00:00.000Z",
    submitted_at: state === "abandoned" ? "2026-07-31T00:01:00.000Z" : null,
    closed_at: state === "abandoned" ? "2026-07-31T00:02:00.000Z" : null,
    session_bindings: [],
    outputs: [],
    submission: state === "abandoned" ? {
      completion_claim: "retired",
      deliverables: [],
      evidence_refs: [],
      verification_notes: [],
      known_gaps: [],
      residual_risks: []
    } : null
  };
  writeFileSync(path.join(taskRoot, "executions", `${executionId}.md`), `${JSON.stringify(execution, null, 2)}\n`, "utf8");
}

function statusRequest(status: "planned" | "blocked"): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: `status-${status}`,
    method: "repo.tasks.status.set",
    params: {
      repo: { repoId: "canonical" },
      payload: { taskId, status }
    }
  };
}

function holderRequest(method: "repo.task.claim" | "repo.task.release"): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: method,
    method,
    params: {
      repo: { repoId: "canonical" },
      payload: { taskId }
    }
  };
}

async function hello(server: ReturnType<typeof createJsonRpcProtocolServer>): Promise<void> {
  assert.equal(receipt(await server.handle({
    jsonrpc: "2.0",
    id: "hello",
    method: "protocol.hello",
    params: { protocolVersion: 1 }
  })).ok, true);
}

function receipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined): {
  readonly ok: boolean;
  readonly error?: { readonly code?: string; readonly hint?: string };
} {
  assert.ok(response && !Array.isArray(response));
  assert.equal("result" in response, true);
  return response.result as {
    readonly ok: boolean;
    readonly error?: { readonly code?: string; readonly hint?: string };
  };
}
