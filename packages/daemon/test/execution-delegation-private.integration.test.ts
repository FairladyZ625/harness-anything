// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  canonicalEventWritePlan,
  makeTaskEventReader,
  makeTaskEventStore,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { serveKeycloak } from "./keycloak.fixtures.ts";
import { executionDelegationPath, readExecutionDelegations } from "../src/execution-delegation-store.ts";
const runtimeSessionId = "runtime-ledger-ops",
  issuerPersonId = "person_zeyu";

test("center private delegation survives restart and narrows online Keycloak permission", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-s6-private-")),
    rootDir = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    realm = await serveKeycloak();
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  t.after(async () => {
    await cell?.close();
    await realm.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(rootDir);
  execFileSync("git", ["init", "--quiet", rootDir]);
  execFileSync("git", [
    "-C",
    rootDir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await seedRuntimeSession(rootDir);
  const accessToken = realm.keycloak.account(issuerPersonId),
    route = { userRoot, daemonId: "s6-private", endpoint: path.join(root, "daemon.sock") },
    binding = {
      actor: { principal: { personId: issuerPersonId }, executor: null },
      source: "local" as const,
      keycloakAuthorization: {
        session: {
          personId: issuerPersonId,
          accessToken,
          url: realm.url,
          realm: "harness",
          clientId: "harness-center",
        },
      },
    },
    actions = ["task-create", "task-amend", "people-delegate", "people-revoke-delegation"];
  realm.keycloak.permit(issuerPersonId, "delegated-ledger-ops", actions);
  realm.keycloak.permit(issuerPersonId, "delegated-ledger-ops:task/task-private-target", actions);
  realm.keycloak.permit(issuerPersonId, "delegated-ledger-ops:person/" + issuerPersonId, actions);
  let now = "2026-09-19T10:00:00.000Z",
    holdAudit = false;
  const open = () =>
    openRepoCell({
      repoId: workspaceId("delegated-ledger-ops"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "s6-private",
      runtimeDaemonRoute: route,
      now: () => now,
      killpoint: (point) => {
        if (holdAudit && point === "before_event_write") throw new Error("fixture holds the audit");
      },
    });
  cell = await open();
  const amend = {
      kind: "task-amend",
      taskId: "task-private-target",
      patches: [{ field: "title", value: "Private delegation" }],
      executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
    },
    issue = {
      kind: "people-delegate",
      tokenId: "det_private",
      runtimeSessionId,
      action: ["task-amend"],
      expiresAt: "2026-09-19T12:00:00.000Z",
      idempotencyKey: "private-once",
    };
  assert.equal(
    (await cell.run({ kind: "task-create", taskId: "task-private-target", title: "Target" }, binding)).outcome,
    "applied",
  );
  assert.equal((await cell.run(amend, binding)).code, "executor_binding_invalid");
  holdAudit = true;
  const unsettled = await cell.run(issue, binding);
  assert.equal(unsettled.outcome, "indeterminate", JSON.stringify(unsettled));
  holdAudit = false;
  assert.equal((await cell.run(amend, binding)).code, "executor_binding_invalid");
  const issued = await cell.run(issue, binding);
  assert.equal(issued.outcome, "applied", JSON.stringify(issued));
  assert.equal((await cell.run(issue, binding)).outcome, "applied");
  assert.equal((await cell.run({ ...issue, action: ["task-create"] }, binding)).code, "revision_conflict");
  const file = executionDelegationPath(route, "delegated-ledger-ops");
  assert.equal(readExecutionDelegations(file, "delegated-ledger-ops").records.length, 1);
  const [firstIssue, competingIssue] = await Promise.all([
    cell.run(
      { ...issue, tokenId: "det_concurrent", action: ["task-create"], idempotencyKey: "concurrent-one" },
      binding,
    ),
    cell.run(
      { ...issue, tokenId: "det_concurrent", action: ["task-create"], idempotencyKey: "concurrent-two" },
      binding,
    ),
  ]);
  assert.equal(firstIssue.outcome, "applied");
  assert.equal(competingIssue.code, "invalid_delegated_execution_token");
  assert.equal(readExecutionDelegations(file, "delegated-ledger-ops").records.length, 2);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(rootDir, "harness", "people.yaml")), false);
  await cell.close();
  cell = await open();
  const delegated = await cell.run(amend, binding);
  assert.equal(delegated.outcome, "applied");
  assert.ok(delegated.authorizationDecision.bindingsUsed.some((proof) => proof.proof === "delegated-execution-token"));
  const forbidden = await cell.run({ ...amend, kind: "task-delete" }, binding);
  assert.equal(forbidden.code, "executor_binding_invalid");
  const otherSource = { ...binding, source: { kind: "assignment" as const, nodeId: "other", assignmentId: "other" } };
  assert.equal((await cell.run(amend, otherSource)).code, "executor_binding_invalid");
  assert.throws(() => readExecutionDelegations(file, "other-repo"));
  const otherToken = realm.keycloak.account("person_other");
  realm.keycloak.permit("person_other", "delegated-ledger-ops", actions);
  const otherPrincipal = {
    ...binding,
    actor: { principal: { personId: "person_other" }, executor: null },
    keycloakAuthorization: {
      session: { ...binding.keycloakAuthorization.session, personId: "person_other", accessToken: otherToken },
    },
  };
  assert.equal((await cell.run(amend, otherPrincipal)).code, "executor_binding_invalid");
  writeFileSync(path.join(rootDir, "harness", "people.yaml"), '{"roles":[{"roleId":"owner"}]}');
  const deniedBinding = {
    ...binding,
    authorizationDecision: delegated.authorizationDecision,
    keycloakAuthorization: { session: { ...binding.keycloakAuthorization.session, accessToken: "unknown" } },
  };
  const denied = await cell.run(amend, deniedBinding);
  assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
  const offlineBinding = {
    ...binding,
    keycloakAuthorization: { session: { ...binding.keycloakAuthorization.session, url: "http://127.0.0.1:1" } },
  };
  const beforeOffline = makeTaskEventReader({ repoId: "delegated-ledger-ops", rootDir }).read().revision;
  assert.equal(typeof beforeOffline, "number");
  const offline = await cell.run(amend, offlineBinding);
  assert.equal(offline.outcome, "op_rejected", JSON.stringify(offline));
  assert.equal(offline.code, "service_rejected");
  assert.equal(makeTaskEventReader({ repoId: "delegated-ledger-ops", rootDir }).read().revision, beforeOffline);
  now = "2026-09-19T12:00:00.000Z";
  assert.equal((await cell.run(amend, binding)).code, "executor_binding_invalid");
  now = "2026-09-19T10:30:00.000Z";
  const [revoked, queuedAfterRevoke] = await Promise.all([
    cell.run({ kind: "people-revoke-delegation", tokenId: "det_private" }, binding),
    cell.run(amend, binding),
  ]);
  assert.equal(revoked.outcome, "applied");
  assert.equal(queuedAfterRevoke.code, "executor_binding_invalid");
  await cell.close();
  cell = await open();
  assert.equal((await cell.run(amend, binding)).code, "executor_binding_invalid");
});

async function seedRuntimeSession(rootDir: string): Promise<void> {
  const store = makeTaskEventStore({
      repoId: "delegated-ledger-ops",
      rootDir,
      activationPreflight: activateEmptyCanonicalGeneration,
    }),
    occurredAt = "2026-09-19T09:00:00.000Z",
    common = (revision: number) => ({
      schema: "agent-runtime-event/v1" as const,
      eventId: `event-delegated-${revision}`,
      workspaceRevision: revision,
      opId: `op-delegated-${revision}`,
      actor: { principal: { personId: issuerPersonId }, executor: null },
      source: "local" as const,
      occurredAt,
    }),
    events = [
      {
        ...common(1),
        type: "runtime_installation_observed",
        payload: {
          installationId: "installation-codex",
          kindId: "codex",
          protocolFamily: "codex",
          hostRef: "host:local",
          version: "1.0.0",
          discoverySource: "wrapper",
          capabilities: ["structured_witness", "resume", "attach", "session_identity"],
        },
      },
      {
        ...common(2),
        type: "runtime_dispatch_requested",
        payload: {
          dispatchId: "dispatch_delegated0000000000000001",
          runtimeSessionId,
          instanceId: "delegated-instance",
          installationId: "installation-codex",
          kindId: "codex",
          idempotencyKey: "delegated-ledger-ops-once",
          definitionSnapshotRef: "artifact:runtime-definition/delegated",
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "delegated-instance",
            installationId: "installation-codex",
            kindId: "codex",
            providerId: "openai",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            baseUrl: null,
            authMode: "subscription",
          },
        },
      },
      {
        ...common(3),
        type: "runtime_session_started",
        payload: {
          runtimeSessionId,
          instanceId: "delegated-instance",
          installationId: "installation-codex",
          kindId: "codex",
          definitionSnapshotRef: "artifact:runtime-definition/delegated",
          launchGeneration: 1,
          attachable: true,
        },
      },
    ] as readonly AgentRuntimeEventV1[];
  for (const event of events)
    store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
  await store.drain();
}
