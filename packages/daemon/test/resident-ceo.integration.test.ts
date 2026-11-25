// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";
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
