// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeerRequestV1 } from "@harness-anything/kernel/internal/domain/peer-collaboration.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { eventuallyValue, initIngressRepo, rpc, writeProviderStub } from "./fixtures/runtime-ingress.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
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
      const senderView = evidence(
        await host.run(repoId, { kind: "peer-watch", once: true, replyTo: request.requestId }, auth),
      ) as { request: PeerRequestV1 };
      assert.equal(senderView.request.state, "ANSWERED");
      assert.equal(
        senderView.request.reply?.structuredBody.claim,
        "The recipient's resident CEO processed this request.",
      );
    } finally {
      await host.close();
      removeTempRepository(parent);
    }
  },
);
