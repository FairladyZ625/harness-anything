// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeSession, TaskProjection } from "@harness-anything/kernel";
import { binding } from "../src/daemon-host-binding.ts";
import { OidcSessionService } from "../src/oidc-session-service.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { makeAgentRuntimeReadModel, readObservedRuntimeSession } from "../src/agent-runtime-read.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";

const dispatchId = "dispatch_000000000000000000000007";

for (const role of ["implementation", "reviewer"] as const) {
  test(`${role}: stream exit remains visible when canonical settlement is denied`, (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-exit-read-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let session: RuntimeSession = {
      runtimeSessionId: "runtime-exit-read",
      instanceId: "instance-test",
      installationId: "installation-test",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "live",
      attachable: true,
      taskBindings: [],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: "2026-10-03T11:00:00.000Z",
    };
    const dispatch = {
      payload: {
        dispatchId,
        runtimeSessionId: session.runtimeSessionId,
        definitionSnapshotRef: session.definitionSnapshotRef,
        role,
      },
    };
    const projection = {
      readCut: () => ({ status: "ready", watermark: 3, sourceRevision: 3 }),
      readRuntimeSession: () => session,
      readRuntimeSessions: () => [session],
      readRuntimeSessionEvents: () => [],
      readRuntimeInstallation: () => null,
      readRuntimeInstallations: () => [],
      readRuntimeDispatch: () => dispatch,
      readRuntimeDispatches: () => [dispatch],
      readTaskRuntimeBatch: () => ({ rows: [] }),
      listEntities: () => [],
    } as unknown as TaskProjection;
    const reads = makeAgentRuntimeReadModel({
      projection,
      store: { readContentBlob: () => null } as never,
      now: () => "2099-01-01T00:00:00.000Z",
    });
    const writer = openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: session.runtimeSessionId,
      taskId: null,
      executionId: null,
      instanceId: session.instanceId,
      startedAt: session.lastObservedAt,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
    assert.equal(reads.session({ runtimeSessionId: session.runtimeSessionId }).session.liveness, "live");
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    const exited = readObservedRuntimeSession(projection, rootDir, session.runtimeSessionId)!;
    assert.equal(exited.liveness, "exited");
    assert.equal(exited.attachable, false);
    assert.equal(exited.outcome, null);
    assert.equal(exited.exitCode, 0);
    assert.equal(
      reads.session({ runtimeSessionId: session.runtimeSessionId }).session.liveness,
      "live",
      "public queries retain the last accepted observation when settlement is denied",
    );
    const body = "Worker finished.\nRuntime archive publication failed: authentication_required",
      sha256 = createHash("sha256").update(body).digest("hex"),
      resultRef = `artifact:runtime-result/sha256/${sha256}`;
    writer.appendTerminalOutcome(
      {
        payload: {
          runtimeSessionId: session.runtimeSessionId,
          dispatchId,
          outcome: "failed",
          exitCode: 0,
          reasonCode: "runtime_archive_failed",
          resultRef,
          result: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain" },
          endedAt: "2026-10-03T11:54:11.000Z",
        },
        body,
        reason: "Worker finished",
      },
      "2026-10-03T11:54:11.000Z",
    );
    const failed = readObservedRuntimeSession(projection, rootDir, session.runtimeSessionId)!;
    assert.equal(failed.liveness, "exited");
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.reasonCode, "runtime_archive_failed");
    assert.equal(failed.exitCode, 0);
    assert.equal(failed.resultRef, resultRef);
    assert.equal(reads.overview({}).sessions[0]?.liveness, "live");
    assert.equal(reads.session({ runtimeSessionId: session.runtimeSessionId }).result, null);
    assert.equal(session.liveness, "live", "local evidence must not write the canonical projection");
    assert.equal(session.outcome, null);
    session = { ...session, liveness: "exited", attachable: false, outcome: "cancelled" };
    const canonical = readObservedRuntimeSession(projection, rootDir, session.runtimeSessionId)!;
    assert.equal(canonical.outcome, "cancelled");
    assert.equal(canonical.resultRef, null, "local terminal text must not replace a canonical outcome");
  });
}

test("local runtime claims do not establish a principal after interactive logout", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-logout-")),
    realm = await serveKeycloak();
  t.after(async () => {
    await realm.close();
    rmSync(userRoot, { recursive: true, force: true });
  });
  realm.bind(userRoot);
  realm.keycloak.account("person-runtime-test");
  signInAt(userRoot, "person-runtime-test");
  const oidc = new OidcSessionService(userRoot, {
      // The shared policy fixture implements grants; this test also exercises OIDC revocation.
      fetch: (input, init) =>
        String(input).endsWith("/protocol/openid-connect/revoke")
          ? Promise.resolve(new Response(null, { status: 204 }))
          : fetch(input, init),
    }),
    executor = { kind: "agent" as const, id: "runtime-session:runtime-test" },
    provenance = { ...auth, sessionEnvironment: { HARNESS_ACTOR: "agent:runtime-session:runtime-test" } };
  assert.equal(
    (await binding(userRoot, await oidc.bind(provenance), executor)).actor.principal.personId,
    "person-runtime-test",
  );
  await oidc.logout();
  await assert.rejects(
    binding(
      userRoot,
      {
        ...(await oidc.bind(provenance)),
        keycloakCenter: async () => {
          throw new Error("principal binding must precede online authorization");
        },
      },
      executor,
    ),
    { code: "authentication_required" },
  );
});
