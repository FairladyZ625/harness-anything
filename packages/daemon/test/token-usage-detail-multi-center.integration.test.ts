// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import test from "node:test";
import { taskLifecycleWritePlan, type AgentRuntimeEventV1, type TaskEventV1 } from "@harness-anything/kernel";
import { canonicalEventWritePlan, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { createIdentitySession } from "../src/daemon-host/authorization-provider.ts";
import {
  agentRuntimeTokenUsageReadHandlers,
  readAgentRuntimeTokenUsageDetail,
} from "../src/daemon-host/agent-runtime-token-usage.ts";
import { FLEET_CURSOR_SECRET_ENV, FLEET_CURSOR_SECRET_FILENAME } from "../src/daemon-host/fleet-center-config.ts";
import { prepareFleetCenterAdmission, startFleetCenterAdmission } from "../src/daemon-host/fleet-center-admission.ts";
import { listenFleetTls } from "../src/daemon-host/fleet/center.ts";
import { FleetRemoteError, readFleetOperationalClient } from "../src/daemon-host/fleet/peer.ts";
import { parseDaemonReadResult } from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { installModelPricingCatalog, modelPricingVersion } from "../src/runtime-engine/agent-runtime-model-pricing.ts";
import builtinPricingCatalog from "../src/runtime-engine/model-pricing-catalog.json" with { type: "json" };
import { fleetFixture } from "./fleet-tls-session.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const DEFINITION_SNAPSHOT = {
  schema: "agent-definition-snapshot/v1" as const,
  configVersion: 1,
  instanceId: "inst-rework",
  installationId: "install-rework",
  kindId: "claude-code",
  providerId: "anthropic",
  model: "claude-haiku-4-5",
  reasoningEffort: null,
  endpointKind: "official" as const,
  baseUrlHash: null,
  authMode: "subscription" as const,
};

function generateTlsCert(
  dir: string,
  label: string,
): { readonly key: Buffer; readonly cert: Buffer; readonly keyPath: string; readonly certPath: string } {
  const keyFile = path.join(dir, `${label}.key`),
    certFile = path.join(dir, `${label}.crt`);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyFile), cert: readFileSync(certFile), keyPath: keyFile, certPath: certFile };
}

function makeSqliteRepo(prefix: string, repoId: string) {
  const rootDir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  const store = makeTaskEventStore({ rootDir, repoId }),
    projection = makeTaskProjection({ rootDir, eventStore: store });
  let rev = 0;
  return {
    rootDir,
    store,
    projection,
    nextRevision: () => {
      rev += 1;
      return rev;
    },
  };
}

function appendRuntimeEvent(
  repo: ReturnType<typeof makeSqliteRepo>,
  event: AgentRuntimeEventV1,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[] = [],
): void {
  const plan = canonicalEventWritePlan(event, "agent-runtime/v1", event.opId);
  repo.store.append({ event, plan, blobs });
  repo.projection.apply(event, plan);
}

test(
  "F18 + F13: two real TLS Center listeners with distinct rootDirs, stateRoots, and TLS keys continue cursors seamlessly, reject wrong secret, and invalidate on pricing refresh",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId } = fixture.subject;
    const nowIso = "2026-11-21T15:00:00.000Z";

    // Build one canonical projection shared by TWO independent Center mounts with distinct rootDirs!
    const canonicalRepo = makeSqliteRepo("ha-f18-canonical-", repoId),
      mountRootA = mkdtempSync(path.join(tmpdir(), "ha-f18-mount-a-")),
      mountRootB = mkdtempSync(path.join(tmpdir(), "ha-f18-mount-b-")),
      stateRootA = mkdtempSync(path.join(tmpdir(), "ha-f18-state-a-")),
      stateRootB = mkdtempSync(path.join(tmpdir(), "ha-f18-state-b-")),
      stateRootWrong = mkdtempSync(path.join(tmpdir(), "ha-f18-state-wrong-")),
      tlsA = generateTlsCert(stateRootA, "center-a"),
      tlsB = generateTlsCert(stateRootB, "center-b"),
      tlsWrong = generateTlsCert(stateRootWrong, "center-wrong");
    assert.notEqual(mountRootA, mountRootB);
    assert.equal(tlsA.key.equals(tlsB.key), false, "Center A and Center B must use distinct TLS private keys");

    t.after(() => {
      installModelPricingCatalog(builtinPricingCatalog);
      canonicalRepo.projection.close();
      for (const dir of [canonicalRepo.rootDir, mountRootA, mountRootB, stateRootA, stateRootB, stateRootWrong]) {
        removeTempRepository(dir);
      }
    });

    for (let i = 1; i <= 5; i += 1) {
      const dispatchId = `dispatch_${String(i).padStart(24, "0")}`,
        sessionId = `sess-f18-${i}`,
        startedAt = `2026-11-21T10:0${i}:00.000Z`,
        endedAt = `2026-11-21T10:0${i}:30.000Z`,
        resultBody = `f18-result-${i}\n`,
        resultSha = createHash("sha256").update(resultBody).digest("hex");
      appendRuntimeEvent(canonicalRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: `ev-d-${i}`,
        opId: `op-d-${i}`,
        workspaceRevision: canonicalRepo.nextRevision(),
        occurredAt: startedAt,
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          dispatchId,
          runtimeSessionId: sessionId,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          dispatchKey: `key-${dispatchId}`,
          agentId: "agent-multi",
          agentName: "Multi Center Agent",
          startedAt,
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          definitionSnapshot: DEFINITION_SNAPSHOT,
        },
      });
      appendRuntimeEvent(
        canonicalRepo,
        {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_outcome_observed",
          eventId: `ev-o-${i}`,
          opId: `op-o-${i}`,
          workspaceRevision: canonicalRepo.nextRevision(),
          occurredAt: endedAt,
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            runtimeSessionId: sessionId,
            dispatchId,
            outcome: "succeeded",
            endedAt,
            exitCode: 0,
            resultRef: `artifact:runtime-result/sha256/${resultSha}`,
            result: { sha256: resultSha, size: Buffer.byteLength(resultBody), mediaType: "text/plain; charset=utf-8" },
            runtimeMetrics: {
              inputTokens: 1000 * i,
              cacheReadTokens: 100,
              outputTokens: 200,
              totalTokens: 1000 * i + 200,
              toolCallCount: i,
              usageUnavailable: false,
            },
            cacheWriteTokens: 50 * i,
          },
        },
        [
          {
            sha256: resultSha,
            size: Buffer.byteLength(resultBody),
            mediaType: "text/plain; charset=utf-8",
            body: resultBody,
          },
        ],
      );
    }

    const sharedSecret = "bff-cluster-cursor-secret-v1";
    const makeCenterHost = (mountRoot: string, cursorSecret: string, onDetailRead?: () => void) => {
      const handlers = agentRuntimeTokenUsageReadHandlers({
        rootDir: mountRoot,
        input: { repoId },
        cursorSecret,
        now: () => nowIso,
        projection: canonicalRepo.projection,
        cellCodedError: (code, text) => Object.assign(new Error(text), { code }),
      });
      return {
        ...fixture.host,
        read: async (
          targetRepoId: string,
          method: string,
          payload: Readonly<Record<string, unknown>>,
          binding?: unknown,
        ) => {
          if (method === "repo.agentRuntime.tokenUsageDetail" && targetRepoId === repoId) {
            onDetailRead?.();
            return handlers["repo.agentRuntime.tokenUsageDetail"](payload, binding as never) as never;
          }
          return fixture.host.read(targetRepoId, method as never, payload, binding as never);
        },
      };
    };

    fixture.owners.keycloak.account("person-reader");
    fixture.owners.keycloak.permit("person-reader", repoId, ["repository-read"]);
    fixture.owners.keycloak.interactiveSession("person-reader", nodeId, fixture.owners.url, "reader-token", "web-bff");
    let wrongCenterDetailCalls = 0;

    // Spin up TWO independent Centers (different rootDir, different stateRoot, different TLS key/cert)
    // sharing the same cluster cursorSecret, plus a third Center with a different cursorSecret!
    const centerA = await fixture.hold(
      listenFleetTls({
        host: makeCenterHost(mountRootA, sharedSecret),
        stateRoot: stateRootA,
        ...fixture.writerOptions,
        key: tlsA.key,
        cert: tlsA.cert,
        cursorSecret: sharedSecret,
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot).bind(auth),
        authenticate: (node, secret) => node === nodeId && secret === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
      }),
    );
    const centerB = await fixture.hold(
      listenFleetTls({
        host: makeCenterHost(mountRootB, sharedSecret),
        stateRoot: stateRootB,
        ...fixture.writerOptions,
        key: tlsB.key,
        cert: tlsB.cert,
        cursorSecret: sharedSecret,
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot).bind(auth),
        authenticate: (node, secret) => node === nodeId && secret === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
      }),
    );
    const centerWrongSecret = await fixture.hold(
      listenFleetTls({
        host: makeCenterHost(mountRootB, "different-cluster-secret", () => {
          wrongCenterDetailCalls += 1;
        }),
        stateRoot: stateRootWrong,
        ...fixture.writerOptions,
        key: tlsWrong.key,
        cert: tlsWrong.cert,
        cursorSecret: "different-cluster-secret",
        verifyHuman: (auth) => createIdentitySession(fixture.userRoot).bind(auth),
        authenticate: (node, secret) => node === nodeId && secret === "machine-secret",
        nodeOwner: fixture.owners.nodeOwner,
      }),
    );

    const peerFor = (port: number, ca: Buffer) => ({
      port,
      ca,
      servername: "localhost",
      nodeId,
      credential: "machine-secret",
      repoId,
      readAccessToken: async () => "reader-token",
    });

    // Page 1 from Center A -> Page 2 from Center B -> Page 3 back on Center A!
    const page1 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        ...peerFor(centerA.port, tlsA.cert),
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-multi", limit: 2 },
      }),
    );
    assert.equal(page1.sessions.length, 2);
    assert.ok(page1.page?.nextCursor);

    const page2 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        ...peerFor(centerB.port, tlsB.cert),
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-multi", limit: 2, cursor: page1.page!.nextCursor! },
      }),
    );
    assert.equal(page2.sessions.length, 2);
    assert.deepEqual(page2.totals, page1.totals);
    assert.deepEqual(page2.buckets, page1.buckets);
    assert.equal(page2.pricing.version, page1.pricing.version);
    assert.ok(page2.page?.nextCursor);

    const page3 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        ...peerFor(centerA.port, tlsA.cert),
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-multi", limit: 2, cursor: page2.page!.nextCursor! },
      }),
    );
    assert.equal(page3.sessions.length, 1);
    assert.equal(page3.page?.nextCursor, null);
    assert.deepEqual(
      [...page1.sessions, ...page2.sessions, ...page3.sessions].map((row) => row.dispatchId),
      [
        "dispatch_000000000000000000000005",
        "dispatch_000000000000000000000004",
        "dispatch_000000000000000000000003",
        "dispatch_000000000000000000000002",
        "dispatch_000000000000000000000001",
      ],
    );

    // Negative: wrong cursorSecret listener rejects Center A's cursor BEFORE entering host.read!
    await assert.rejects(
      readFleetOperationalClient({
        ...peerFor(centerWrongSecret.port, tlsWrong.cert),
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-multi", limit: 2, cursor: page1.page!.nextCursor! },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "invalid_cursor",
    );
    assert.equal(wrongCenterDetailCalls, 0, "F18: wrong secret must reject at Fleet listener before host.read");

    // F13 live pricing refresh: after catalog refreshes to a new version, continuing with Page 1's cursor fails cleanly!
    const refreshedCatalog = {
      ...builtinPricingCatalog,
      version: modelPricingVersion === "2026-11-29" ? "2026-11-30" : "2026-11-29",
    };
    installModelPricingCatalog(refreshedCatalog);
    await assert.rejects(
      readFleetOperationalClient({
        ...peerFor(centerB.port, tlsB.cert),
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-multi", limit: 2, cursor: page1.page!.nextCursor! },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "invalid_cursor",
    );
  },
);

test(
  "F11 + F13 real SQLite: bounded late-event continuation scan stays constant under 10x late events AND preserves delivered-stopped=succeeded vs post-watermark delivery isolation",
  { timeout: 30_000 },
  () => {
    const measureContinuation = (lateHeartbeatCount: number) => {
      const repo = makeSqliteRepo(`ha-f11-f13-${lateHeartbeatCount}-`, "repo-f11-f13");
      const nowIso = "2026-11-21T16:00:00.000Z";
      try {
        // Seed base task lifecycle fixture so execution_submitted & task_completed are valid canonical events.
        const fixtureEvents = lifecycleFixture().events;
        const created = fixtureEvents.find((e) => e.type === "task_created")! as TaskEventV1;
        const submittedTemplate = fixtureEvents.find((e) => e.type === "execution_submitted")! as TaskEventV1;
        const completedTemplate = fixtureEvents.find((e) => e.type === "task_completed")! as TaskEventV1;
        const taskId = created.taskId;
        const executionId = (submittedTemplate as unknown as { payload: { execution: { executionId: string } } })
          .payload.execution.executionId;

        const appendTask = (event: TaskEventV1) => {
          const plan = taskLifecycleWritePlan(event);
          repo.store.append({ event, plan, blobs: [] });
          repo.projection.apply(event, plan);
        };
        appendTask({ ...created, workspaceRevision: repo.nextRevision(), opId: "op-t-create", eventId: "ev-t-create" });

        // Older dispatch (delivered BEFORE pinnedWatermark, stopped outcome -> must display as "succeeded"!)
        const deliveredId = "dispatch_00000000000000000000bb01",
          deliveredSession = "sess-delivered-stopped",
          resultBody = "delivered\n",
          resultSha = createHash("sha256").update(resultBody).digest("hex");
        appendRuntimeEvent(repo, {
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          eventId: "ev-d-deliv",
          opId: "op-d-deliv",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T11:00:00.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            dispatchId: deliveredId,
            runtimeSessionId: deliveredSession,
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            installationId: DEFINITION_SNAPSHOT.installationId,
            kindId: DEFINITION_SNAPSHOT.kindId,
            dispatchKey: `key-${deliveredId}`,
            agentId: "agent-f11",
            agentName: "F11 Agent",
            taskId,
            executionId,
            startedAt: "2026-11-21T11:00:00.000Z",
            definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
            definitionSnapshot: DEFINITION_SNAPSHOT,
          },
        });
        appendRuntimeEvent(repo, {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_started",
          eventId: "ev-s-deliv",
          opId: "op-s-deliv",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T11:00:01.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            runtimeSessionId: deliveredSession,
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            installationId: DEFINITION_SNAPSHOT.installationId,
            kindId: DEFINITION_SNAPSHOT.kindId,
            definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
            launchGeneration: 1,
            attachable: false,
            taskBinding: { taskId, executionId },
          },
        });
        appendTask({
          ...submittedTemplate,
          workspaceRevision: repo.nextRevision(),
          opId: "op-t-sub",
          eventId: "ev-t-sub",
          occurredAt: "2026-11-21T11:00:02.000Z",
        });
        appendRuntimeEvent(
          repo,
          {
            schema: "agent-runtime-event/v1",
            type: "runtime_session_outcome_observed",
            eventId: "ev-o-deliv",
            opId: "op-o-deliv",
            workspaceRevision: repo.nextRevision(),
            occurredAt: "2026-11-21T11:00:03.000Z",
            actor: { principal: { personId: "person-a" }, executor: null },
            source: "local",
            payload: {
              runtimeSessionId: deliveredSession,
              dispatchId: deliveredId,
              outcome: "stopped",
              endedAt: "2026-11-21T11:00:03.000Z",
              exitCode: 0,
              resultRef: `artifact:runtime-result/sha256/${resultSha}`,
              result: {
                sha256: resultSha,
                size: Buffer.byteLength(resultBody),
                mediaType: "text/plain; charset=utf-8",
              },
              runtimeMetrics: {
                inputTokens: 800,
                cacheReadTokens: 100,
                outputTokens: 200,
                totalTokens: 1000,
                toolCallCount: 2,
                usageUnavailable: false,
              },
              cacheWriteTokens: 50,
            },
          },
          [
            {
              sha256: resultSha,
              size: Buffer.byteLength(resultBody),
              mediaType: "text/plain; charset=utf-8",
              body: resultBody,
            },
          ],
        );

        // Newer dispatch (appears on Page 1 with limit=1)
        const newestId = "dispatch_00000000000000000000bb02",
          newestSession = "sess-newest";
        appendRuntimeEvent(repo, {
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          eventId: "ev-d-new",
          opId: "op-d-new",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T12:00:00.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            dispatchId: newestId,
            runtimeSessionId: newestSession,
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            installationId: DEFINITION_SNAPSHOT.installationId,
            kindId: DEFINITION_SNAPSHOT.kindId,
            dispatchKey: `key-${newestId}`,
            agentId: "agent-f11",
            agentName: "F11 Agent",
            startedAt: "2026-11-21T12:00:00.000Z",
            definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
            definitionSnapshot: DEFINITION_SNAPSHOT,
          },
        });

        // Page 1 at cut1:
        const cursorSecret = "f11-f13-sqlite-cursor-secret-32b",
          cut1 = repo.projection.readCut();
        const page1 = readAgentRuntimeTokenUsageDetail({
          rootDir: repo.rootDir,
          repoId: "repo-f11-f13",
          now: nowIso,
          range: "today",
          member: { kind: "agent", agentId: "agent-f11" },
          limit: 1,
          cursorSecret,
          entityLabel: () => null,
          cut: cut1,
          projection: repo.projection,
        });
        assert.equal(page1.sessions.length, 1);
        assert.equal(page1.sessions[0]!.dispatchId, newestId);
        assert.ok(page1.page?.nextCursor);

        // AFTER Page 1: advance task lifecycle (task_completed) AND append `lateHeartbeatCount` late liveness events
        // on deliveredSession so view.revision > cut1.watermark and event_index has 20 vs 200 late events!
        appendTask({
          ...completedTemplate,
          workspaceRevision: repo.nextRevision(),
          opId: "op-t-comp",
          eventId: "ev-t-comp",
          occurredAt: "2026-11-21T12:05:00.000Z",
        });
        for (let i = 0; i < lateHeartbeatCount; i += 1) {
          const rev = repo.nextRevision();
          appendRuntimeEvent(repo, {
            schema: "agent-runtime-event/v1",
            type: "runtime_session_liveness_changed",
            eventId: `ev-late-live-${i}`,
            opId: `op-late-live-${i}`,
            workspaceRevision: rev,
            occurredAt: `2026-11-21T12:10:${String(i % 60).padStart(2, "0")}.000Z`,
            actor: { principal: { personId: "person-a" }, executor: null },
            source: "local",
            payload: {
              runtimeSessionId: deliveredSession,
              liveness: "live",
            },
          });
        }

        // Measure actual SQLite rows AND group_json bytes read during Page 2 continuation!
        const origAll = StatementSync.prototype.all,
          origGet = StatementSync.prototype.get;
        let sqliteRowsRead = 0,
          groupJsonBytesRead = 0;
        const measureRow = (row: unknown) => {
          if (row !== null && typeof row === "object" && "group_json" in row && typeof row.group_json === "string") {
            groupJsonBytesRead += Buffer.byteLength(row.group_json, "utf8");
          }
        };
        StatementSync.prototype.all = function (...args: unknown[]) {
          const res = origAll.apply(this, args as never);
          if (Array.isArray(res)) {
            sqliteRowsRead += res.length;
            for (const row of res) measureRow(row);
          }
          return res;
        };
        StatementSync.prototype.get = function (...args: unknown[]) {
          const res = origGet.apply(this, args as never);
          if (res !== undefined) {
            sqliteRowsRead += 1;
            measureRow(res);
          }
          return res;
        };
        let page2;
        try {
          page2 = readAgentRuntimeTokenUsageDetail({
            rootDir: repo.rootDir,
            repoId: "repo-f11-f13",
            now: nowIso,
            range: "today",
            member: { kind: "agent", agentId: "agent-f11" },
            limit: 1,
            cursor: page1.page!.nextCursor!,
            cursorSecret,
            entityLabel: () => null,
            cut: repo.projection.readCut(),
            projection: repo.projection,
          });
        } finally {
          StatementSync.prototype.all = origAll;
          StatementSync.prototype.get = origGet;
        }
        assert.equal(page2.sessions.length, 1);
        assert.equal(page2.sessions[0]!.dispatchId, deliveredId);
        assert.equal(
          page2.sessions[0]!.outcome,
          "succeeded",
          "F13: delivered stopped dispatch at <= pinnedWatermark must stay succeeded even after post-watermark task_completed & late session events",
        );
        assert.equal(
          groupJsonBytesRead,
          0,
          "F11: cursor continuation must read 0 bytes of dispatch_lifecycle group_json",
        );
        return sqliteRowsRead;
      } finally {
        repo.projection.close();
        removeTempRepository(repo.rootDir);
      }
    };

    const rowsWith20Late = measureContinuation(20),
      rowsWith200Late = measureContinuation(200);
    assert.equal(
      rowsWith200Late,
      rowsWith20Late,
      `F11: Page-2 SQLite rows read must stay constant under 10x late session events (${rowsWith20Late} vs ${rowsWith200Late})`,
    );
    assert.ok(
      rowsWith200Late <= 40,
      `expected <= 40 SQLite rows read for limit=1 continuation, got ${rowsWith200Late}`,
    );
  },
);

test(
  "F13 real SQLite: unsubmitted stopped dispatch at <= pinnedWatermark stays stopped even after post-watermark execution_submitted",
  { timeout: 30_000 },
  () => {
    const repo = makeSqliteRepo("ha-f13-post-wm-", "repo-f13-post-wm");
    const nowIso = "2026-11-21T16:00:00.000Z";
    try {
      const fixtureEvents = lifecycleFixture().events;
      const created = fixtureEvents.find((e) => e.type === "task_created")! as TaskEventV1;
      const submittedTemplate = fixtureEvents.find((e) => e.type === "execution_submitted")! as TaskEventV1;
      const taskId = created.taskId;
      const executionId = (submittedTemplate as unknown as { payload: { execution: { executionId: string } } }).payload
        .execution.executionId;
      const appendTask = (event: TaskEventV1) => {
        const plan = taskLifecycleWritePlan(event);
        repo.store.append({ event, plan, blobs: [] });
        repo.projection.apply(event, plan);
      };
      appendTask({ ...created, workspaceRevision: repo.nextRevision(), opId: "op-t-create", eventId: "ev-t-create" });

      const stoppedId = "dispatch_00000000000000000000cc01",
        stoppedSession = "sess-unsubmitted-stopped",
        newestId = "dispatch_00000000000000000000cc02",
        newestSession = "sess-cc-newest",
        resultBody = "stopped\n",
        resultSha = createHash("sha256").update(resultBody).digest("hex");

      appendRuntimeEvent(repo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: "ev-d-stop",
        opId: "op-d-stop",
        workspaceRevision: repo.nextRevision(),
        occurredAt: "2026-11-21T11:00:00.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          dispatchId: stoppedId,
          runtimeSessionId: stoppedSession,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          dispatchKey: `key-${stoppedId}`,
          agentId: "agent-f13-iso",
          agentName: "F13 Isolation Agent",
          taskId,
          executionId,
          startedAt: "2026-11-21T11:00:00.000Z",
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          definitionSnapshot: DEFINITION_SNAPSHOT,
        },
      });
      appendRuntimeEvent(
        repo,
        {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_outcome_observed",
          eventId: "ev-o-stop",
          opId: "op-o-stop",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T11:00:03.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            runtimeSessionId: stoppedSession,
            dispatchId: stoppedId,
            outcome: "stopped",
            endedAt: "2026-11-21T11:00:03.000Z",
            exitCode: 0,
            resultRef: `artifact:runtime-result/sha256/${resultSha}`,
            result: { sha256: resultSha, size: Buffer.byteLength(resultBody), mediaType: "text/plain; charset=utf-8" },
            runtimeMetrics: {
              inputTokens: 500,
              cacheReadTokens: 0,
              outputTokens: 100,
              totalTokens: 600,
              toolCallCount: 1,
              usageUnavailable: false,
            },
          },
        },
        [
          {
            sha256: resultSha,
            size: Buffer.byteLength(resultBody),
            mediaType: "text/plain; charset=utf-8",
            body: resultBody,
          },
        ],
      );
      appendRuntimeEvent(repo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: "ev-d-cc-new",
        opId: "op-d-cc-new",
        workspaceRevision: repo.nextRevision(),
        occurredAt: "2026-11-21T12:00:00.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          dispatchId: newestId,
          runtimeSessionId: newestSession,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          dispatchKey: `key-${newestId}`,
          agentId: "agent-f13-iso",
          agentName: "F13 Isolation Agent",
          startedAt: "2026-11-21T12:00:00.000Z",
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          definitionSnapshot: DEFINITION_SNAPSHOT,
        },
      });

      const cursorSecret = "f13-post-wm-cursor-secret-32byte";
      const page1 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        repoId: "repo-f13-post-wm",
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-f13-iso" },
        limit: 1,
        cursorSecret,
        entityLabel: () => null,
        cut: repo.projection.readCut(),
        projection: repo.projection,
      });
      assert.equal(page1.sessions[0]!.dispatchId, newestId);
      assert.ok(page1.page?.nextCursor);

      // Post-watermark delivery arrives AFTER Page 1 cut!
      appendTask({
        ...submittedTemplate,
        workspaceRevision: repo.nextRevision(),
        opId: "op-t-sub-late",
        eventId: "ev-t-sub-late",
        occurredAt: "2026-11-21T12:05:00.000Z",
      });

      const page2 = readAgentRuntimeTokenUsageDetail({
        rootDir: repo.rootDir,
        repoId: "repo-f13-post-wm",
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-f13-iso" },
        limit: 1,
        cursor: page1.page!.nextCursor!,
        cursorSecret,
        entityLabel: () => null,
        cut: repo.projection.readCut(),
        projection: repo.projection,
      });
      assert.equal(page2.sessions.length, 1);
      assert.equal(page2.sessions[0]!.dispatchId, stoppedId);
      assert.equal(
        page2.sessions[0]!.outcome,
        "stopped",
        "F13: post-watermark execution_submitted must NOT retroactively flip pinned snapshot outcome to succeeded",
      );
    } finally {
      repo.projection.close();
      removeTempRepository(repo.rootDir);
    }
  },
);

test(
  "F11 + F13 real SQLite: live running session liveness flood reads 0 group_json bytes on continuation AND pre-watermark cancel + post-watermark exit folds to unknown (never running)",
  { timeout: 30_000 },
  () => {
    const nowIso = "2026-11-21T16:00:00.000Z",
      cursorSecret = "f11-live-f13-cancel-secret-32byt";

    // Part A (F11 live running session): target session is STILL RUNNING at Page 1 and accumulates
    // 20 vs 200 late liveness events into dispatch_lifecycle_group.group_json (attempt.eventIds grows 10x).
    const measureLiveRunningContinuation = (lateLivenessCount: number) => {
      const repo = makeSqliteRepo(`ha-f11-live-${lateLivenessCount}-`, "repo-f11-live");
      try {
        const runningId = "dispatch_00000000000000000000dd01",
          runningSession = "sess-still-running",
          newestId = "dispatch_00000000000000000000dd02",
          newestSession = "sess-dd-newest";
        appendRuntimeEvent(repo, {
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          eventId: "ev-dd-req-1",
          opId: "op-dd-req-1",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T11:00:00.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            dispatchId: runningId,
            runtimeSessionId: runningSession,
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            installationId: DEFINITION_SNAPSHOT.installationId,
            kindId: DEFINITION_SNAPSHOT.kindId,
            dispatchKey: `key-${runningId}`,
            agentId: "agent-live",
            agentName: "Live Agent",
            startedAt: "2026-11-21T11:00:00.000Z",
            definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
            definitionSnapshot: DEFINITION_SNAPSHOT,
          },
        });
        appendRuntimeEvent(repo, {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_started",
          eventId: "ev-dd-start-1",
          opId: "op-dd-start-1",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T11:00:01.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            runtimeSessionId: runningSession,
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            installationId: DEFINITION_SNAPSHOT.installationId,
            kindId: DEFINITION_SNAPSHOT.kindId,
            definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
            launchGeneration: 1,
            attachable: false,
          },
        });
        appendRuntimeEvent(repo, {
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          eventId: "ev-dd-req-2",
          opId: "op-dd-req-2",
          workspaceRevision: repo.nextRevision(),
          occurredAt: "2026-11-21T12:00:00.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            dispatchId: newestId,
            runtimeSessionId: newestSession,
            instanceId: DEFINITION_SNAPSHOT.instanceId,
            installationId: DEFINITION_SNAPSHOT.installationId,
            kindId: DEFINITION_SNAPSHOT.kindId,
            dispatchKey: `key-${newestId}`,
            agentId: "agent-live",
            agentName: "Live Agent",
            startedAt: "2026-11-21T12:00:00.000Z",
            definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
            definitionSnapshot: DEFINITION_SNAPSHOT,
          },
        });

        const page1 = readAgentRuntimeTokenUsageDetail({
          rootDir: repo.rootDir,
          repoId: "repo-f11-live",
          now: nowIso,
          range: "today",
          member: { kind: "agent", agentId: "agent-live" },
          limit: 1,
          cursorSecret,
          entityLabel: () => null,
          cut: repo.projection.readCut(),
          projection: repo.projection,
        });
        assert.ok(page1.page?.nextCursor);

        // Flood the STILL-RUNNING session with late liveness events so its current group_json grows linearly!
        for (let i = 0; i < lateLivenessCount; i += 1) {
          const rev = repo.nextRevision();
          appendRuntimeEvent(repo, {
            schema: "agent-runtime-event/v1",
            type: "runtime_session_liveness_changed",
            eventId: `ev-live-flood-${i}`,
            opId: `op-live-flood-${i}`,
            workspaceRevision: rev,
            occurredAt: `2026-11-21T12:05:${String(i % 60).padStart(2, "0")}.000Z`,
            actor: { principal: { personId: "person-a" }, executor: null },
            source: "local",
            payload: { runtimeSessionId: runningSession, liveness: "live" },
          });
        }
        // Confirm the current group_json genuinely grew with lateLivenessCount accepted eventIds:
        const currentView = repo.projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [runningId] });
        assert.equal(currentView.status, "ready");
        assert.ok(
          currentView.rows[0]!.attempt.eventIds.length >= lateLivenessCount + 2,
          "precondition: live running session group_json must grow with late liveness events",
        );

        const origAll = StatementSync.prototype.all,
          origGet = StatementSync.prototype.get;
        let sqliteRowsRead = 0,
          groupJsonBytesRead = 0,
          lifecycleCalls = 0;
        const measureRow = (row: unknown) => {
          if (row !== null && typeof row === "object" && "group_json" in row && typeof row.group_json === "string") {
            groupJsonBytesRead += Buffer.byteLength(row.group_json, "utf8");
          }
        };
        StatementSync.prototype.all = function (...args: unknown[]) {
          const res = origAll.apply(this, args as never);
          if (Array.isArray(res)) {
            sqliteRowsRead += res.length;
            for (const row of res) measureRow(row);
          }
          return res;
        };
        StatementSync.prototype.get = function (...args: unknown[]) {
          const res = origGet.apply(this, args as never);
          if (res !== undefined) {
            sqliteRowsRead += 1;
            measureRow(res);
          }
          return res;
        };
        const spiedProjection = new Proxy(repo.projection, {
          get(target, prop, receiver) {
            if (prop === "readDispatchLifecycle") {
              return (...args: unknown[]) => {
                lifecycleCalls += 1;
                return (target.readDispatchLifecycle as (...a: unknown[]) => unknown)(...args);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        let page2;
        try {
          page2 = readAgentRuntimeTokenUsageDetail({
            rootDir: repo.rootDir,
            repoId: "repo-f11-live",
            now: nowIso,
            range: "today",
            member: { kind: "agent", agentId: "agent-live" },
            limit: 1,
            cursor: page1.page!.nextCursor!,
            cursorSecret,
            entityLabel: () => null,
            cut: repo.projection.readCut(),
            projection: spiedProjection,
          });
        } finally {
          StatementSync.prototype.all = origAll;
          StatementSync.prototype.get = origGet;
        }
        assert.equal(page2.sessions.length, 1);
        assert.equal(page2.sessions[0]!.dispatchId, runningId);
        assert.equal(page2.sessions[0]!.outcome, "running");
        assert.equal(lifecycleCalls, 0, "F11: continuation must make 0 readDispatchLifecycle calls");
        assert.equal(groupJsonBytesRead, 0, "F11: continuation must read 0 bytes of dispatch_lifecycle group_json");
        return sqliteRowsRead;
      } finally {
        repo.projection.close();
        removeTempRepository(repo.rootDir);
      }
    };
    const live20 = measureLiveRunningContinuation(20),
      live200 = measureLiveRunningContinuation(200);
    assert.equal(
      live200,
      live20,
      `F11: live-running continuation SQLite rows must stay constant (${live20} vs ${live200})`,
    );

    // Part B (F13 real SQLite): pre-watermark cancel + post-watermark exit/outcome folds to settling/unknown (never running)!
    const cancelRepo = makeSqliteRepo("ha-f13-cancel-", "repo-f13-cancel");
    try {
      const cancelId = "dispatch_00000000000000000000ee01",
        cancelSession = "sess-pre-wm-cancel",
        newestId = "dispatch_00000000000000000000ee02",
        newestSession = "sess-ee-newest";
      appendRuntimeEvent(cancelRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: "ev-ee-req-1",
        opId: "op-ee-req-1",
        workspaceRevision: cancelRepo.nextRevision(),
        occurredAt: "2026-11-21T11:00:00.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          dispatchId: cancelId,
          runtimeSessionId: cancelSession,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          dispatchKey: `key-${cancelId}`,
          agentId: "agent-cancel",
          agentName: "Cancel Agent",
          startedAt: "2026-11-21T11:00:00.000Z",
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          definitionSnapshot: DEFINITION_SNAPSHOT,
        },
      });
      appendRuntimeEvent(cancelRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_session_started",
        eventId: "ev-ee-start-1",
        opId: "op-ee-start-1",
        workspaceRevision: cancelRepo.nextRevision(),
        occurredAt: "2026-11-21T11:00:01.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          runtimeSessionId: cancelSession,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          launchGeneration: 1,
          attachable: false,
        },
      });
      appendRuntimeEvent(cancelRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_session_cancelled",
        eventId: "ev-ee-cancel-1",
        opId: "op-ee-cancel-1",
        workspaceRevision: cancelRepo.nextRevision(),
        occurredAt: "2026-11-21T11:00:02.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: { runtimeSessionId: cancelSession },
      });
      appendRuntimeEvent(cancelRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: "ev-ee-req-2",
        opId: "op-ee-req-2",
        workspaceRevision: cancelRepo.nextRevision(),
        occurredAt: "2026-11-21T12:00:00.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          dispatchId: newestId,
          runtimeSessionId: newestSession,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          dispatchKey: `key-${newestId}`,
          agentId: "agent-cancel",
          agentName: "Cancel Agent",
          startedAt: "2026-11-21T12:00:00.000Z",
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          definitionSnapshot: DEFINITION_SNAPSHOT,
        },
      });

      const cut1 = cancelRepo.projection.readCut();
      // Authoritative unpaginated snapshot at cut1 reports "unknown" (settling) for cancelId:
      const authAtCut1 = readAgentRuntimeTokenUsageDetail({
        rootDir: cancelRepo.rootDir,
        repoId: "repo-f13-cancel",
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-cancel" },
        entityLabel: () => null,
        cut: cut1,
        projection: cancelRepo.projection,
      });
      assert.equal(authAtCut1.sessions.find((s) => s.dispatchId === cancelId)?.outcome, "unknown");

      const page1 = readAgentRuntimeTokenUsageDetail({
        rootDir: cancelRepo.rootDir,
        repoId: "repo-f13-cancel",
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-cancel" },
        limit: 1,
        cursorSecret,
        entityLabel: () => null,
        cut: cut1,
        projection: cancelRepo.projection,
      });
      assert.ok(page1.page?.nextCursor);

      // Post-watermark exit & cancelled outcome advance current view.revision > cut1.watermark!
      appendRuntimeEvent(cancelRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_session_exited",
        eventId: "ev-ee-exit-1",
        opId: "op-ee-exit-1",
        workspaceRevision: cancelRepo.nextRevision(),
        occurredAt: "2026-11-21T12:05:00.000Z",
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: { runtimeSessionId: cancelSession },
      });
      const resultBody = "cancelled\n",
        resultSha = createHash("sha256").update(resultBody).digest("hex");
      appendRuntimeEvent(
        cancelRepo,
        {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_outcome_observed",
          eventId: "ev-ee-out-1",
          opId: "op-ee-out-1",
          workspaceRevision: cancelRepo.nextRevision(),
          occurredAt: "2026-11-21T12:05:01.000Z",
          actor: { principal: { personId: "person-a" }, executor: null },
          source: "local",
          payload: {
            runtimeSessionId: cancelSession,
            dispatchId: cancelId,
            outcome: "cancelled",
            endedAt: "2026-11-21T12:05:01.000Z",
            exitCode: 143,
            resultRef: `artifact:runtime-result/sha256/${resultSha}`,
            result: { sha256: resultSha, size: Buffer.byteLength(resultBody), mediaType: "text/plain; charset=utf-8" },
            runtimeMetrics: {
              inputTokens: 100,
              cacheReadTokens: 0,
              outputTokens: 10,
              totalTokens: 110,
              toolCallCount: 1,
              usageUnavailable: false,
            },
          },
        },
        [
          {
            sha256: resultSha,
            size: Buffer.byteLength(resultBody),
            mediaType: "text/plain; charset=utf-8",
            body: resultBody,
          },
        ],
      );

      const page2 = readAgentRuntimeTokenUsageDetail({
        rootDir: cancelRepo.rootDir,
        repoId: "repo-f13-cancel",
        now: nowIso,
        range: "today",
        member: { kind: "agent", agentId: "agent-cancel" },
        limit: 1,
        cursor: page1.page!.nextCursor!,
        cursorSecret,
        entityLabel: () => null,
        cut: cancelRepo.projection.readCut(),
        projection: cancelRepo.projection,
      });
      assert.equal(page2.sessions.length, 1);
      assert.equal(page2.sessions[0]!.dispatchId, cancelId);
      assert.equal(
        page2.sessions[0]!.outcome,
        "unknown",
        "F13: pre-watermark runtime_session_cancelled + post-watermark exit must stay settling/unknown (never running!)",
      );
    } finally {
      cancelRepo.projection.close();
      removeTempRepository(cancelRepo.rootDir);
    }
  },
);

test(
  "F20 production wiring: prepareFleetCenterAdmission persists mode-0600 cursor-secret.key, honors HARNESS_FLEET_CURSOR_SECRET across replicas, and unconfigured listener fails closed",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await fleetFixture(t);
    t.after(() => fixture.close());
    const { nodeId, repoId } = fixture.subject,
      scratch = mkdtempSync(path.join(tmpdir(), "ha-f20-prod-")),
      stateRootKey = path.join(scratch, "state-key"),
      stateRootEnvA = path.join(scratch, "state-env-a"),
      stateRootEnvB = path.join(scratch, "state-env-b"),
      stateRootUnconfigured = path.join(scratch, "state-unconfigured");
    mkdirSync(stateRootKey, { recursive: true });
    mkdirSync(stateRootEnvA, { recursive: true });
    mkdirSync(stateRootEnvB, { recursive: true });
    mkdirSync(stateRootUnconfigured, { recursive: true });
    const prevEnvSecret = process.env[FLEET_CURSOR_SECRET_ENV];
    t.after(() => {
      if (prevEnvSecret === undefined) delete process.env[FLEET_CURSOR_SECRET_ENV];
      else process.env[FLEET_CURSOR_SECRET_ENV] = prevEnvSecret;
      removeTempRepository(scratch);
    });

    const tlsA = generateTlsCert(scratch, "f20-a"),
      tlsB = generateTlsCert(scratch, "f20-b"),
      canonicalRepo = makeSqliteRepo("ha-f20-canonical-", repoId),
      nowIso = "2026-11-21T16:00:00.000Z";
    t.after(() => {
      canonicalRepo.projection.close();
      removeTempRepository(canonicalRepo.rootDir);
    });
    for (let i = 1; i <= 3; i += 1) {
      const dispatchId = `dispatch_00000000000000000000f20${i}`,
        sessionId = `sess-f20-${i}`;
      appendRuntimeEvent(canonicalRepo, {
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        eventId: `ev-f20-d-${i}`,
        opId: `op-f20-d-${i}`,
        workspaceRevision: canonicalRepo.nextRevision(),
        occurredAt: `2026-11-21T10:0${i}:00.000Z`,
        actor: { principal: { personId: "person-a" }, executor: null },
        source: "local",
        payload: {
          dispatchId,
          runtimeSessionId: sessionId,
          instanceId: DEFINITION_SNAPSHOT.instanceId,
          installationId: DEFINITION_SNAPSHOT.installationId,
          kindId: DEFINITION_SNAPSHOT.kindId,
          dispatchKey: `key-${dispatchId}`,
          agentId: "agent-f20",
          agentName: "F20 Agent",
          startedAt: `2026-11-21T10:0${i}:00.000Z`,
          definitionSnapshotRef: "artifact:runtime-definitions/test/v1",
          definitionSnapshot: DEFINITION_SNAPSHOT,
        },
      });
    }

    fixture.owners.keycloak.account("person-reader");
    fixture.owners.keycloak.permit("person-reader", repoId, ["repository-read"]);
    fixture.owners.keycloak.interactiveSession("person-reader", nodeId, fixture.owners.url, "reader-token", "web-bff");

    const makeHostWithSecret = (secretGetter: () => string | Buffer | Uint8Array | undefined, onRead?: () => void) => {
      const handlers = agentRuntimeTokenUsageReadHandlers({
        rootDir: canonicalRepo.rootDir,
        input: { repoId, fleetCursorSecret: secretGetter },
        now: () => nowIso,
        projection: canonicalRepo.projection,
        cellCodedError: (code, text) => Object.assign(new Error(text), { code }),
      });
      return {
        ...fixture.host,
        read: async (
          targetRepoId: string,
          method: string,
          payload: Readonly<Record<string, unknown>>,
          binding?: unknown,
        ) => {
          if (method === "repo.agentRuntime.tokenUsageDetail" && targetRepoId === repoId) {
            onRead?.();
            return handlers["repo.agentRuntime.tokenUsageDetail"](payload, binding as never) as never;
          }
          return fixture.host.read(targetRepoId, method as never, payload, binding as never);
        },
      };
    };

    // 1) Without HARNESS_FLEET_CURSOR_SECRET: prepareFleetCenterAdmission creates mode-0600 32-byte stateRoot/cursor-secret.key
    //    and a second boot/recovery on the same stateRoot reloads the exact same secret!
    delete process.env[FLEET_CURSOR_SECRET_ENV];
    const nodes = {
      verifyHuman: (auth: Parameters<ReturnType<typeof createIdentitySession>["bind"]>[0]) =>
        createIdentitySession(fixture.userRoot).bind(auth),
      authenticate: (node: string, secret: string) => node === nodeId && secret === "machine-secret",
      nodeOwner: fixture.owners.nodeOwner,
    };
    const keyFile = path.join(stateRootKey, FLEET_CURSOR_SECRET_FILENAME);
    assert.equal(existsSync(keyFile), false);
    const keySecret1Box: { value?: string | Buffer | Uint8Array } = {};
    const prepared1 = await prepareFleetCenterAdmission({
      host: makeHostWithSecret(() => keySecret1Box.value),
      storage: undefined,
      userRoot: fixture.userRoot,
      nodes,
      payload: {
        port: 0,
        bind: "127.0.0.1",
        keyPath: tlsA.keyPath,
        certPath: tlsA.certPath,
        repoId,
        stateRoot: stateRootKey,
        quotaBytes: 64 * 1024 * 1024,
      },
    });
    keySecret1Box.value = prepared1.cursorSecret;
    assert.ok(Buffer.isBuffer(prepared1.cursorSecret) && prepared1.cursorSecret.byteLength === 32);
    assert.equal(existsSync(keyFile), true);
    if (process.platform !== "win32") {
      assert.equal(statSync(keyFile).mode & 0o777, 0o600, "F20: cursor-secret.key must be persisted with mode 0600");
    }
    const keySecret2Box: { value?: string | Buffer | Uint8Array } = {};
    const prepared2 = await prepareFleetCenterAdmission({
      host: makeHostWithSecret(() => keySecret2Box.value),
      storage: undefined,
      userRoot: fixture.userRoot,
      nodes,
      payload: {
        port: 0,
        bind: "127.0.0.1",
        keyPath: tlsB.keyPath,
        certPath: tlsB.certPath,
        repoId,
        stateRoot: stateRootKey,
        quotaBytes: 64 * 1024 * 1024,
      },
    });
    keySecret2Box.value = prepared2.cursorSecret;
    assert.ok(Buffer.isBuffer(prepared2.cursorSecret));
    assert.equal(
      prepared2.cursorSecret.equals(prepared1.cursorSecret),
      true,
      "F20: restart recovery on same stateRoot must reload the persisted 32-byte cursor-secret.key",
    );

    const started1 = await startFleetCenterAdmission({ ...prepared1, ...fixture.writerOptions });
    t.after(() => started1.center.close());
    const started2 = await startFleetCenterAdmission({ ...prepared2, ...fixture.writerOptions });
    t.after(() => started2.center.close());

    const persistedPage1 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        port: started1.center.port,
        ca: tlsA.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-f20", limit: 2 },
      }),
    );
    assert.equal(persistedPage1.sessions.length, 2);
    assert.ok(persistedPage1.page?.nextCursor);
    const persistedPage2 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        port: started2.center.port,
        ca: tlsB.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-f20", limit: 2, cursor: persistedPage1.page!.nextCursor! },
      }),
    );
    assert.equal(persistedPage2.sessions.length, 1);

    // 2) With HARNESS_FLEET_CURSOR_SECRET: two Centers with distinct stateRoots share the env secret via prepareFleetCenterAdmission!
    process.env[FLEET_CURSOR_SECRET_ENV] = "env-shared-cluster-secret-32bytes!";
    const envSecretABox: { value?: string | Buffer | Uint8Array } = {},
      envSecretBBox: { value?: string | Buffer | Uint8Array } = {};
    const envPreparedA = await prepareFleetCenterAdmission({
      host: makeHostWithSecret(() => envSecretABox.value),
      storage: undefined,
      userRoot: fixture.userRoot,
      nodes,
      payload: {
        port: 0,
        bind: "127.0.0.1",
        keyPath: tlsA.keyPath,
        certPath: tlsA.certPath,
        repoId,
        stateRoot: stateRootEnvA,
        quotaBytes: 64 * 1024 * 1024,
      },
    });
    envSecretABox.value = envPreparedA.cursorSecret;
    const envPreparedB = await prepareFleetCenterAdmission({
      host: makeHostWithSecret(() => envSecretBBox.value),
      storage: undefined,
      userRoot: fixture.userRoot,
      nodes,
      payload: {
        port: 0,
        bind: "127.0.0.1",
        keyPath: tlsB.keyPath,
        certPath: tlsB.certPath,
        repoId,
        stateRoot: stateRootEnvB,
        quotaBytes: 64 * 1024 * 1024,
      },
    });
    envSecretBBox.value = envPreparedB.cursorSecret;
    const envStartedA = await startFleetCenterAdmission({ ...envPreparedA, ...fixture.writerOptions });
    t.after(() => envStartedA.center.close());
    const envStartedB = await startFleetCenterAdmission({ ...envPreparedB, ...fixture.writerOptions });
    t.after(() => envStartedB.center.close());
    const envPage1 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        port: envStartedA.center.port,
        ca: tlsA.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-f20", limit: 1 },
      }),
    );
    assert.ok(envPage1.page?.nextCursor);
    const envPage2 = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        port: envStartedB.center.port,
        ca: tlsB.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-f20", limit: 2, cursor: envPage1.page!.nextCursor! },
      }),
    );
    assert.equal(envPage2.sessions.length, 2);

    // 3) Negative: listener opened directly WITHOUT cursorSecret fails closed BEFORE host.read!
    let unconfiguredHostReads = 0;
    const unconfiguredCenter = await fixture.hold(
      listenFleetTls({
        host: makeHostWithSecret(
          () => undefined,
          () => {
            unconfiguredHostReads += 1;
          },
        ),
        stateRoot: stateRootUnconfigured,
        ...fixture.writerOptions,
        key: tlsA.key,
        cert: tlsA.cert,
        ...nodes,
      }),
    );
    await assert.rejects(
      readFleetOperationalClient({
        port: unconfiguredCenter.port,
        ca: tlsA.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-f20", limit: 2 },
      }),
      (error: unknown) => error instanceof FleetRemoteError && error.code === "cursor_secret_unconfigured",
    );
    assert.equal(
      unconfiguredHostReads,
      0,
      "F20: unconfigured Fleet listener must reject paginated detail reads before entering host.read",
    );
    // And verify the real openDaemonHost production host (`fixture.host`) itself has fleetCursorSecret wired
    // through daemon-host-open -> repo-read-pool -> repo-read-worker -> agent-runtime-token-usage
    // both directly AND through a real prepareFleetCenterAdmission + startFleetCenterAdmission TLS listener!
    const hostProdPaged = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await fixture.host.read(
        repoId,
        "repo.agentRuntime.tokenUsageDetail",
        { range: "today", agentId: "agent-f20", limit: 2 },
        fixture.auth,
      ),
    );
    assert.equal(hostProdPaged.page?.limit, 2);
    const prodTlsPrepared = await prepareFleetCenterAdmission({
      host: fixture.host,
      storage: undefined,
      userRoot: fixture.userRoot,
      nodes,
      payload: {
        port: 0,
        bind: "127.0.0.1",
        keyPath: tlsA.keyPath,
        certPath: tlsA.certPath,
        repoId,
        stateRoot: stateRootEnvA,
        quotaBytes: 64 * 1024 * 1024,
      },
    });
    const prodTlsStarted = await startFleetCenterAdmission({ ...prodTlsPrepared, ...fixture.writerOptions });
    t.after(() => prodTlsStarted.center.close());
    const prodTlsPaged = parseDaemonReadResult(
      "repo.agentRuntime.tokenUsageDetail",
      await readFleetOperationalClient({
        port: prodTlsStarted.center.port,
        ca: tlsA.cert,
        servername: "localhost",
        nodeId,
        credential: "machine-secret",
        repoId,
        readAccessToken: async () => "reader-token",
        method: "repo.agentRuntime.tokenUsageDetail",
        payload: { range: "today", agentId: "agent-f20", limit: 2 },
      }),
    );
    assert.equal(prodTlsPaged.page?.limit, 2);
  },
);
