// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { credentialPort, runCredentialCommand } from "../src/agent-runtime-credential-port.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

// Each test injects one external command that never answers until the test releases it (or deletes its
// directory), then proves an unrelated write to the same repository is still accepted.
const binding = withRoleBinding(
  { actor: { principal: { personId: "person-write-queue" }, executor: null }, source: "local" as const },
  "repo-write",
);

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, `${path.basename(file)} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settlesWithin<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "ci observe pull does not hold the repository write queue while gh hangs",
  { skip: process.platform === "win32" ? "requires POSIX shell-script executables resolved through PATH" : false },
  async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ci-pull-queue-")),
      rootDir = path.join(parent, "repo"),
      stubDir = path.join(parent, "bin"),
      started = path.join(parent, "gh.started"),
      release = path.join(parent, "gh.release"),
      originalPath = process.env.PATH;
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      mkdirSync(rootDir);
      mkdirSync(stubDir);
      writeFileSync(
        path.join(stubDir, "gh"),
        `#!/bin/sh\n: > '${started}'\nwhile [ -d '${parent}' ] && [ ! -f '${release}' ]; do sleep 0.05; done\nexit 1\n`,
        { mode: 0o755 },
      );
      initRepo(rootDir);
      // An explicit witness list keeps `ci observe pull` invoking gh; the default now witnesses nothing.
      mkdirSync(path.join(rootDir, "harness"), { recursive: true });
      writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n");
      // The writer thread copies the environment when it starts, so the stub goes on PATH first.
      process.env.PATH = `${stubDir}${path.delimiter}${originalPath ?? ""}`;
      cell = await openRepoCell({
        repoId: workspaceId("ci-pull-queue"),
        rootDir: canonicalRoot(rootDir),
        ownerId: "ci-pull-queue-center",
        now: () => "2026-09-11T02:00:00.000Z",
      });
      const pulling = cell.run({ kind: "ci-observe-pull", limit: 1 }, binding);
      await waitForFile(started);
      const write = await settlesWithin(
        cell.run({ kind: "task-create", taskId: "ci-pull-concurrent-write", title: "Concurrent write" }, binding),
        5_000,
        "a concurrent write waited on the hanging gh",
      );
      assert.equal(write.outcome, "applied", JSON.stringify(write));
      writeFileSync(release, "");
      const pulled = await pulling;
      assert.equal(pulled.outcome, "op_rejected", JSON.stringify(pulled));
    } finally {
      writeFileSync(release, "");
      process.env.PATH = originalPath;
      await cell?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("a credential lookup nobody answers fails the spawn and releases the repository write queue", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-credential-queue-")),
    rootDir = path.join(parent, "repo"),
    started = path.join(parent, "vault.started"),
    release = path.join(parent, "vault.release"),
    installation: RuntimeInstallationWitness = {
      installationId: "codex-credential-queue-installation",
      kindId: "codex",
      executablePath: "/opt/witnessed/codex-credential-queue",
      version: "1.0.0",
      observedAt: "2026-09-11T00:00:00.000Z",
    },
    // The native vault command is replaced by a process that never answers, like a keychain unlock dialog.
    vault = credentialPort(
      process.platform,
      (command, timeoutMs) =>
        runCredentialCommand(
          {
            ...command,
            file: process.execPath,
            args: [
              "-e",
              `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "");` +
                `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(1); }, 50);`,
            ],
          },
          timeoutMs,
        ),
      300,
    ),
    instances = openRuntimeInstanceStore({
      userRoot: path.join(parent, "user"),
      discover: () => [installation],
      resolveCredential: vault.resolve,
    });
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    mkdirSync(rootDir);
    initRepo(rootDir);
    instances.create({
      schemaVersion: 2,
      instanceId: "codex-credential-queue",
      name: "Codex Credential Queue",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "read-only",
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:credential-queue" },
    });
    cell = await openRepoCell({
      repoId: workspaceId("credential-queue"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "credential-queue-center",
      now: () => "2026-09-11T02:00:00.000Z",
      runtimeDaemonRoute: {
        userRoot: path.join(parent, "daemon-user"),
        daemonId: "credential-queue",
        endpoint: path.join(parent, "daemon.sock"),
      },
      runtimeInstances: instances.listPublic,
      prepareRuntimeLaunch: instances.prepareLaunch,
      runtimeLaunch: () => {
        throw new Error("a runtime must not launch without its credential");
      },
    });
    const spawning = cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-credential-queue",
        cwd: { scope: "repo-root" },
        prompt: "Needs the unanswered credential",
        taskId: null,
        idempotencyKey: "credential-queue-spawn",
      },
      binding,
    );
    const spawned = spawning.then(
      (receipt) => ({ receipt }),
      (error: unknown) => ({ error }),
    );
    await waitForFile(started);
    const write = await settlesWithin(
      cell.run({ kind: "task-create", taskId: "credential-concurrent-write", title: "Concurrent write" }, binding),
      5_000,
      "a concurrent write waited on the unanswered credential lookup",
    );
    assert.equal(write.outcome, "applied", JSON.stringify(write));
    const settled = await spawned;
    assert.ok("error" in settled, JSON.stringify(settled));
    assert.equal((settled.error as { readonly code?: unknown }).code, "runtime_credential_unavailable");
  } finally {
    writeFileSync(release, "");
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
