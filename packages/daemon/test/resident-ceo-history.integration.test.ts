// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ResidentCeoHistoryEntry } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { openDaemonJsonRpcClientAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { interactiveRpcDescriptor } from "../src/daemon-host/protocol/client-rpc.ts";
import { parseClientRpcResponse } from "../src/daemon-host/protocol/daemon-result-validation.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { eventuallyValue, initIngressRepo, rpc, writeProviderStub } from "./fixtures/runtime-ingress.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";

test("parseClientRpcResponse validates all 9 repo.residentCeo.* methods without command-receipt/v2 drift", () => {
  const methods = [
    "repo.residentCeo.config",
    "repo.residentCeo.start",
    "repo.residentCeo.stop",
    "repo.residentCeo.status",
    "repo.residentCeo.chat",
    "repo.residentCeo.history",
    "repo.residentCeo.proposals",
    "repo.residentCeo.approve",
    "repo.residentCeo.reject",
  ] as const;

  for (const method of methods) {
    assert.ok(interactiveRpcDescriptor(method), `${method} must be exposed on interactiveRpcDescriptor for GUI`);
  }

  const phase1Profile = {
    schema: "resident-ceo-profile/v1",
    principalPersonId: "person_bob",
    runtimeInstanceId: "codex-provider",
    model: "test-model",
    heartbeatIntervalSec: 300,
    persistentSessionId: null,
    status: "running",
    lastWake: null,
    updatedAt: "2026-11-27T00:00:00.000Z",
  };
  const phase3Profile = {
    ...phase1Profile,
    repoId: "resident-ceo-history-test",
    executionPolicy: "approval-gated",
    defaultWorkId: "task_work_1",
    defaultAgentId: "neon",
    autoApproveSenders: ["person_alice"],
    approvalGate: { mode: "auto-promote", providerId: "decider-1", minConfidence: 0.85 },
    proposals: [],
    history: [],
    futureAdditiveField: "tolerated",
  };

  assert.doesNotThrow(() =>
    parseClientRpcResponse("repo.residentCeo.status", { ok: true, profile: phase1Profile, summary: "running" }),
  );
  assert.doesNotThrow(() =>
    parseClientRpcResponse("repo.residentCeo.status", { ok: true, profile: phase3Profile, summary: "running" }),
  );
  assert.doesNotThrow(() =>
    parseClientRpcResponse("repo.residentCeo.status", { ok: true, profile: null, summary: "not configured" }),
  );
  assert.doesNotThrow(() =>
    parseClientRpcResponse("repo.residentCeo.chat", {
      ok: true,
      profile: phase3Profile,
      summary: "reply",
      response: "reply",
    }),
  );
  assert.doesNotThrow(() =>
    parseClientRpcResponse("repo.residentCeo.proposals", {
      ok: true,
      profile: phase3Profile,
      summary: "none",
      proposals: [],
    }),
  );
  assert.doesNotThrow(() =>
    parseClientRpcResponse("repo.residentCeo.history", {
      ok: true,
      profile: phase3Profile,
      summary: "1 entry",
      history: [
        {
          wakeId: "wake-1",
          cause: "human-chat",
          requestedAt: "2026-11-27T00:00:00.000Z",
          completedAt: "2026-11-27T00:00:02.000Z",
          status: "succeeded",
          runtimeSessionId: "session-1",
          requestText: "hello",
          responseText: "world",
          detail: null,
        },
      ],
    }),
  );
  assert.throws(
    () => parseClientRpcResponse("repo.residentCeo.status", { ok: true, profile: "invalid" }),
    /resident-ceo-profile\/v1/u,
  );
});

test(
  "repo.residentCeo.history persists peer-request and human-chat turns across daemon restart",
  { timeout: 120_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-history-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const argsPath = path.join(parent, "provider-args.json");
    const repoId = "resident-ceo-history-test";
    const installation = {
      installationId: "resident-ceo-history-codex",
      kindId: "codex" as const,
      executablePath: writeProviderStub(path.join(parent, "codex.mjs"), "codex", argsPath),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_alice", [repoId], "admin");

    const firstHost = await openDaemonHost({ daemonId: repoId, userRoot, runtimeDiscover: () => [installation] });
    try {
      await firstHost.attachmentsSettled();
      await registerFixtureRuntimeInstance(firstHost, repoId, auth, {
        instanceId: "codex-provider",
        name: "Resident CEO History Codex fixture",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["test-model"],
        authMode: "subscription",
        codex: {},
      });

      const delegated = await firstHost.run(
        repoId,
        {
          kind: "peer-ask",
          requestKind: "delegate",
          toPersonId: "person_bob",
          summary: "Audit deployment checklist",
          claim: "Check release gates before shipping.",
          requestedAction: "Review and summarize blockers.",
        },
        auth,
      );
      assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));

      signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");
      const bobAuth = {
        ...auth,
        oidcPrincipal: await firstHost.sessionPrincipal(auth, "repo.residentCeo.status", {
          repo: { repoId },
          payload: {},
        }),
      };
      const ceo = (operation: string, payload: Record<string, unknown> = {}) =>
        rpc(firstHost, bobAuth, `repo.residentCeo.${operation}`, { repo: { repoId }, payload });

      assert.equal(
        (
          await ceo("config", {
            runtimeInstanceId: "codex-provider",
            model: "test-model",
            heartbeatIntervalSec: 300,
          })
        ).ok,
        true,
      );
      assert.equal((await ceo("start")).ok, true);

      await eventuallyValue(async () => {
        const status = await ceo("status");
        const profile = status.profile as { readonly lastWake: { readonly status: string } | null } | null;
        assert.notEqual(profile?.lastWake?.status, "failed", JSON.stringify(profile?.lastWake));
        return profile?.lastWake?.status === "succeeded" ? profile : null;
      }, "peer-request wake settles into persisted history");

      const firstChat = await ceo("chat", { message: "First human question" });
      assert.equal(firstChat.ok, true, JSON.stringify(firstChat));
      const secondChat = await ceo("chat", { message: "Second human follow-up" });
      assert.equal(secondChat.ok, true, JSON.stringify(secondChat));

      const beforeRestart = await ceo("history", {});
      assert.equal(beforeRestart.ok, true, JSON.stringify(beforeRestart));
      assert.doesNotThrow(() => parseClientRpcResponse("repo.residentCeo.history", beforeRestart));
      const entries = beforeRestart.history as readonly ResidentCeoHistoryEntry[];
      assert.equal(entries.length, 3, JSON.stringify(entries));
      assert.equal(entries[0]?.cause, "peer-request");
      assert.equal(entries[0]?.fromPersonId, "person_alice");
      assert.equal(entries[0]?.peerSummary, "Audit deployment checklist");
      assert.equal(entries[0]?.responseText, "codex final result");
      assert.equal(entries[1]?.cause, "human-chat");
      assert.equal(entries[1]?.requestText, "First human question");
      assert.equal(entries[1]?.responseText, "codex final result");
      assert.equal(entries[2]?.cause, "human-chat");
      assert.equal(entries[2]?.requestText, "Second human follow-up");

      const onlyChats = await ceo("history", { cause: "human-chat", limit: 1 });
      assert.equal(onlyChats.ok, true, JSON.stringify(onlyChats));
      const limited = onlyChats.history as readonly ResidentCeoHistoryEntry[];
      assert.equal(limited.length, 1);
      assert.equal(limited[0]?.requestText, "Second human follow-up");
    } finally {
      await firstHost.close();
    }

    // Reopen daemon host to verify history survives restart durably on disk.
    const restartedHost = await openDaemonHost({ daemonId: repoId, userRoot, runtimeDiscover: () => [installation] });
    try {
      await restartedHost.attachmentsSettled();
      const bobAuth = {
        ...auth,
        oidcPrincipal: await restartedHost.sessionPrincipal(auth, "repo.residentCeo.history", {
          repo: { repoId },
          payload: {},
        }),
      };
      const afterRestart = await rpc(restartedHost, bobAuth, "repo.residentCeo.history", {
        repo: { repoId },
        payload: {},
      });
      assert.equal(afterRestart.ok, true, JSON.stringify(afterRestart));
      const persisted = afterRestart.history as readonly ResidentCeoHistoryEntry[];
      assert.equal(persisted.length, 3, JSON.stringify(persisted));
      assert.deepEqual(
        persisted.map((entry) => entry.cause),
        ["peer-request", "human-chat", "human-chat"],
      );
      assert.equal(persisted[0]?.fromPersonId, "person_alice");
      assert.equal(persisted[2]?.requestText, "Second human follow-up");
    } finally {
      await restartedHost.close();
      removeTempRepository(parent);
    }
  },
);

test(
  "concurrent repo.tasks.list and repo.residentCeo.status complete promptly while repo.residentCeo.chat is in flight",
  { timeout: 120_000 },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-resident-ceo-concurrency-"));
    const rootDir = path.join(parent, "repo");
    const userRoot = path.join(parent, "user");
    const repoId = "resident-ceo-concurrency-test";
    const installation = {
      installationId: "resident-ceo-slow-codex",
      kindId: "codex" as const,
      executablePath: writeProviderStub(path.join(parent, "slow-codex.mjs"), "codex", undefined, 700),
      version: "codex-cli 0.159.1",
      observedAt: new Date().toISOString(),
    };
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
    signInPolicyTestUser(userRoot, "person_bob", [repoId], "admin");

    const daemon = await startDaemon({
      daemonId: repoId,
      userRoot,
      runtimeDiscover: () => [installation],
      buildSupersessionEnabled: false,
    });
    assert.ok("stop" in daemon, "expected fresh daemon instance");
    const client = await openDaemonJsonRpcClientAt(daemon.endpoint, 5_000, 30_000);
    try {
      await eventuallyValue(async () => {
        const status = await client.request("daemon.status", {}, 10_000);
        const repos = Array.isArray(status.repos) ? (status.repos as readonly Record<string, unknown>[]) : [];
        return repos.some((entry) => entry.repoId === repoId && entry.state === "attached") ? true : null;
      }, "daemon repo attached");

      const registeredInstance = await client.request(
        "daemon.runtimeInstance.create",
        {
          repo: { repoId },
          payload: {
            instanceId: "codex-slow",
            name: "Slow Codex fixture",
            kindId: "codex",
            installationId: installation.installationId,
            providerId: "openai",
            models: ["test-model"],
            authMode: "subscription",
            codex: {},
          },
        },
        10_000,
      );
      assert.equal(registeredInstance.ok, true, JSON.stringify(registeredInstance));

      assert.equal(
        (
          await client.request(
            "repo.residentCeo.config",
            {
              repo: { repoId },
              payload: {
                runtimeInstanceId: "codex-slow",
                model: "test-model",
                heartbeatIntervalSec: 300,
              },
            },
            10_000,
          )
        ).ok,
        true,
      );
      assert.equal(
        (await client.request("repo.residentCeo.start", { repo: { repoId }, payload: {} }, 10_000)).ok,
        true,
      );

      // Issue a slow repo.residentCeo.chat (~2.5s) and immediately issue concurrent reads on the
      // SAME multiplexed connection while the LLM turn is in flight.
      let chatSettled = false;
      const chatPromise = client
        .request("repo.residentCeo.chat", { repo: { repoId }, payload: { message: "Take your time" } }, 30_000)
        .finally(() => {
          chatSettled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const [tasksList, ceoStatus, ceoHistory] = await Promise.all([
        client.request("repo.tasks.list", { repo: { repoId }, payload: {} }, 5_000),
        client.request("repo.residentCeo.status", { repo: { repoId }, payload: {} }, 5_000),
        client.request("repo.residentCeo.history", { repo: { repoId }, payload: {} }, 5_000),
      ]);

      assert.equal(tasksList.ok, true, JSON.stringify(tasksList));
      assert.equal(ceoStatus.ok, true, JSON.stringify(ceoStatus));
      assert.equal(ceoHistory.ok, true, JSON.stringify(ceoHistory));
      assert.equal(chatSettled, false, "concurrent reads must complete while repo.residentCeo.chat is still in flight");

      const chatResult = await chatPromise;
      assert.equal(chatResult.ok, true, JSON.stringify(chatResult));
      assert.equal(chatResult.response, "codex final result");
    } finally {
      client.close();
      await daemon.stop();
      removeTempRepository(parent);
    }
  },
);
