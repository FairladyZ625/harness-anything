// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runtimeDefinitionSnapshotArtifact } from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { FLEET_FRAME_BYTES } from "../src/daemon-host/fleet/command-protocol.ts";
import { FleetRemoteError, openPeer, readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import {
  parseDaemonActionResult,
  parseDaemonReadResult,
} from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { runtimeDispatchIdentity } from "../src/daemon-host/task-dispatch-recovery.ts";
import { definition, installation } from "./fixtures/runtime-ingress.ts";
import { fleetFixture, git, initRepo, localAuthFixture, waitForReceiptCommit } from "./fleet-tls-session.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

const ALL_BUSINESS_READS = [
  { method: "repo.tasks.list", payload: { limit: 10 } },
  { method: "repo.task.show", payload: { taskId: "task-fleet" } },
  { method: "repo.task.read", payload: { action: { kind: "task-show", taskId: "task-fleet" } } },
  { method: "observe.tail", payload: { kind: "events", direction: "history" } },
  {
    method: "repo.agentRuntime.events.read",
    payload: { runtimeSessionId: "runtime-missing", afterCursor: "lifecycle:0" },
  },
  { method: "repo.agentRuntime.tokenUsage", payload: { range: "today" } },
  { method: "repo.agentRuntime.tokenUsageDetail", payload: { range: "today", agentId: "agent-alpha" } },
  { method: "repo.artifacts.list", payload: { limit: 10 } },
  { method: "repo.agenda.read", payload: { limit: 10 } },
] as const;

test(
  "fleet.operational.read/v1 serves all 9 business read methods with cursor incremental follow and chunked >96KiB transfer",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId, taskId, executionId } = fixture.subject;

    // Seed a second task for pagination and a real artifact for repo.artifacts.list.
    const secondTask = await fixture.host.run(
      repoId,
      { kind: "task-create", taskId: "task-fleet-second", title: "Second Fleet Task" },
      fixture.auth,
    );
    assert.equal(secondTask.outcome, "applied", JSON.stringify(secondTask));
    await waitForReceiptCommit(fixture.host, repoId, secondTask.opId, fixture.auth);

    writeFileSync(path.join(fixture.repo, "briefing.html"), "<h1>Fleet Briefing</h1>\n");
    const artifactAdded = await fixture.host.run(
      repoId,
      {
        kind: "task-artifact-add",
        taskId,
        source: "briefing.html",
        destination: "reports/briefing.html",
      },
      fixture.auth,
    );
    assert.equal(artifactAdded.outcome, "applied", JSON.stringify(artifactAdded));
    await waitForReceiptCommit(fixture.host, repoId, artifactAdded.opId, fixture.auth);

    // Seed a >96 KiB shared repository document to exercise real fleet.transfer.{begin,chunk,end}/v1 over TLS.
    const largeDocRel = "context/fleet-large-brief.md",
      largeBody = `# Oversized Fleet Read\n\n${"0123456789abcdef".repeat(9 * 1024)}\n`;
    assert.ok(Buffer.byteLength(largeBody) > FLEET_FRAME_BYTES);
    mkdirSync(path.dirname(path.join(fixture.repo, "harness", largeDocRel)), { recursive: true });
    writeFileSync(path.join(fixture.repo, "harness", largeDocRel), largeBody);
    const docSubmitted = await fixture.host.run(
      repoId,
      { kind: "doc-submit", paths: [largeDocRel] },
      localAuthFixture(),
    );
    assert.equal(docSubmitted.outcome, "applied", JSON.stringify(docSubmitted));
    await waitForReceiptCommit(fixture.host, repoId, docSubmitted.opId, fixture.auth);

    // Seed canonical runtime session events + a dispatch stream with token metrics.
    const artifact = runtimeDefinitionSnapshotArtifact(definition),
      identity = runtimeDispatchIdentity(repoId, "fleet-business-read"),
      nowIso = new Date().toISOString();
    const dispatchReceipt = await fixture.host.runtimeIngress(
      repoId,
      {
        kind: "event",
        type: "runtime_dispatch_requested",
        opId: "op-fleet-read-dispatch",
        payload: {
          ...identity,
          taskId,
          executionId,
          agentId: "agent-alpha",
          agentName: "Agent Alpha",
          startedAt: nowIso,
          instanceId: definition.instanceId,
          installationId: installation.installationId,
          kindId: definition.kindId,
          dispatchKey: "fleet-business-read",
          definitionSnapshot: definition,
          definitionSnapshotRef: artifact.ref,
        },
        resultBody: artifact.body,
        dispatchContext: { role: "implementation", taskId, executionId, launchGeneration: 1 },
      },
      localAuthFixture(),
    );
    assert.equal(dispatchReceipt.outcome, "applied", JSON.stringify(dispatchReceipt));

    const boundReceipt = await fixture.host.runtimeIngress(
      repoId,
      {
        kind: "event",
        type: "runtime_session_provider_bound",
        opId: "op-fleet-read-provider-bound",
        payload: {
          runtimeSessionId: identity.runtimeSessionId,
          providerSessionId: "provider-fleet-1",
          transcriptRef: "provider:codex/provider-fleet-1",
        },
      },
      localAuthFixture(),
    );
    assert.equal(boundReceipt.outcome, "applied", JSON.stringify(boundReceipt));

    openDispatchStream(fixture.repo, {
      dispatchId: identity.dispatchId,
      runtimeSessionId: identity.runtimeSessionId,
      instanceId: definition.instanceId,
      kindId: definition.kindId,
      taskId,
      executionId,
      agentId: "agent-alpha",
      agentName: "Agent Alpha",
      model: "gpt-5",
      startedAt: nowIso,
    });
    appendRuntimeWorkerRecord(fixture.repo, identity.dispatchId, {
      kind: "runtime_metrics",
      inputTokens: 1_200,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 400,
      totalTokens: 2_000,
      toolCallCount: 5,
      compacted: false,
      raw: { input_tokens: 1_200, output_tokens: 400 },
    });

    // Grant a viewer-only user `person-reader` repository-read on fleet-repo (distinct from node owner).
    fixture.owners.keycloak.account("person-reader");
    fixture.owners.keycloak.permit("person-reader", repoId, ["repository-read"]);
    fixture.owners.keycloak.interactiveSession("person-reader", nodeId, fixture.owners.url, "reader-token", "web-bff");

    const center = await fixture.center(),
      peerOptions = {
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
      };

    const eventsBeforeReads = fixture.eventCount();

    // 1. repo.tasks.list (paginated with cursor)
    const tasksPage1 = parseDaemonReadResult(
      "repo.tasks.list",
      await readFleetOperationalClient({ ...peerOptions, method: "repo.tasks.list", payload: { limit: 1 } }),
    );
    assert.equal(tasksPage1.ok, true);
    assert.equal(tasksPage1.rows.length, 1);
    assert.ok(tasksPage1.page.nextCursor);
    const tasksPage2 = parseDaemonReadResult(
      "repo.tasks.list",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.tasks.list",
        payload: { limit: 10, cursor: tasksPage1.page.nextCursor },
      }),
    );
    const listedTaskIds = [...tasksPage1.rows, ...tasksPage2.rows].map((row) => row.taskId).sort();
    assert.deepEqual(listedTaskIds, ["task-fleet", "task-fleet-second"]);

    // 2. repo.task.show
    const shown = parseDaemonActionResult(
      "repo.task.show",
      await readFleetOperationalClient({ ...peerOptions, method: "repo.task.show", payload: { taskId } }),
    );
    assert.equal(shown.ok, true);
    assert.equal(shown.command, "task-show");
    assert.equal(shown.outcome, "applied");
    const shownSnapshot = JSON.parse(String(shown.evidence)) as { readonly task: { readonly taskId: string } };
    assert.equal(shownSnapshot.task.taskId, taskId);

    // 3. repo.task.read (work-list / task-show / large doc-show > FLEET_FRAME_BYTES)
    const readViaAction = await readFleetOperationalClient({
      ...peerOptions,
      method: "repo.task.read",
      payload: { action: { kind: "task-show", taskId } },
    });
    assert.equal(readViaAction.ok, true);
    assert.equal(readViaAction.command, "task-show");
    assert.equal(
      (JSON.parse(String(readViaAction.evidence)) as { readonly task: { readonly taskId: string } }).task.taskId,
      taskId,
    );

    const largeDocResult = await readFleetOperationalClient({
      ...peerOptions,
      method: "repo.task.read",
      payload: { action: { kind: "doc-show", path: largeDocRel } },
    });
    assert.equal(largeDocResult.ok, true);
    assert.equal(largeDocResult.evidence, largeBody);
    assert.ok(
      Buffer.byteLength(JSON.stringify(largeDocResult)) > FLEET_FRAME_BYTES,
      "large doc-show read must cross the >96 KiB fleet.transfer chunked transport boundary",
    );

    // 4. observe.tail (events history + cursor incremental follow with zero duplicates/misses)
    const tailHistory = parseDaemonReadResult(
      "observe.tail",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "observe.tail",
        payload: { kind: "events", direction: "history" },
      }),
    );
    assert.equal(tailHistory.ok, true);
    assert.equal(tailHistory.kind, "events");
    assert.ok(tailHistory.items.length > 0);
    assert.ok(tailHistory.liveCursor && tailHistory.liveCursor.kind === "events");

    // 5. repo.agentRuntime.events.read (initial page from lifecycle:0)
    const runtimeEvents1 = parseDaemonReadResult(
      "repo.agentRuntime.events.read",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agentRuntime.events.read",
        payload: { runtimeSessionId: identity.runtimeSessionId, afterCursor: "lifecycle:0" },
      }),
    );
    assert.equal(runtimeEvents1.ok, true);
    assert.equal(runtimeEvents1.done, true);
    assert.deepEqual(
      runtimeEvents1.events.map((event) => event.type),
      ["runtime_dispatch_requested", "runtime_session_started"],
    );

    // 6. repo.agentRuntime.tokenUsage
    const tokenUsage = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsage",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agentRuntime.tokenUsage",
        payload: { range: "today" },
      }),
    );
    assert.equal(tokenUsage.ok, true);
    assert.ok("totals" in tokenUsage);
    if ("totals" in tokenUsage) {
      assert.equal(tokenUsage.totals.totalTokens, 2_000);
      assert.equal(
        tokenUsage.agents.some((agent) => agent.agentId === "agent-alpha"),
        true,
      );
    }

    // 7. repo.agentRuntime.tokenUsageDetail
    const tokenDetail = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-alpha" },
      }),
    );
    assert.equal(tokenDetail.ok, true);
    assert.equal(tokenDetail.member.kind, "agent");
    assert.equal(tokenDetail.totals.totalTokens, 2_000);
    assert.equal(tokenDetail.sessions.length, 1);

    // 8. repo.artifacts.list
    const artifacts = parseDaemonReadResult(
      "repo.artifacts.list",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.artifacts.list",
        payload: { limit: 20 },
      }),
    );
    assert.equal(artifacts.ok, true);
    assert.equal(
      artifacts.artifacts.some((row) => row.path.endsWith("reports/briefing.html")),
      true,
      JSON.stringify(artifacts.artifacts),
    );

    // 9. repo.agenda.read
    const agenda = parseDaemonReadResult(
      "repo.agenda.read",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agenda.read",
        payload: { limit: 20 },
      }),
    );
    assert.equal(agenda.ok, true);
    assert.equal(agenda.schema, "daemon.agenda/v1");

    // Existing operational reads remain backward compatible (dec_659E15CF).
    const dispatches = await readFleetOperationalClient({
      ...peerOptions,
      method: "repo.task.dispatches",
      payload: { taskId },
    });
    assert.equal(dispatches.ok, true);
    assert.equal(fixture.eventCount(), eventsBeforeReads, "pure business reads append no canonical events");

    // Append new events (1 task progress + 1 runtime session exit) and prove incremental cursors advance cleanly.
    const progressReceipt = await fixture.host.run(
      repoId,
      { kind: "task-progress-append", taskId, executionId, text: "incremental-cursor-check" },
      fixture.auth,
    );
    assert.equal(progressReceipt.outcome, "applied", JSON.stringify(progressReceipt));
    const exitReceipt = await fixture.host.runtimeIngress(
      repoId,
      {
        kind: "event",
        type: "runtime_session_exited",
        opId: "op-fleet-read-exited",
        payload: {
          runtimeSessionId: identity.runtimeSessionId,
        },
      },
      localAuthFixture(),
    );
    assert.equal(exitReceipt.outcome, "applied", JSON.stringify(exitReceipt));

    const tailFollow = parseDaemonReadResult(
      "observe.tail",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "observe.tail",
        payload: { kind: "events", direction: "follow", cursor: tailHistory.liveCursor },
      }),
    );
    assert.equal(tailFollow.ok, true);
    assert.equal(tailFollow.done, true);
    assert.ok(tailFollow.items.length >= 2, JSON.stringify(tailFollow.items));
    const historyRevs = new Set(tailHistory.items.map((item) => item.workspaceRevision));
    for (const item of tailFollow.items) {
      assert.equal(historyRevs.has(item.workspaceRevision), false, "follow must not duplicate history revisions");
      assert.ok(Number(item.workspaceRevision) > tailHistory.liveCursor.revision);
    }
    const tailFollowEmpty = parseDaemonReadResult(
      "observe.tail",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "observe.tail",
        payload: { kind: "events", direction: "follow", cursor: tailFollow.liveCursor },
      }),
    );
    assert.deepEqual(tailFollowEmpty.items, []);
    assert.equal(tailFollowEmpty.done, true);

    const runtimeEvents2 = parseDaemonReadResult(
      "repo.agentRuntime.events.read",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agentRuntime.events.read",
        payload: { runtimeSessionId: identity.runtimeSessionId, afterCursor: runtimeEvents1.cursor },
      }),
    );
    assert.equal(runtimeEvents2.ok, true);
    assert.equal(runtimeEvents2.done, true);
    assert.deepEqual(
      runtimeEvents2.events.map((event) => event.type),
      ["runtime_session_exited"],
    );
    const runtimeEvents3 = parseDaemonReadResult(
      "repo.agentRuntime.events.read",
      await readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agentRuntime.events.read",
        payload: { runtimeSessionId: identity.runtimeSessionId, afterCursor: runtimeEvents2.cursor },
      }),
    );
    assert.deepEqual(runtimeEvents3.events, []);
    assert.equal(runtimeEvents3.done, true);

    assert.equal(fixture.owners.nodeOwner(nodeId), "person-owner", "BFF user reads do not reassign node ownership");
    assert.deepEqual(fixture.transportErrors, [], "expected reads produce no unexpected center transport errors");
  },
);

test(
  "fleet.operational.read/v1 denies unauthorized users, cross-repo reads, host-wide tails, write actions, and invalid payloads",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId } = fixture.subject,
      keycloak = fixture.owners.keycloak;

    const center = await fixture.center();

    // Register a second repository `other-repo` on the same center host after listener boot.
    const otherRepo = path.join(fixture.root, "other-repo");
    mkdirSync(path.join(otherRepo, "harness"), { recursive: true });
    initRepo(otherRepo);
    writeFileSync(
      path.join(otherRepo, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: other\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    git(otherRepo, "add", "harness");
    git(otherRepo, "commit", "-qm", "other harness");
    registerBootstrappedDaemonRepo({
      repoId: "other-repo",
      canonicalRoot: otherRepo,
      userRoot: fixture.userRoot,
      createConvenienceLinks: false,
    });
    await fixture.host.admin(
      { kind: "register", rootDir: otherRepo, repoId: "other-repo", mode: "local" },
      localAuthFixture(),
    );
    keycloak.permit("person-owner", "other-repo", ["repository-read", "task-create"]);
    const privateTask = await fixture.host.run(
      "other-repo",
      { kind: "task-create", taskId: "task-other", title: "Confidential Other Repo Task" },
      fixture.auth,
    );
    assert.equal(privateTask.outcome, "applied", JSON.stringify(privateTask));

    // person-reader can read fleet-repo only; person-denied has zero repository grants.
    keycloak.account("person-reader");
    keycloak.permit("person-reader", repoId, ["repository-read"]);
    keycloak.interactiveSession("person-reader", nodeId, fixture.owners.url, "reader-token", "web-bff");

    keycloak.account("person-denied");
    keycloak.interactiveSession("person-denied", nodeId, fixture.owners.url, "denied-token", "web-bff");

    const peer = await openPeer({
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
    });
    t.after(() => peer.close());

    const expectFleetError = async (
      request: {
        readonly repoId: string;
        readonly method: (typeof ALL_BUSINESS_READS)[number]["method"];
        readonly payload: Readonly<Record<string, unknown>>;
        readonly accessToken?: string;
      },
      expectedCode: string,
    ) => {
      await assert.rejects(
        peer.request({
          schema: "fleet.operational.read/v1",
          messageId: peer.messageId(),
          repoId: request.repoId,
          method: request.method,
          payload: request.payload,
          ...(request.accessToken === undefined ? {} : { accessToken: request.accessToken }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof FleetRemoteError, String(error));
          assert.equal(
            error.code,
            expectedCode,
            `${request.method} on ${request.repoId}: expected ${expectedCode}, got ${error.code} (${error.message})`,
          );
          return true;
        },
      );
    };

    const eventsBefore = fixture.eventCount();

    // 1. User with no grant on fleet-repo is 100% denied across all 9 new methods.
    for (const entry of ALL_BUSINESS_READS) {
      await expectFleetError(
        { repoId, method: entry.method, payload: entry.payload, accessToken: "denied-token" },
        "authorization_denied",
      );
    }

    // 2. Cross-repository read: user granted only on fleet-repo is 100% denied on other-repo across all 9 methods.
    for (const entry of ALL_BUSINESS_READS) {
      const payload = entry.method === "repo.task.show" ? { taskId: "task-other" } : entry.payload;
      await expectFleetError(
        { repoId: "other-repo", method: entry.method, payload, accessToken: "reader-token" },
        "authorization_denied",
      );
    }

    // 3. Missing token -> authentication_required; revoked interactive session -> human_confirmation_required.
    await expectFleetError({ repoId, method: "repo.tasks.list", payload: {} }, "authentication_required");
    keycloak.interactiveSession("person-reader", nodeId, fixture.owners.url, "revoked-token", "web-bff");
    keycloak.endInteractiveSession("revoked-token");
    await expectFleetError(
      { repoId, method: "repo.tasks.list", payload: {}, accessToken: "revoked-token" },
      "human_confirmation_required",
    );

    // 4. Host-scoped observe.tail kinds (daemon-log, lifecycle) are rejected with execution_scope_mismatch.
    for (const kind of ["daemon-log", "lifecycle"] as const) {
      await expectFleetError(
        { repoId, method: "observe.tail", payload: { kind, direction: "history" }, accessToken: "reader-token" },
        "execution_scope_mismatch",
      );
    }

    // 5. Cross-member personal agenda read without access-manage is denied with authorization_denied.
    await expectFleetError(
      {
        repoId,
        method: "repo.agenda.read",
        payload: { scopePersonId: "person-owner" },
        accessToken: "reader-token",
      },
      "authorization_denied",
    );

    // 6. Write action smuggled into repo.task.read is rejected with unsupported_command.
    await expectFleetError(
      {
        repoId,
        method: "repo.task.read",
        payload: { action: { kind: "task-create", title: "Forbidden Write" } },
        accessToken: "reader-token",
      },
      "unsupported_command",
    );

    // 7. Invalid payloads / cursors are rejected with closed error codes (no unbounded scan).
    await expectFleetError(
      { repoId, method: "repo.tasks.list", payload: { limit: 999_999 }, accessToken: "reader-token" },
      "invalid_field",
    );
    await expectFleetError(
      {
        repoId,
        method: "observe.tail",
        payload: { kind: "events", direction: "follow", cursor: { kind: "events", revision: 999_999 } },
        accessToken: "reader-token",
      },
      "invalid_cursor",
    );
    await expectFleetError(
      {
        repoId,
        method: "repo.agentRuntime.events.read",
        payload: { runtimeSessionId: "runtime-missing", afterCursor: "lifecycle:999999" },
        accessToken: "reader-token",
      },
      "invalid_cursor",
    );
    await expectFleetError(
      {
        repoId,
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today" },
        accessToken: "reader-token",
      },
      "invalid_command",
    );

    assert.equal(fixture.eventCount(), eventsBefore, "denied and invalid reads append no canonical events");
    assert.deepEqual(fixture.transportErrors, [], "expected client/auth faults do not log unexpected transport errors");
  },
);
