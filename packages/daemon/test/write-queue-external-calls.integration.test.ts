// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { credentialPort, runCredentialCommand } from "../src/agent-runtime-credential-port.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

// Each test injects one external command that never answers until the test releases it (or deletes its
// directory), then proves an unrelated write to the same repository is still accepted.
const binding = withPolicyGroup(
  { actor: { principal: { personId: "person-write-queue" }, executor: null }, source: "local" as const },
  "contributor",
);

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, `${path.basename(file)} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Waits settle on the receipts production itself bounds (the write-queue timeouts under test);
// the runner's per-file timeout is the last resort if one of those bounds is ever lost.

test(
  "task submit never waits for GitHub and retries preserve one submitted cut",
  { skip: process.platform === "win32" ? "requires POSIX shell-script executables resolved through PATH" : false },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-submit-no-ci-read-")),
      rootDir = path.join(parent, "repo"),
      stubDir = path.join(parent, "bin"),
      invoked = path.join(parent, "gh.invoked"),
      originalPath = process.env.PATH,
      repoId = workspaceId("submit-no-ci-read"),
      taskId = "task-submit-no-ci-read",
      executionId = "execution-submit-no-ci-read";
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      mkdirSync(rootDir);
      mkdirSync(stubDir);
      writeFileSync(path.join(stubDir, "gh"), `#!/bin/sh\n: > '${invoked}'\nsleep 1\nprintf '[]\\n'\n`, {
        mode: 0o755,
      });
      initRepo(rootDir);
      mkdirSync(path.join(rootDir, "harness"), { recursive: true });
      writeFileSync(
        path.join(rootDir, "harness/harness.yaml"),
        "settings:\n" +
          "  ci:\n" +
          "    workflows: [rewrite-ci]\n" +
          "  gates:\n" +
          "    ci:\n" +
          "      appliesTo: code\n" +
          "      adapter: github-actions\n" +
          "      branch: main\n" +
          "      event: push\n" +
          "      coverage: descendant\n" +
          "      selection: newest\n",
      );
      process.env.PATH = `${stubDir}${path.delimiter}${originalPath ?? ""}`;
      cell = await openRepoCell({
        repoId,
        rootDir: canonicalRoot(rootDir),
        ownerId: "submit-no-ci-read-center",
        now: () => "2026-09-20T02:00:00.000Z",
      });
      const created = await cell.run({ kind: "task-create", taskId, title: "Submit without CI read" }, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      const packagePath = String((created as { readonly packagePath?: unknown }).packagePath);
      await realizeTaskPlanFixture(
        rootDir,
        packagePath,
        (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Submit without CI read",
      );
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
      const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
      writeFileSync(path.join(deliveryRoot, "README.md"), "# Submit without CI read\n");
      git(deliveryRoot, "add", "README.md");
      git(deliveryRoot, "commit", "-qm", "test: add submit delivery");
      const closeoutPath = `${packagePath}/closeout.md`,
        commitSha = git(deliveryRoot, "rev-parse", "HEAD"),
        closeout = (claim: string) =>
          `# Closeout\n\n## Summary\n\n${claim}\n\n` +
          "## Verification\n\nThe isolated integration test verifies submit latency and event identity.\n\n" +
          "## Residual Risk\n\nNone.\n\n" +
          "## Same Mechanism Elsewhere\n\nGitHub observations remain an independent write path.\n";
      writeFileSync(path.join(rootDir, "harness", closeoutPath), closeout("Initial delivery."));
      assert.equal((await cell.run({ kind: "doc-submit", paths: [closeoutPath] }, binding)).outcome, "applied");

      const startedAt = performance.now(),
        submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding),
        elapsedMs = performance.now() - startedAt;
      // Elapsed time is reported, not asserted: the gh stub leaving no marker is the proof that
      // submit made no external call, and a wall-clock bound only measured the runner's load.
      t.diagnostic(`task-submit elapsed ${elapsedMs.toFixed(1)}ms`);
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      assert.equal(existsSync(invoked), false, "task submit must not invoke gh");

      const repeated = await cell.run({ kind: "task-submit", taskId, executionId }, binding),
        events = () =>
          makeTaskEventReader({ repoId, rootDir })
            .read()
            .events.filter((event) => event.type === "execution_submitted" && event.taskId === taskId);
      assert.equal(repeated.outcome, "applied", JSON.stringify(repeated));
      assert.equal(repeated.opId, submitted.opId);
      assert.equal(events().length, 1, "an identical retry must not append another submission event");
      assert.equal(events()[0]?.payload.execution.executionId, executionId);
      assert.equal(events()[0]?.payload.execution.submission?.commitSha, commitSha);
      assert.equal(existsSync(invoked), false, "a submit retry must not invoke gh");

      writeFileSync(path.join(rootDir, "harness", closeoutPath), closeout("Changed delivery."));
      const changed = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
      assert.equal(changed.outcome, "op_rejected", JSON.stringify(changed));
      assert.equal(changed.code, "invalid_transition", JSON.stringify(changed));
      assert.match(JSON.stringify(changed.next), /task submit --amend/u);
      assert.equal(events().length, 1, "a changed bare retry must not append another submission event");
      assert.equal(existsSync(invoked), false, "a changed submit retry must not invoke gh");
    } finally {
      process.env.PATH = originalPath;
      await cell?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test("a Keycloak authorization that never answers times out and releases the repository write queue", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-keycloak-hang-")),
    rootDir = path.join(parent, "repo"),
    // A Keycloak that accepts the connection and never answers, like a wedged reverse proxy.
    hanging = createServer(() => {});
  let connections = 0;
  let closedConnections = 0;
  hanging.on("connection", (socket) => {
    connections += 1;
    socket.once("close", () => {
      closedConnections += 1;
    });
  });
  await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const hangUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`,
    authorized = withPolicyGroup(
      { actor: { principal: { personId: "person-keycloak-hang" }, executor: null }, source: "local" as const },
      "contributor",
    ),
    hungBinding = {
      ...authorized,
      keycloakAuthorization: {
        session: { ...authorized.keycloakAuthorization.session, url: hangUrl },
        center: { ...authorized.keycloakAuthorization.center, url: hangUrl },
      },
    };
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    mkdirSync(rootDir);
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("keycloak-hang"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "keycloak-hang-center",
      now: () => "2026-09-11T02:00:00.000Z",
    });
    const write = cell.run(
      { kind: "task-create", taskId: "keycloak-hang-write", title: "Hanging authorization" },
      hungBinding,
    );
    // The production timeout — the 10s abort inside the write queue — is what settles this receipt,
    // so awaiting it asserts the timeout behavior without racing a second clock against it.
    const receipt = await write;
    assert.ok(connections >= 1, "the authorization never reached the hanging Keycloak");
    assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
    assert.equal(receipt.code, "service_rejected", JSON.stringify(receipt));
    // The abort that failed the write destroys the socket before the fetch rejects, so the close
    // has already reached this process; one loop turn lets its event dispatch before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(closedConnections >= 1, "the Keycloak request was not aborted");
    const after = await cell.run(
      { kind: "task-create", taskId: "keycloak-after-hang", title: "After the timeout" },
      binding,
    );
    assert.equal(after.outcome, "applied", JSON.stringify(after));
  } finally {
    hanging.closeAllConnections();
    hanging.close();
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

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
    // The write queues while the credential lookup is still unanswered: the injected lookup
    // timeout bounds the spawn, the failed spawn releases the queue, and the write settles
    // causally — whenever that happens — instead of inside a wall-clock window.
    const write = cell.run(
      { kind: "task-create", taskId: "credential-concurrent-write", title: "Concurrent write" },
      binding,
    );
    const settled = await spawned;
    assert.ok("error" in settled, JSON.stringify(settled));
    assert.equal((settled.error as { readonly code?: unknown }).code, "runtime_credential_unavailable");
    const accepted = await write;
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  } finally {
    writeFileSync(release, "");
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
