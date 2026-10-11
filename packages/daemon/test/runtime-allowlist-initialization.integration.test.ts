// harness-test-tier: integration
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { rpc } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveRuntimeInstanceCandidates } from "../src/runtime-spawn-mission.ts";

test("runtime dispatch does not initialize a missing repository allowlist", () => {
  assert.throws(
    () =>
      resolveRuntimeInstanceCandidates({
        requested: "codex-api",
        agent: null,
        instances: [
          {
            instanceId: "codex-api",
            kindId: "codex",
            providerId: "openai",
            models: ["test-model"],
            enabled: true,
            authReadiness: { status: "ready", code: null, hint: null },
          } as never,
        ],
        sessions: [],
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "runtime_instance_allowlist_uninitialized" &&
      /ha init|repository settings/u.test(error.message),
  );
});

test("project A admits codex-api while project B refuses it without changing either project setting", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-projects-")),
    userRoot = path.join(parent, "user"),
    uid = process.getuid?.() ?? 0,
    auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
    } as const,
    installation = {
      installationId: "installation-projects",
      kindId: "codex" as const,
      executablePath: writeProviderExecutable(path.join(parent, "provider.mjs"), "process.exit(0);\n"),
      version: "1.0.0",
      observedAt: "2026-10-11T00:00:00.000Z",
    };
  openRuntimeInstanceStore({ userRoot, discover: () => [installation] }).create({
    schemaVersion: 2,
    instanceId: "codex-api",
    name: "Codex API",
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: ["test-model"],
    defaultModel: "test-model",
    enabled: true,
    codex: {},
    auth: { mode: "subscription" },
  });
  signInPolicyTestUser(userRoot, "owner", ["project-a", "project-b"], "admin");
  for (const repoId of ["project-a", "project-b"]) {
    const rootDir = path.join(parent, repoId);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Project Test"],
      ["config", "user.email", "project@example.invalid"],
      ["commit", "--allow-empty", "-qm", "base"],
    ])
      execFileSync("git", args, { cwd: rootDir });
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\n" +
        (repoId === "project-b" ? "settings:\n  runtime:\n    allowedInstances: []\n" : ""),
    );
    registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  }
  let launches = 0;
  const host = await openDaemonHost({
    daemonId: "runtime-projects",
    userRoot,
    runtimeDiscover: () => [installation],
    runtimeLaunch: () => {
      launches += 1;
      return {
        pid: 9911,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      };
    },
  });
  try {
    await host.attachmentsSettled();
    const read = (repoId: string) => host.read(repoId, "repo.settings.read", {}, auth),
      beforeA = await read("project-a"),
      beforeB = await read("project-b"),
      payload = {
        runtimeInstanceId: "codex-api",
        prompt: "Project isolation",
        taskId: null,
        cwd: { scope: "repo-root" },
      },
      accepted = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId: "project-a" },
        payload: { ...payload, idempotencyKey: "project-a" },
      }),
      rejected = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId: "project-b" },
        payload: { ...payload, idempotencyKey: "project-b" },
      });
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(rejected.code, "runtime_instance_not_allowed", JSON.stringify(rejected));
    assert.match(
      String(rejected.rejectionExplanation),
      /codex-api.*not allowed[\s\S]*Allowed instances: none[\s\S]*ha settings update/u,
    );
    assert.doesNotMatch(JSON.stringify(rejected), /Sign in with Keycloak/u);
    assert.equal(launches, 1);
    assert.deepEqual((await read("project-a")).lastChanged, beforeA.lastChanged);
    assert.deepEqual((await read("project-b")).lastChanged, beforeB.lastChanged);
    assert.deepEqual(beforeA.settings.runtime?.allowedInstances, ["codex-api"]);
    assert.deepEqual(beforeB.settings.runtime?.allowedInstances, []);
    t.diagnostic(`project-b-rejection ${JSON.stringify(rejected)}`);
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
