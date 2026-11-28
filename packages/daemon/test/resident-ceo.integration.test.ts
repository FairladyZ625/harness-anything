// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { eventuallyValue, initIngressRepo, rpc, writeProviderStub } from "./fixtures/runtime-ingress.ts";
import { policyTestCenter, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import {
  allowFixtureRuntimeInstances,
  registerBootstrappedDaemonRepo,
  registerFixtureRuntimeInstance,
} from "./repo-settings.fixture.ts";
import { evidence } from "./task-surface.fixtures.ts";

test(
  "resident CEO answers a delegation and resumes its provider conversation for its owner",
  { timeout: 90_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const argsPath = path.join(parent, "provider-args.json");
    const repoId = "resident-ceo-test";
    const installation = {
      installationId: "resident-ceo-codex",
      kindId: "codex" as const,
      executablePath: writeProviderStub(path.join(parent, "codex.mjs"), "codex", argsPath),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
    const host = await openDaemonHost({ daemonId: repoId, userRoot, runtimeDiscover: () => [installation] });
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Codex fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });
      const delegated = await host.run(
        repoId,
        {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Review the migration",
        },
        auth,
      );
      assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
      const { request } = evidence(delegated) as { request: PeerRequestV1 };

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const bobAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });
      const config = await ceo("config", {
        runtimeInstanceId: "codex-provider",
        model: "test-model",
        heartbeatIntervalSec: 300,
      });
      assert.equal(config.ok, true, JSON.stringify(config));
      const persistedProfiles = (await host.read(repoId, "repo.settings.read", {}, auth)).settings
        .residentCeoProfilesJson;
      assert.ok(persistedProfiles?.includes('"person_bob"'));
      const started = await ceo("start");
      assert.equal(started.ok, true, JSON.stringify(started));

      const peerWake = await eventuallyValue(async () => {
        const status = await ceo("status");
        assert.equal(status.ok, true, JSON.stringify(status));
        const profile = status.profile as {
          readonly persistentSessionId: string | null;
          readonly lastWake: { readonly cause: string; readonly status: string; readonly detail: string | null } | null;
        };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.status === "succeeded" ? profile : null;
      }, "resident CEO peer wake settlement");
      assert.equal(peerWake.lastWake?.cause, "peer-request");
      assert.equal(peerWake.persistentSessionId, "codex-provider-session");
      assert.ok(!(JSON.parse(readFileSync(argsPath, "utf8")) as string[]).includes("resume"));

      const chat = await ceo("chat", { message: "Continue our migration review" });
      assert.equal(chat.ok, true, JSON.stringify(chat));
      assert.ok((JSON.parse(readFileSync(argsPath, "utf8")) as string[]).includes("resume"));
      assert.ok((JSON.parse(readFileSync(argsPath, "utf8")) as string[]).includes(peerWake.persistentSessionId));
      const stopped = await ceo("stop");
      assert.equal(stopped.ok, true, JSON.stringify(stopped));
      assert.equal((stopped.profile as { status: string }).status, "stopped");

      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const forgedProfiles = JSON.parse(persistedProfiles ?? "{}") as Record<string, Record<string, unknown>>;
      forgedProfiles.person_bob!.model = "unauthorized-model";
      const unauthorizedUpdate = await host.run(
        repoId,
        { kind: "settings-update", residentCeoProfilesJson: JSON.stringify(forgedProfiles) },
        auth,
      );
      assert.equal(unauthorizedUpdate.outcome, "op_rejected");
      const finalProfiles = JSON.parse(
        (await host.read(repoId, "repo.settings.read", {}, auth)).settings.residentCeoProfilesJson ?? "{}",
      ) as Record<string, { status: string; persistentSessionId: string | null; lastWake: { status: string } | null }>;
      assert.ok(persistedProfiles?.includes('"person_bob"'));
      assert.equal(finalProfiles.person_bob?.status, "stopped");
      assert.equal(finalProfiles.person_bob?.persistentSessionId, "codex-provider-session");
      assert.equal(finalProfiles.person_bob?.lastWake?.status, "succeeded");
      const senderView = evidence(
        await host.run(repoId, { kind: "peer-watch", once: true, replyTo: request.requestId }, auth),
      ) as { request: PeerRequestV1 };
      assert.equal(senderView.request.state, "ANSWERED");
      assert.equal(senderView.request.reply?.structuredBody.claim, "codex final result");
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);

test(
  "resident CEO restart restore waits for managed RBAC resume without consulting a resuming center",
  { timeout: 60_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-restore-")),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      argsPath = path.join(parent, "provider-args.json"),
      repoId = "resident-ceo-restore",
      installation = {
        installationId: "resident-ceo-restore-codex",
        kindId: "codex" as const,
        executablePath: writeProviderStub(path.join(parent, "codex.mjs"), "codex", argsPath),
        version: "codex-cli 0.159.1",
        observedAt: new Date().toISOString(),
      };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    const firstHost = await openDaemonHost({ daemonId: repoId, userRoot, runtimeDiscover: () => [installation] });
    try {
      await firstHost.attachmentsSettled();
      await registerFixtureRuntimeInstance(firstHost, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Restore Codex fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });
      const bobAuth = {
        ...auth,
        oidcPrincipal: await firstHost.sessionPrincipal(auth, "repo.residentCeo.status", {
          repo: { repoId },
          payload: {},
        }),
      };
      const config = await rpc(firstHost, bobAuth, "repo.residentCeo.config", {
        repo: { repoId },
        payload: { runtimeInstanceId: "codex-provider", model: "test-model", heartbeatIntervalSec: 300 },
      });
      assert.equal(config.ok, true, JSON.stringify(config));
      const started = await rpc(firstHost, bobAuth, "repo.residentCeo.start", { repo: { repoId }, payload: {} });
      assert.equal(started.ok, true, JSON.stringify(started));
    } finally {
      await firstHost.close();
    }

    let ready = false,
      requests = 0;
    const sockets = new Set<net.Socket>(),
      upstreamUrl = (await policyTestCenter()).url,
      server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        if (!ready) {
          requests += 1;
          socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
          return;
        }
        const upstream = net.connect(Number(new URL(upstreamUrl).port), "127.0.0.1");
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.on("error", () => socket.destroy());
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    server.unref();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const gatedUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    writeFileSync(path.join(userRoot, "rbac/config.json"), JSON.stringify({ url: gatedUrl, realm: "harness" }));
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((done) => {
      releaseResume = done;
    });
    const restartedHost = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      runtimeDiscover: () => [installation],
      managedRbac: { run: async () => ({ ok: true }), resume: () => resumeGate, stop: async () => ({ ok: true }) },
    });
    try {
      await restartedHost.attachmentsSettled();
      for (let turn = 0; turn < 20; turn += 1) await new Promise((done) => setImmediate(done));
      assert.equal(requests, 0, "resident CEO restore must wait for managed RBAC resume before consulting the center");
      ready = true;
      releaseResume();
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await restartedHost.sessionPrincipal(auth, "repo.residentCeo.status", {
          repo: { repoId },
          payload: {},
        }),
      };
      const status = await rpc(restartedHost, aliceAuth, "repo.residentCeo.status", { repo: { repoId }, payload: {} });
      assert.equal(status.ok, true, JSON.stringify(status));
      assert.equal((status.profile as { status: string }).status, "running");
    } finally {
      ready = true;
      releaseResume();
      await restartedHost.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      removeTempRepository(parent);
    }
  },
);

test(
  "resident CEO empty-inbox heartbeat advances schedule without launching an LLM runtime",
  { timeout: 90_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-empty-hb-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const argsPath = path.join(parent, "provider-args.json");
    const repoId = "resident-ceo-empty-hb";
    const installation = {
      installationId: "resident-ceo-empty-hb-codex",
      kindId: "codex" as const,
      executablePath: writeProviderStub(path.join(parent, "codex.mjs"), "codex", argsPath),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    let clockOffsetMs = 0;
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      now: () => new Date(Date.now() + clockOffsetMs).toISOString(),
      runtimeDiscover: () => [installation],
    });
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Empty Heartbeat fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });
      const bobAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });
      assert.equal(
        (
          await ceo("config", {
            runtimeInstanceId: "codex-provider",
            model: "test-model",
            heartbeatIntervalSec: 30,
          })
        ).ok,
        true,
      );
      assert.equal((await ceo("start")).ok, true);
      // Let the watcher complete its initial inbox check and enter its bounded event wait.
      await new Promise((resolve) => setTimeout(resolve, 250));
      // Advance clock past the 30s heartbeat interval, then emit an unrelated event for another
      // recipient so Bob's watcher wakes immediately, evaluates the due heartbeat on an empty
      // inbox, and advances nextHeartbeat without spawning any LLM runtime.
      clockOffsetMs += 35_000;
      const unrelated = await host.run(
        repoId,
        {
          kind: "peer-ask",
          toPersonId: "person_carol",
          summary: "Unrelated peer notice",
          claim: "Only for Carol.",
          requestedAction: "No action for Bob.",
        },
        bobAuth,
      );
      assert.equal(unrelated.outcome, "applied", JSON.stringify(unrelated));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const statusAfterHeartbeat = await ceo("status");
      assert.equal(statusAfterHeartbeat.ok, true, JSON.stringify(statusAfterHeartbeat));
      assert.equal((statusAfterHeartbeat.profile as { lastWake: unknown }).lastWake, null);
      assert.equal(existsSync(argsPath), false, "empty-inbox heartbeat must not launch an LLM runtime");

      // Positive control: the same watcher is still alive and wakes when a real delegation arrives.
      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const delegated = await host.run(
        repoId,
        {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Delegate after idle heartbeat",
        },
        aliceAuth,
      );
      assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const woke = await eventuallyValue(async () => {
        const status = await ceo("status");
        const profile = status.profile as {
          readonly lastWake: { readonly cause: string; readonly status: string; readonly detail: string | null } | null;
        };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.status === "succeeded" ? profile : null;
      }, "resident CEO wakes for real delegation after empty heartbeat");
      assert.equal(woke.lastWake?.cause, "peer-request");
      assert.equal(existsSync(argsPath), true);
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);

test(
  "resident CEO isolates inbox watchers across multiple repositories for the same principal",
  { timeout: 120_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-multi-repo-"));
    const repoARoot = path.join(parent, "repo-a");
    const repoBRoot = path.join(parent, "repo-b");
    const userRoot = path.join(parent, "user");
    const argsPath = path.join(parent, "provider-args.json");
    const repoA = "resident-ceo-repo-a";
    const repoB = "resident-ceo-repo-b";
    const installation = {
      installationId: "resident-ceo-multi-codex",
      kindId: "codex" as const,
      executablePath: writeProviderStub(path.join(parent, "codex.mjs"), "codex", argsPath),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(repoARoot, process.getuid?.() ?? 0);
    initIngressRepo(repoBRoot, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({
      canonicalRoot: repoARoot,
      repoId: repoA,
      userRoot,
      createConvenienceLinks: false,
    });
    registerBootstrappedDaemonRepo({
      canonicalRoot: repoBRoot,
      repoId: repoB,
      userRoot,
      createConvenienceLinks: false,
    });
    signInPolicyTestUser(userRoot, "person_bob", [repoA, repoB], "admin");
    const host = await openDaemonHost({ daemonId: "multi-repo-ceo", userRoot, runtimeDiscover: () => [installation] });
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoA, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Multi-Repo fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });
      await allowFixtureRuntimeInstances(host, repoB, auth, ["codex-provider"]);
      const bobAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", {
          repo: { repoId: repoA },
          payload: {},
        }),
      };
      const ceo = (repoId: string, operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });
      for (const repoId of [repoA, repoB]) {
        assert.equal(
          (
            await ceo(repoId, "config", {
              runtimeInstanceId: "codex-provider",
              model: "test-model",
              heartbeatIntervalSec: 300,
            })
          ).ok,
          true,
        );
        assert.equal((await ceo(repoId, "start")).ok, true);
      }

      // Send delegations to person_bob in BOTH repositories.
      signInPolicyTestUser(userRoot, "person_alice", [repoA, repoB], "admin");
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", {
          repo: { repoId: repoA },
          payload: {},
        }),
      };
      const delegateA = await host.run(
        repoA,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Repo A delegation" },
        aliceAuth,
      );
      const delegateB = await host.run(
        repoB,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Repo B delegation" },
        aliceAuth,
      );
      assert.equal(delegateA.outcome, "applied", JSON.stringify(delegateA));
      assert.equal(delegateB.outcome, "applied", JSON.stringify(delegateB));
      const { request: reqA } = evidence(delegateA) as { request: PeerRequestV1 };
      const { request: reqB } = evidence(delegateB) as { request: PeerRequestV1 };

      // Switch local session back to person_bob so both watchers execute under their principal.
      signInPolicyTestUser(userRoot, "person_bob", [repoA, repoB], "admin");
      for (const [repoId, requestId] of [
        [repoA, reqA.requestId],
        [repoB, reqB.requestId],
      ] as const) {
        const settled = await eventuallyValue(async () => {
          const status = await ceo(repoId, "status");
          const profile = status.profile as {
            readonly lastWake: { readonly status: string; readonly peerRequestId?: string } | null;
          };
          return profile.lastWake?.status === "succeeded" && profile.lastWake.peerRequestId === requestId
            ? profile
            : null;
        }, `resident CEO settles delegation in ${repoId}`);
        assert.equal(settled.lastWake?.peerRequestId, requestId);
      }

      // Stopping repoB must not abort repoA's watcher.
      assert.equal((await ceo(repoB, "stop")).ok, true);
      signInPolicyTestUser(userRoot, "person_alice", [repoA, repoB], "admin");
      const secondDelegateA = await host.run(
        repoA,
        { kind: "peer-ask", requestKind: "delegate", toPersonId: "person_bob", summary: "Repo A follow-up" },
        aliceAuth,
      );
      assert.equal(secondDelegateA.outcome, "applied", JSON.stringify(secondDelegateA));
      const { request: reqA2 } = evidence(secondDelegateA) as { request: PeerRequestV1 };
      signInPolicyTestUser(userRoot, "person_bob", [repoA, repoB], "admin");
      const settledA2 = await eventuallyValue(async () => {
        const status = await ceo(repoA, "status");
        const profile = status.profile as {
          readonly lastWake: { readonly status: string; readonly peerRequestId?: string } | null;
        };
        return profile.lastWake?.status === "succeeded" && profile.lastWake.peerRequestId === reqA2.requestId
          ? profile
          : null;
      }, "repoA watcher stays active after repoB stops");
      assert.equal(settledA2.lastWake?.peerRequestId, reqA2.requestId);
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);

test(
  "resident CEO heartbeatIntervalSec = 0 disables polling while keeping event-driven wake active and supports live 0 <-> 30 toggling",
  { timeout: 120_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-zero-hb-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const argsPath = path.join(parent, "provider-args.json");
    const repoId = "resident-ceo-zero-hb";
    const installation = {
      installationId: "resident-ceo-zero-hb-codex",
      kindId: "codex" as const,
      executablePath: writeProviderStub(path.join(parent, "codex.mjs"), "codex", argsPath),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
    let clockOffsetMs = 0;
    const host = await openDaemonHost({
      daemonId: repoId,
      userRoot,
      now: () => new Date(Date.now() + clockOffsetMs).toISOString(),
      runtimeDiscover: () => [installation],
    });
    try {
      await host.attachmentsSettled();
      await registerFixtureRuntimeInstance(host, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO Zero Heartbeat fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });
      const bobAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(host, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

      // Negative controls: invalid intervals 1, 29, -1, 86401 are rejected with resident_ceo_invalid_profile.
      for (const invalidSec of [1, 29, -1, 86_401]) {
        const rejected = await ceo("config", {
          runtimeInstanceId: "codex-provider",
          model: "test-model",
          heartbeatIntervalSec: invalidSec,
        });
        assert.equal(rejected.ok, false, `expected heartbeatIntervalSec=${invalidSec} to fail`);
        assert.equal(
          (rejected.error as { code?: string })?.code,
          "resident_ceo_invalid_profile",
          JSON.stringify(rejected),
        );
      }

      // Positive control: heartbeatIntervalSec = 0 is accepted and starts cleanly.
      const configuredZero = await ceo("config", {
        runtimeInstanceId: "codex-provider",
        model: "test-model",
        heartbeatIntervalSec: 0,
      });
      assert.equal(configuredZero.ok, true, JSON.stringify(configuredZero));
      assert.equal((configuredZero.profile as { heartbeatIntervalSec: number }).heartbeatIntervalSec, 0);
      assert.equal((await ceo("start")).ok, true);

      const statusZero = await ceo("status");
      assert.match(String(statusZero.summary ?? ""), /0s \(event-only\)/u);

      // Let the watcher complete initial check and park on canonical event stream.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Advance clock by 65s and emit an unrelated event; heartbeat must NOT fire or record history.
      clockOffsetMs += 65_000;
      const unrelated1 = await host.run(
        repoId,
        {
          kind: "peer-ask",
          toPersonId: "person_carol",
          summary: "Unrelated notice during 0s heartbeat",
          claim: "Only for Carol.",
          requestedAction: "No action for Bob.",
        },
        bobAuth,
      );
      assert.equal(unrelated1.outcome, "applied", JSON.stringify(unrelated1));
      await new Promise((resolve) => setTimeout(resolve, 400));

      const hbHistoryZero = await ceo("history", { cause: "heartbeat" });
      assert.equal(hbHistoryZero.ok, true, JSON.stringify(hbHistoryZero));
      assert.equal((hbHistoryZero.history as unknown[]).length, 0, JSON.stringify(hbHistoryZero));
      assert.equal(existsSync(argsPath), false, "0s heartbeat mode must not launch an LLM runtime on unrelated events");

      // Event-driven wake remains active when a real delegation arrives for Bob.
      signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");
      const aliceAuth = {
        ...auth,
        oidcPrincipal: await host.sessionPrincipal(auth, "repo.residentCeo.status", { repo: { repoId }, payload: {} }),
      };
      const delegated = await host.run(
        repoId,
        {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Event-driven wake with 0s heartbeat",
        },
        aliceAuth,
      );
      assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const woke = await eventuallyValue(async () => {
        const status = await ceo("status");
        const profile = status.profile as {
          readonly lastWake: { readonly cause: string; readonly status: string } | null;
        };
        assert.notEqual(profile.lastWake?.status, "failed", JSON.stringify(profile.lastWake));
        return profile.lastWake?.status === "succeeded" ? profile : null;
      }, "resident CEO wakes immediately via event stream when heartbeatIntervalSec = 0");
      assert.equal(woke.lastWake?.cause, "peer-request");
      assert.equal(existsSync(argsPath), true);

      // Live switch 0 -> 30 while running starts periodic heartbeat checks.
      assert.equal(
        (
          await ceo("config", {
            runtimeInstanceId: "codex-provider",
            model: "test-model",
            heartbeatIntervalSec: 30,
          })
        ).ok,
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      clockOffsetMs += 35_000;
      const unrelated2 = await host.run(
        repoId,
        {
          kind: "peer-ask",
          toPersonId: "person_carol",
          summary: "Unrelated notice after enabling 30s heartbeat",
          claim: "Only for Carol.",
          requestedAction: "No action for Bob.",
        },
        bobAuth,
      );
      assert.equal(unrelated2.outcome, "applied", JSON.stringify(unrelated2));
      const hbCountAfterEnable = await eventuallyValue(async () => {
        const res = await ceo("history", { cause: "heartbeat" });
        const entries = (res.history ?? []) as unknown[];
        return entries.length > 0 ? entries.length : null;
      }, "30s heartbeat records programmatic check after 0 -> 30 live switch");
      assert.equal(hbCountAfterEnable, 1);

      // Live switch 30 -> 0 while running stops periodic heartbeat checks cleanly.
      assert.equal(
        (
          await ceo("config", {
            runtimeInstanceId: "codex-provider",
            model: "test-model",
            heartbeatIntervalSec: 0,
          })
        ).ok,
        true,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      clockOffsetMs += 65_000;
      const unrelated3 = await host.run(
        repoId,
        {
          kind: "peer-ask",
          toPersonId: "person_carol",
          summary: "Unrelated notice after disabling heartbeat back to 0s",
          claim: "Only for Carol.",
          requestedAction: "No action for Bob.",
        },
        bobAuth,
      );
      assert.equal(unrelated3.outcome, "applied", JSON.stringify(unrelated3));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const hbHistoryAfterDisable = await ceo("history", { cause: "heartbeat" });
      assert.equal((hbHistoryAfterDisable.history as unknown[]).length, hbCountAfterEnable);
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);
