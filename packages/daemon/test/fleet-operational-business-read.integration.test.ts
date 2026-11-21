// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runtimeDefinitionSnapshotArtifact } from "@harness-anything/kernel";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import { readAgentRuntimeTokenUsageDetail } from "../src/daemon-host/agent-runtime-token-usage.ts";
import {
  appendRuntimeWorkerRecord,
  dispatchStreamPath,
  openDispatchStream,
} from "../src/daemon-host/dispatch-stream.ts";
import { listenFleetTls } from "../src/daemon-host/fleet/center.ts";
import { resolveFleetCursorSecret } from "../src/daemon-host/fleet-center-config.ts";
import { FLEET_FRAME_BYTES } from "../src/daemon-host/fleet/command-protocol.ts";
import { FleetRemoteError, openPeer, readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import { requestFleetReplicaToken } from "../src/daemon-host/fleet/replica-token.ts";
import { createResourceBudget, DOC_SHOW_BUDGET_LIMITS } from "../src/daemon-host/fleet/resource-budget.ts";
import { modelPriceOf, usageCostUsd } from "../src/runtime-engine/agent-runtime-model-pricing.ts";
import {
  parseDaemonActionResult,
  parseDaemonReadResult,
} from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { runtimeDispatchIdentity } from "../src/daemon-host/task-dispatch-recovery.ts";
import { definition, installation } from "./fixtures/runtime-ingress.ts";
import { lifecycleReadForSync } from "./dispatch-lifecycle-read.fixtures.ts";
import { fleetFixture, git, initRepo, localAuthFixture, waitForReceiptCommit } from "./fleet-tls-session.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

const ALL_BUSINESS_READS = [
  { method: "repo.tasks.list", payload: { limit: 10 } },
  { method: "repo.task.show", payload: { taskId: "task-fleet" } },
  { method: "repo.task.read", payload: { action: { kind: "task-show", taskId: "task-fleet" } } },
  { method: "observe.tail", payload: { kind: "events", direction: "history" } },
  { method: "repo.events.read", payload: { afterRevision: 0, limit: 1 } },
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

    // 1. User with no grant on fleet-repo is 100% denied across all declared business read methods.
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

test(
  "fleet.operational.read/v1 admits registered node service-account tokens, enforces repo/agenda boundaries, counts edge-settled token usage, and rejects local-only diagnostics",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId, taskId, executionId } = fixture.subject,
      keycloak = fixture.owners.keycloak;

    // Seed an Edge-executed settled dispatch whose stream file lives ONLY under a separate edge rootDir (F2).
    const edgeRoot = path.join(fixture.root, "edge-node-root");
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: edge\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const pricedDefinition = { ...definition, model: "claude-haiku-4-5" } as const,
      artifact = runtimeDefinitionSnapshotArtifact(pricedDefinition),
      edgeReported = runtimeDispatchIdentity(repoId, "edge-settled-reported"),
      edgeTaskless = runtimeDispatchIdentity(repoId, "edge-settled-taskless"),
      edgeUnreportedCache = runtimeDispatchIdentity(repoId, "edge-settled-unreported-cache"),
      edgeUnavailable = runtimeDispatchIdentity(repoId, "edge-settled-unavailable"),
      startedAt = new Date(Date.now() - 120_000).toISOString(),
      endedAt = new Date(Date.now() - 30_000).toISOString();

    for (const [identity, label, taskBound, metricsPayload, rawUsage] of [
      [
        edgeReported,
        "edge-settled-reported",
        true,
        {
          inputTokens: 10_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 4_000,
          outputTokens: 1_000,
          totalTokens: 11_000,
          toolCallCount: 7,
          usageUnavailable: false,
        },
        { input_tokens: 10_000, cache_creation_input_tokens: 4_000, output_tokens: 1_000 },
      ],
      [
        edgeTaskless,
        "edge-settled-taskless",
        false,
        {
          inputTokens: 3_000,
          cacheReadTokens: 500,
          cacheWriteTokens: 1_500,
          outputTokens: 400,
          totalTokens: 3_400,
          toolCallCount: 3,
          usageUnavailable: false,
        },
        { input_tokens: 3_000, cache_creation_input_tokens: 1_500, output_tokens: 400 },
      ],
      [
        edgeUnreportedCache,
        "edge-settled-unreported-cache",
        true,
        {
          inputTokens: 2_000,
          cacheReadTokens: 0,
          outputTokens: 500,
          totalTokens: 2_500,
          toolCallCount: 1,
          usageUnavailable: false,
        },
        { input_tokens: 2_000, output_tokens: 500 },
      ],
      [
        edgeUnavailable,
        "edge-settled-unavailable",
        true,
        {
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolCallCount: 2,
          usageUnavailable: true,
        },
        {},
      ],
    ] as const) {
      openDispatchStream(edgeRoot, {
        dispatchId: identity.dispatchId,
        runtimeSessionId: identity.runtimeSessionId,
        instanceId: pricedDefinition.instanceId,
        kindId: pricedDefinition.kindId,
        taskId: taskBound ? taskId : null,
        executionId: taskBound ? executionId : null,
        agentId: "agent-edge",
        agentName: "Agent Edge",
        model: pricedDefinition.model,
        startedAt,
      });
      appendRuntimeWorkerRecord(edgeRoot, identity.dispatchId, {
        kind: "runtime_metrics",
        ...metricsPayload,
        compacted: false,
        raw: rawUsage,
      });
      assert.equal(
        existsSync(dispatchStreamPath(fixture.repo, identity.dispatchId)),
        false,
        "center root must NOT have a local dispatch stream file for the edge-executed dispatch",
      );
      const req = await fixture.host.runtimeIngress(
        repoId,
        {
          kind: "event",
          type: "runtime_dispatch_requested",
          opId: `op-req-${label}`,
          payload: {
            ...identity,
            ...(taskBound ? { taskId, executionId } : {}),
            agentId: "agent-edge",
            agentName: "Agent Edge",
            startedAt,
            instanceId: pricedDefinition.instanceId,
            installationId: installation.installationId,
            kindId: pricedDefinition.kindId,
            dispatchKey: label,
            definitionSnapshot: pricedDefinition,
            definitionSnapshotRef: artifact.ref,
          },
          resultBody: artifact.body,
          dispatchContext: {
            role: taskBound ? "implementation" : null,
            taskId: taskBound ? taskId : null,
            executionId: taskBound ? executionId : null,
            launchGeneration: 1,
          },
        },
        localAuthFixture(),
      );
      assert.equal(req.outcome, "applied", JSON.stringify(req));
      const exited = await fixture.host.runtimeIngress(
        repoId,
        {
          kind: "event",
          type: "runtime_session_exited",
          opId: `op-exit-${label}`,
          payload: { runtimeSessionId: identity.runtimeSessionId },
        },
        localAuthFixture(),
      );
      assert.equal(exited.outcome, "applied", JSON.stringify(exited));
      const resultBody = `edge settlement result for ${label}\n`,
        resultSha = createHash("sha256").update(resultBody).digest("hex"),
        canonicalMetrics = {
          inputTokens: metricsPayload.inputTokens,
          cacheReadTokens: metricsPayload.cacheReadTokens,
          outputTokens: metricsPayload.outputTokens,
          totalTokens: metricsPayload.totalTokens,
          toolCallCount: metricsPayload.toolCallCount,
          usageUnavailable: metricsPayload.usageUnavailable,
        };
      const settled = await fixture.host.runtimeIngress(
        repoId,
        {
          kind: "event",
          type: "runtime_session_outcome_observed",
          opId: `op-outcome-${label}`,
          payload: {
            runtimeSessionId: identity.runtimeSessionId,
            dispatchId: identity.dispatchId,
            outcome: "succeeded",
            exitCode: 0,
            resultRef: `artifact:runtime-result/sha256/${resultSha}`,
            result: { sha256: resultSha, size: Buffer.byteLength(resultBody), mediaType: "text/plain; charset=utf-8" },
            endedAt,
            runtimeMetrics: canonicalMetrics,
            ...("cacheWriteTokens" in metricsPayload ? { cacheWriteTokens: metricsPayload.cacheWriteTokens } : {}),
          },
          resultBody,
        },
        localAuthFixture(),
      );
      assert.equal(settled.outcome, "applied", JSON.stringify(settled));
    }

    // F15: Submit a poisoned regular doc-submit JSON document at artifacts/dispatches/<dispatchId>.json
    // and verify below that canonical metrics are never overwritten by ordinary projected documents.
    const poisonedArchiveRelPath = `${fixture.packagePath}/artifacts/dispatches/${edgeReported.dispatchId}.json`,
      poisonedArchiveDiskPath = path.join(fixture.repo, "harness", poisonedArchiveRelPath);
    mkdirSync(path.dirname(poisonedArchiveDiskPath), { recursive: true });
    writeFileSync(
      poisonedArchiveDiskPath,
      `${JSON.stringify(
        {
          schema: "runtime-dispatch/v1",
          dispatchId: edgeReported.dispatchId,
          runtimeMetrics: {
            inputTokens: 999_999,
            cacheReadTokens: 888_888,
            cacheWriteTokens: 777_777,
            outputTokens: 666_666,
            totalTokens: 1_666_665,
            toolCallCount: 999,
            usageUnavailable: false,
          },
        },
        null,
        2,
      )}\n`,
    );
    const poisonedSubmitted = await fixture.host.run(
      repoId,
      { kind: "doc-submit", paths: [poisonedArchiveRelPath] },
      localAuthFixture(),
    );
    assert.equal(poisonedSubmitted.outcome, "applied", JSON.stringify(poisonedSubmitted));
    await waitForReceiptCommit(fixture.host, repoId, poisonedSubmitted.opId, fixture.auth);

    // Seed a center-local dispatch stream with sensitive provider thinking/tool bodies to verify F6:
    // local debugging still reads kind="dispatch", while Fleet TLS rejects it before host.read.
    const localTranscriptDispatchId = "dispatch_0123456789abcdef01234566";
    const localTranscriptStream = openDispatchStream(fixture.repo, {
      dispatchId: localTranscriptDispatchId,
      runtimeSessionId: "runtime-center-local-transcript",
      instanceId: pricedDefinition.instanceId,
      kindId: pricedDefinition.kindId,
      taskId,
      executionId,
      startedAt,
    });
    localTranscriptStream.appendProviderEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "center-only private reasoning" },
            { type: "tool_use", name: "Bash", input: { command: "secret-check" } },
          ],
        },
      },
      startedAt,
    );

    // Set up node-limited (owned by person-limited, granted repository-read on fleet-repo ONLY, not other-repo)
    // and node-unregistered (passes TLS auth, has no active owner in nodeOwner).
    keycloak.account("person-limited");
    keycloak.permit("person-limited", repoId, ["repository-read"]);
    keycloak.node("node-limited", "person-limited");

    let doctorHealthCenterCalls = 0;
    let runtimeLocalObserveReadCalls = 0;
    let detailHostReadCalls = 0;
    const center = await fixture.hold(
      listenFleetTls({
        host: {
          ...fixture.host,
          read: async (...args: Parameters<typeof fixture.host.read>) => {
            if (args[1] === "observe.tail" && (args[2] as { kind?: unknown })?.kind !== "events")
              runtimeLocalObserveReadCalls += 1;
            if (args[1] === "repo.agentRuntime.tokenUsageDetail") detailHostReadCalls += 1;
            return fixture.host.read(...args);
          },
          run: async (...args: Parameters<typeof fixture.host.run>) => {
            if (args[1].kind === "doctor-health") doctorHealthCenterCalls += 1;
            return fixture.host.run(...args);
          },
        },
        stateRoot: fixture.stateRoot,
        ...fixture.writerOptions,
        key: fixture.key,
        cert: fixture.cert,
        cursorSecret: resolveFleetCursorSecret(path.join(fixture.userRoot, "fleet")),
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot, { fetch: keycloak.fetch }).bind(auth),
        verifyReplica: (auth) => createIdentitySession(fixture.userRoot, { fetch: keycloak.fetch }).bindReplica!(auth),
        onError: (entry) => fixture.transportErrors.push(entry),
        authenticate: (node, secret) =>
          [nodeId, "node-limited", "node-unregistered"].includes(node) && secret === "machine-secret",
        nodeOwner: (node) => (node === "node-unregistered" ? null : fixture.owners.nodeOwner(node)),
      }),
    );

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

    const mintNodeToken = async (targetNodeId: string) =>
      requestFleetReplicaToken(
        {
          url: "https://keycloak.fixture",
          realm: "harness",
          nodeId: targetNodeId,
          credential: `secret-${targetNodeId}`,
          ca: fixture.cert.toString(),
        },
        keycloak.fetch,
      );

    const ownerNodeToken = await mintNodeToken(nodeId);
    const limitedNodeToken = await mintNodeToken("node-limited");

    // F1 positive: registered node service-account token succeeds across all declared business read methods on authorized repo.
    const limitedPeerOptions = {
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId: "node-limited",
      credential: "machine-secret",
      repoId,
      readAccessToken: async () => limitedNodeToken,
    };
    for (const entry of ALL_BUSINESS_READS) {
      const payload =
        entry.method === "repo.agentRuntime.tokenUsageDetail"
          ? { range: "today", agentId: "agent-edge" }
          : entry.payload;
      const response = await readFleetOperationalClient({
        ...limitedPeerOptions,
        method: entry.method,
        payload,
      });
      assert.equal(response.ok, true, `node token ${entry.method} must succeed: ${JSON.stringify(response)}`);
    }

    // F2 + F8 assertions over real Fleet TLS: center reports Edge-settled metrics including
    // cacheWriteTokens and differential cache-write pricing even with zero center-local stream files.
    const haikuPrice = modelPriceOf("claude-haiku-4-5")!;
    assert.ok(haikuPrice && haikuPrice.cacheWritePerMillion !== haikuPrice.inputPerMillion);
    const expectedReportedCost = usageCostUsd(haikuPrice, {
        inputTokens: 10_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 4_000,
        outputTokens: 1_000,
      }),
      expectedTasklessCost = usageCostUsd(haikuPrice, {
        inputTokens: 3_000,
        cacheReadTokens: 500,
        cacheWriteTokens: 1_500,
        outputTokens: 400,
      }),
      expectedUnreportedCost = usageCostUsd(haikuPrice, {
        inputTokens: 2_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 500,
      }),
      expectedTotalCost = expectedReportedCost + expectedTasklessCost + expectedUnreportedCost,
      wrongInputRateCost =
        usageCostUsd(haikuPrice, {
          inputTokens: 10_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 0,
          outputTokens: 1_000,
        }) +
        usageCostUsd(haikuPrice, {
          inputTokens: 3_000,
          cacheReadTokens: 500,
          cacheWriteTokens: 0,
          outputTokens: 400,
        }) +
        expectedUnreportedCost;
    assert.notEqual(expectedTotalCost, wrongInputRateCost);

    const usage = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsage",
      await readFleetOperationalClient({
        ...limitedPeerOptions,
        method: "repo.agentRuntime.tokenUsage",
        payload: { range: "today" },
      }),
    );
    assert.ok("totals" in usage);
    if ("totals" in usage) {
      assert.equal(usage.totals.totalTokens, 16_900);
      assert.equal(usage.totals.cacheWriteTokens, 5_500);
      assert.equal(usage.totals.cacheWriteUnreportedDispatches, 1);
      assert.equal(usage.totals.cacheWriteUnitemizedDispatches, 0);
      assert.equal(usage.totals.toolCallCount, 13);
      assert.equal(usage.totals.usageReportedDispatches, 3);
      assert.equal(usage.totals.usageUnavailableDispatches, 1);
      assert.ok(
        Math.abs(usage.totals.costUsd - expectedTotalCost) < 1e-12,
        `center costUsd=${usage.totals.costUsd} must match Edge differential cache-write pricing ${expectedTotalCost} (not ${wrongInputRateCost})`,
      );
      assert.equal(usage.agents.find((agent) => agent.agentId === "agent-edge")?.cacheWriteTokens, 5_500);
    }
    const detail = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        ...limitedPeerOptions,
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-edge" },
      }),
    );
    assert.equal(detail.totals.totalTokens, 16_900);
    assert.equal(detail.totals.cacheWriteTokens, 5_500);
    assert.equal(detail.totals.cacheWriteUnreportedDispatches, 1);
    assert.equal(detail.totals.cacheWriteUnitemizedDispatches, 0);
    assert.equal(detail.totals.usageReportedDispatches, 3);
    assert.equal(detail.totals.usageUnavailableDispatches, 1);
    assert.ok(Math.abs(detail.totals.costUsd - expectedTotalCost) < 1e-12);
    const reportedSession = detail.sessions.find((row) => row.dispatchId === edgeReported.dispatchId)!;
    const tasklessSession = detail.sessions.find((row) => row.dispatchId === edgeTaskless.dispatchId)!;
    const unreportedCacheSession = detail.sessions.find((row) => row.dispatchId === edgeUnreportedCache.dispatchId)!;
    const unavailableSession = detail.sessions.find((row) => row.dispatchId === edgeUnavailable.dispatchId)!;
    assert.equal(reportedSession.usage, "reported");
    assert.equal(reportedSession.totalTokens, 11_000);
    assert.equal(reportedSession.cacheWriteTokens, 4_000);
    assert.equal(reportedSession.toolCallCount, 7);
    assert.equal(reportedSession.endedAt, endedAt);
    assert.ok(reportedSession.durationMs !== null && reportedSession.durationMs > 0);
    assert.equal(tasklessSession.usage, "reported");
    assert.equal(tasklessSession.taskId, null, "F17: taskless Edge session has null taskId and no archive");
    assert.equal(
      tasklessSession.cacheWriteTokens,
      1_500,
      "F17: taskless Edge session retains cacheWriteTokens on Center",
    );
    assert.equal(unreportedCacheSession.usage, "reported");
    assert.equal(unreportedCacheSession.cacheWriteTokens, 0);
    assert.equal(unavailableSession.usage, "unavailable");
    assert.equal(unavailableSession.totalTokens, 0);
    assert.equal(unavailableSession.toolCallCount, 2);

    // F15: Overwrite artifacts/dispatches/<dispatchId>.json with invalid non-JSON text via doc-submit
    // and verify Center tokenUsage & tokenUsageDetail neither throw nor drift!
    writeFileSync(poisonedArchiveDiskPath, "{{{ corrupt non-json text submitted via doc-submit\n");
    const nonJsonSubmitted = await fixture.host.run(
      repoId,
      { kind: "doc-submit", paths: [poisonedArchiveRelPath] },
      localAuthFixture(),
    );
    assert.equal(nonJsonSubmitted.outcome, "applied", JSON.stringify(nonJsonSubmitted));
    await waitForReceiptCommit(fixture.host, repoId, nonJsonSubmitted.opId, fixture.auth);
    const detailAfterNonJson = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        ...limitedPeerOptions,
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-edge" },
      }),
    );
    assert.deepEqual(
      detailAfterNonJson.totals,
      detail.totals,
      "F15: non-JSON doc-submit must not throw or alter totals",
    );

    // F14: Remote forged or tampered cursors on Fleet TLS reject at center-listener BEFORE host.read!
    const callsBeforeInvalidCursor = detailHostReadCalls;
    for (const badCursor of ["v2.forged-unauthenticated-cursor", "f3.invalid_hmac_signature.v3.abc.def"]) {
      await assert.rejects(
        readFleetOperationalClient({
          ...limitedPeerOptions,
          method: "repo.agentRuntime.tokenUsageDetail",
          payload: { range: "today", agentId: "agent-edge", limit: 2, cursor: badCursor },
        }),
        (error: unknown) => error instanceof FleetRemoteError && error.code === "invalid_cursor",
      );
    }
    assert.equal(detailHostReadCalls, callsBeforeInvalidCursor, "F14: forged Fleet cursors must fail before host.read");

    // F6: local observe.tail(kind="dispatch") keeps working for local debugging, while Fleet TLS
    // rejects dispatch and all other runtime-local kinds with execution_scope_mismatch before host.read.
    const localTranscript = parseDaemonReadResult(
      "observe.tail",
      await fixture.host.read(
        repoId,
        "observe.tail",
        { kind: "dispatch", direction: "history", dispatchId: localTranscriptDispatchId },
        localAuthFixture(),
      ),
    );
    assert.equal(localTranscript.status, "ready");
    assert.equal(localTranscript.items.length, 1);
    for (const payload of [
      { kind: "dispatch", direction: "history", dispatchId: localTranscriptDispatchId },
      { kind: "repo-log", direction: "history" },
      { kind: "daemon-log", direction: "history" },
      { kind: "lifecycle", direction: "history" },
    ] as const) {
      await assert.rejects(
        readFleetOperationalClient({
          ...limitedPeerOptions,
          method: "observe.tail",
          payload,
        }),
        (error: unknown) => error instanceof FleetRemoteError && error.code === "execution_scope_mismatch",
      );
    }
    assert.equal(
      runtimeLocalObserveReadCalls,
      0,
      "Fleet observe.tail must reject runtime-local kinds before entering host.read or local file I/O",
    );

    // F1 negative 1: node service-account token on unauthorized repository (`other-repo`) is 100% denied.
    for (const entry of ALL_BUSINESS_READS) {
      await assert.rejects(
        readFleetOperationalClient({
          ...limitedPeerOptions,
          repoId: "other-repo",
          method: entry.method,
          payload: entry.payload,
        }),
        (error: unknown) => {
          assert.ok(error instanceof FleetRemoteError, String(error));
          assert.equal(error.code, "authorization_denied", `${entry.method} on other-repo: ${error.code}`);
          return true;
        },
      );
    }

    // F1 negative 2: even an admin-owned node service-account token cannot cross-member read another person's agenda.
    const ownAgenda = await readFleetOperationalClient({
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
      repoId,
      readAccessToken: async () => ownerNodeToken,
      method: "repo.agenda.read",
      payload: { scopePersonId: "person-owner" },
    });
    assert.equal(ownAgenda.ok, true);
    await assert.rejects(
      readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => ownerNodeToken,
        method: "repo.agenda.read",
        payload: { scopePersonId: "person-limited" },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "authorization_denied",
    );

    // F1 negative 3: mismatched node service-account token (node-limited's token on node-one) is rejected cleanly.
    await assert.rejects(
      readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => limitedNodeToken,
        method: "repo.tasks.list",
        payload: { limit: 10 },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "fleet_replica_credential_rejected",
    );

    // F1 negative 4: unregistered node is rejected with node_owner_unregistered.
    await assert.rejects(
      readFleetOperationalClient({
        port: center.port,
        ca: fixture.cert,
        servername: "localhost",
        nodeId: "node-unregistered",
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => limitedNodeToken,
        method: "repo.tasks.list",
        payload: { limit: 10 },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "node_owner_unregistered",
    );

    // F4: local doctor-health remains available, while Fleet repo.task.read rejects doctor-health & ledger-reconcile
    // deterministically before entering host.run.
    const localDoctor = await fixture.host.run(repoId, { kind: "doctor-health" }, localAuthFixture());
    assert.equal(localDoctor.outcome, "applied", JSON.stringify(localDoctor));
    for (const action of [{ kind: "doctor-health" }, { kind: "ledger-reconcile" }] as const) {
      await assert.rejects(
        readFleetOperationalClient({
          ...limitedPeerOptions,
          method: "repo.task.read",
          payload: { action },
        }),
        (error: unknown) => error instanceof FleetRemoteError && error.code === "unsupported_command",
      );
    }
    assert.equal(doctorHealthCenterCalls, 0, "Fleet repo.task.read must never enter host.run for doctor-health");
    assert.deepEqual(fixture.transportErrors, [], "node token & diagnostic rejections must not log transport errors");
  },
);

test(
  "fleet.operational.read/v1 paginates large repo.agentRuntime.tokenUsageDetail sets across Fleet transfer memory budgets (F9)",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId } = fixture.subject,
      keycloak = fixture.owners.keycloak;
    keycloak.account("person-reader");
    keycloak.permit("person-reader", repoId, ["repository-read"]);
    keycloak.interactiveSession("person-reader", nodeId, fixture.owners.url, "reader-token", "web-bff");

    // Construct 360 deterministic dispatches (~130 KiB unpaginated JSON > 96 KiB frame ceiling and > 100 KiB
    // configured session memory budget) served through the real readAgentRuntimeTokenUsageDetail reader.
    const nowIso = "2026-11-21T12:00:00.000Z",
      baseMs = Date.parse("2026-11-21T01:00:00.000Z"),
      totalRows = 360,
      bulkRows = Array.from({ length: totalRows }, (_, index) => {
        const startedAt = new Date(baseMs + index * 10_000).toISOString(),
          endedAt = new Date(baseMs + index * 10_000 + 5_000).toISOString(),
          dispatchId = `dispatch_${String(index + 1).padStart(24, "0")}`,
          runtimeSessionId = `runtime-bulk-${String(index + 1).padStart(4, "0")}`;
        return {
          event: {
            schema: "agent-runtime-event/v1" as const,
            eventId: `ev-bulk-${index}`,
            workspaceRevision: index + 1,
            opId: `op-bulk-${index}`,
            actor: { principal: { personId: "person-owner" }, executor: null },
            source: "local" as const,
            occurredAt: startedAt,
            type: "runtime_dispatch_requested" as const,
            payload: {
              dispatchId,
              runtimeSessionId,
              instanceId: definition.instanceId,
              installationId: installation.installationId,
              kindId: definition.kindId,
              dispatchKey: dispatchId,
              definitionSnapshotRef: "artifact:runtime-definition/bulk",
              startedAt,
              taskId: `task-bulk-${index % 10}`,
              executionId: "exe-bulk-1",
              agentId: "agent-bulk",
              agentName: "Agent Bulk",
              definitionSnapshot: { ...definition, model: "claude-haiku-4-5" },
            },
          },
          metrics: {
            inputTokens: 1_000 + index,
            cacheReadTokens: 100,
            cacheWriteTokens: 200,
            outputTokens: 300,
            totalTokens: 1_300 + index,
            toolCallCount: 2,
            usageUnavailable: false,
          },
          endedAt,
          outcome: "succeeded" as const,
        };
      });
    const bulkProjection = {
      readRuntimeDispatchPage: (query: {
        readonly agentId?: string;
        readonly squadId?: string;
        readonly startedAtGte: string;
        readonly startedAtLte?: string;
        readonly order?: "asc" | "desc";
        readonly maxRevision?: number;
        readonly cursor?: { readonly startedAt: string; readonly dispatchId: string };
        readonly limit: number;
      }) => {
        const order = query.order ?? "asc",
          minMs = query.startedAtGte === "" ? -Infinity : Date.parse(query.startedAtGte),
          maxMs = query.startedAtLte === undefined ? Infinity : Date.parse(query.startedAtLte),
          cursorMs = query.cursor ? Date.parse(query.cursor.startedAt) : order === "asc" ? -Infinity : Infinity,
          ordered = bulkRows
            .filter((row) => {
              const payload = row.event.payload,
                startedMs = Date.parse(payload.startedAt!);
              if (query.agentId !== undefined && payload.agentId !== query.agentId) return false;
              if (query.squadId !== undefined && payload.squadId !== query.squadId) return false;
              if (query.maxRevision !== undefined && row.event.workspaceRevision > query.maxRevision) return false;
              if (startedMs < minMs || startedMs > maxMs) return false;
              if (query.cursor) {
                const cmpId = Buffer.compare(Buffer.from(payload.dispatchId), Buffer.from(query.cursor.dispatchId));
                if (order === "asc") {
                  if (startedMs < cursorMs || (startedMs === cursorMs && cmpId <= 0)) return false;
                } else if (startedMs > cursorMs || (startedMs === cursorMs && cmpId <= 0)) return false;
              }
              return true;
            })
            .sort((left, right) => {
              const leftMs = Date.parse(left.event.payload.startedAt!),
                rightMs = Date.parse(right.event.payload.startedAt!),
                time = order === "asc" ? leftMs - rightMs : rightMs - leftMs;
              return (
                time ||
                Buffer.compare(Buffer.from(left.event.payload.dispatchId), Buffer.from(right.event.payload.dispatchId))
              );
            }),
          slice = ordered.slice(0, query.limit),
          done = ordered.length <= query.limit,
          last = slice.at(-1)?.event.payload;
        return {
          rows: slice,
          done,
          nextCursor: !done && last ? { startedAt: last.startedAt!, dispatchId: last.dispatchId } : null,
        };
      },
      readDispatchLifecycle: lifecycleReadForSync(
        bulkRows.map((row) => ({
          dispatchId: row.event.payload.dispatchId,
          runtimeSessionId: row.event.payload.runtimeSessionId,
          attemptSettled: true,
          process: "exited" as const,
          outcome: "succeeded" as const,
        })),
      ),
    };

    const tightMemoryBytes = 100 * 1024;
    const unpaginatedPreview = readAgentRuntimeTokenUsageDetail({
      rootDir: fixture.repo,
      now: nowIso,
      range: "today",
      member: { kind: "agent", agentId: "agent-bulk" },
      entityLabel: () => null,
      cut: { status: "ready", watermark: totalRows, sourceRevision: totalRows },
      projection: bulkProjection as never,
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(unpaginatedPreview)) > tightMemoryBytes,
      "unpaginated 360-session payload must exceed the configured Fleet session transfer memory ceiling",
    );

    const tightBudget = createResourceBudget({
      ...DOC_SHOW_BUDGET_LIMITS,
      session: { bulkTransfers: 2, memoryBytes: tightMemoryBytes },
      node: { bulkTransfers: 4, memoryBytes: tightMemoryBytes },
      repository: { bulkTransfers: 4, memoryBytes: tightMemoryBytes },
      global: { bulkTransfers: 8, memoryBytes: tightMemoryBytes },
    });

    const bulkCursorSecret = "test-fleet-bulk-cursor-secret-32";
    const center = await fixture.hold(
      listenFleetTls({
        host: {
          ...fixture.host,
          read: async (targetRepoId, method, payload, binding) => {
            if (method === "repo.agentRuntime.tokenUsageDetail" && payload.agentId === "agent-bulk") {
              return readAgentRuntimeTokenUsageDetail({
                rootDir: fixture.repo,
                now: nowIso,
                range: (payload.range as "today" | "7d" | "30d" | undefined) ?? "today",
                member: { kind: "agent", agentId: "agent-bulk" },
                ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
                ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
                cursorSecret: bulkCursorSecret,
                entityLabel: () => null,
                cut: { status: "ready", watermark: totalRows, sourceRevision: totalRows },
                projection: bulkProjection as never,
              }) as never;
            }
            return fixture.host.read(targetRepoId, method, payload, binding);
          },
        },
        commandResourceBudget: tightBudget,
        stateRoot: fixture.stateRoot,
        ...fixture.writerOptions,
        key: fixture.key,
        cert: fixture.cert,
        cursorSecret: bulkCursorSecret,
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot, { fetch: keycloak.fetch }).bind(auth),
        verifyReplica: (auth) => createIdentitySession(fixture.userRoot, { fetch: keycloak.fetch }).bindReplica!(auth),
        onError: (entry) => fixture.transportErrors.push(entry),
        authenticate: (node, secret) => node === nodeId && secret === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
      }),
    );

    const peerOptions = {
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
      repoId,
      readAccessToken: async () => "reader-token",
    };

    // Unpaginated read exceeds the session transfer memory limit and fails with resource_exhausted.
    await assert.rejects(
      readFleetOperationalClient({
        ...peerOptions,
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-bulk" },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "resource_exhausted",
    );

    // Bounded pagination with limit=60 + cursor drains all 360 sessions cleanly under the same transfer limit.
    const seenIds = new Set<string>(),
      allSessions: (typeof unpaginatedPreview.sessions)[number][] = [];
    let cursor: string | undefined,
      firstTotals: typeof unpaginatedPreview.totals | null = null,
      pageCount = 0;
    for (;;) {
      const page = parseDaemonReadResult(
        "repo.agentRuntime.tokenUsageDetail",
        await readFleetOperationalClient({
          ...peerOptions,
          method: "repo.agentRuntime.tokenUsageDetail",
          payload: {
            range: "today",
            agentId: "agent-bulk",
            limit: 60,
            ...(cursor ? { cursor } : {}),
          },
        }),
      );
      pageCount += 1;
      assert.equal(page.page?.limit, 60);
      assert.equal(page.page?.cursor, cursor ?? null);
      if (firstTotals === null) firstTotals = page.totals;
      else assert.deepEqual(page.totals, firstTotals, "window totals must stay identical across pages");
      for (const row of page.sessions) {
        assert.equal(seenIds.has(row.dispatchId), false, `duplicate dispatchId ${row.dispatchId}`);
        seenIds.add(row.dispatchId);
        allSessions.push(row);
      }
      if (!page.page?.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    assert.equal(pageCount, 6);
    assert.equal(allSessions.length, totalRows);
    assert.deepEqual(
      allSessions.map((row) => row.dispatchId),
      unpaginatedPreview.sessions.map((row) => row.dispatchId),
    );
    assert.equal(
      allSessions.reduce((acc, row) => acc + row.totalTokens, 0),
      firstTotals!.totalTokens,
    );
    assert.equal(
      allSessions.reduce((acc, row) => acc + row.cacheWriteTokens, 0),
      firstTotals!.cacheWriteTokens,
    );
    assert.equal(
      allSessions.reduce((acc, row) => acc + row.toolCallCount, 0),
      firstTotals!.toolCallCount,
    );
    assert.deepEqual(fixture.transportErrors, []);
  },
);
