// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { managedRbacSessionStore } from "../src/managed-rbac-service.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { startDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { runFleetReplicaPullClient, runFleetTaskCommandClient, runFleetRuntimeEventClient } from "../src/fleet/edge.ts";
import { OidcSessionService, signInAt } from "./keycloak.fixtures.ts";
import { fleetFixture, git, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { eventuallyValue, spawnCli } from "./fixtures/runtime-ingress.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

// Real provider process, child CLI, edge socket, Fleet TLS, center writer and isolated realm.
// The edge has neither a center admin config nor a center secret.
test(
  "edge execution authenticates child CLI after logout without center configuration",
  { timeout: 120_000 },
  async (t) => {
    let cleanup = async () => {};
    t.after(() => cleanup());
    const live = new Set<string>();
    const f = await fleetFixture(t, ["tasks/task-fleet-fleet"]);
    const loginAuthorityUrl = "https://keycloak.fixture";
    const networkFetch = globalThis.fetch;
    let offline = false;
    t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
      if (offline && String(input).startsWith(f.owners.url)) throw new Error("Isolated Keycloak unavailable");
      return String(input).startsWith(loginAuthorityUrl)
        ? f.owners.keycloak.fetch(input, init)
        : networkFetch(input, init);
    });
    const center = await f.center(undefined, loginAuthorityUrl),
      repoId = f.subject.repoId,
      taskId = f.subject.taskId;
    const edgeRoot = path.join(f.root, "edge"),
      userRoot = path.join(f.root, "edge-user"),
      viewRoot = path.join(f.root, "view");
    const remote = path.join(f.root, "delivery.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "--initial-branch=main");
    git(f.repo, "remote", "add", "origin", remote);
    // Clone the code baseline, before center-authored task publications. The center's
    // compatibility event exports are not an edge ledger activation certificate.
    const codeBaseline = git(f.repo, "log", "--reverse", "--format=%H").split("\n")[1]!;
    git(f.repo, "push", "origin", `${codeBaseline}:refs/heads/main`);
    git(f.root, "clone", remote, edgeRoot);
    git(edgeRoot, "config", "user.name", "Fleet Test");
    git(edgeRoot, "config", "user.email", "fleet@example.invalid");
    const config = {
      schema: "fleet-edge-config/v1",
      host: "127.0.0.1",
      port: center.port,
      caPath: f.certFile,
      servername: "localhost",
      nodeId: f.subject.nodeId,
      credential: "machine-secret",
      repoId,
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
      waitTimeoutMs: 5000,
    };
    const peer = { ...config, ca: f.cert, hostname: config.host };
    writeFileSync(path.join(edgeRoot, "fleet-edge.json"), JSON.stringify(config));
    await runFleetReplicaPullClient({ ...peer, diskQuotaBytes: config.quotaBytes });
    applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    registerBootstrappedDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId,
      mode: "remote-edge",
      userRoot,
      createConvenienceLinks: false,
    });
    const provider = path.join(f.root, "provider.mjs");
    writeProviderExecutable(
      provider,
      `
    import fs from "node:fs"; import path from "node:path";
    if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);
    fs.readFileSync(0, "utf8");
    const id = process.env.HARNESS_ACTOR.split(":").at(-1), root = ${JSON.stringify(f.root)};
    const keys = ["HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT", "HARNESS_ACTOR", "HARNESS_DAEMON_USER_ROOT", "HARNESS_DAEMON_ID", "HARNESS_DAEMON_ENDPOINT", "HARNESS_DAEMON_REPO_ID", "HARNESS_CANONICAL_ROOT", "HARNESS_TASK_BOUND", "HARNESS_DAEMON_RELAY"];
    fs.writeFileSync(path.join(root, id + ".tmp"), JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))), { mode: 0o600 });
    fs.renameSync(path.join(root, id + ".tmp"), path.join(root, id + ".json"));
    console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
    const finish = () => { if (!fs.existsSync(path.join(root, id + ".finish"))) return;
      watcher.close(); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Edge completed after logout." } }));
      console.log(JSON.stringify({ type: "turn.completed" })); };
    const watcher = fs.watch(root, finish); finish();
  `,
    );
    f.owners.keycloak.interactiveSession("person-owner", f.subject.nodeId, loginAuthorityUrl);
    managedRbacSessionStore(userRoot).write(
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: "token-person-owner",
        subject: "person-owner",
        personId: "person-owner",
        expiresAt: Date.now() + 3_600_000,
        roles: [],
        loginTarget: edgeRoot,
      }),
    );
    const daemon = await startDaemon({
      userRoot,
      daemonId: "edge-execution",
      buildSupersessionEnabled: false,
      runtimeDiscover: () => [
        {
          installationId: "edge-install",
          kindId: "codex",
          executablePath: provider,
          version: "fixture",
          observedAt: new Date().toISOString(),
        },
      ],
    });
    assert.ok("stop" in daemon);
    cleanup = async () => {
      for (const runtimeSessionId of live) {
        await requestDaemonJsonRpcAt(
          daemon.endpoint,
          "daemon.fleet.task.run",
          {
            payload: {
              host: config.host,
              port: config.port,
              caPath: config.caPath,
              servername: config.servername,
              nodeId: config.nodeId,
              credential: config.credential,
              repoId,
              viewRoot,
              quotaBytes: config.quotaBytes,
              workspaceRoot: edgeRoot,
              action: { kind: "fleet-runtime", method: "repo.agentRuntime.cancel", payload: { runtimeSessionId } },
            },
          },
          1000,
          30_000,
        );
      }
      await daemon.stop();
    };
    const rpc = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000);
    await eventuallyValue(async () => {
      const status = await rpc("daemon.status", {});
      assert.notEqual(status.ok, false, JSON.stringify(status));
      const row = (status.repos as JsonObject[])?.find((repo) => repo.repoId === repoId);
      assert.notEqual(row?.state, "unavailable", JSON.stringify(status));
      return row?.state === "attached" ? true : null;
    });
    const created = await rpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "edge-worker",
        name: "Edge worker",
        kindId: "codex",
        installationId: "edge-install",
        providerId: "openai",
        models: ["fixture"],
        permissionMode: "workspace-write",
        authMode: "subscription",
      },
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const spawned = await rpc("daemon.fleet.task.run", {
      payload: {
        host: config.host,
        port: config.port,
        caPath: config.caPath,
        servername: config.servername,
        nodeId: config.nodeId,
        credential: config.credential,
        repoId,
        viewRoot,
        quotaBytes: config.quotaBytes,
        workspaceRoot: edgeRoot,
        action: {
          kind: "fleet-runtime",
          method: "repo.agentRuntime.spawn",
          payload: {
            runtimeInstanceId: "edge-worker",
            taskId,
            prompt: "Verify edge credential",
            idempotencyKey: "edge-credential",
          },
        },
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const runtimeId = String(spawned.runtimeSessionId);
    live.add(runtimeId);
    const env = await eventuallyValue(async () =>
      existsSync(path.join(f.root, `${runtimeId}.json`))
        ? (JSON.parse(readFileSync(path.join(f.root, `${runtimeId}.json`), "utf8")) as NodeJS.ProcessEnv)
        : null,
    );
    assert.ok(env.HARNESS_EXECUTION_CREDENTIAL);
    assert.equal(existsSync(path.join(userRoot, "rbac/config.json")), false);
    assert.equal(existsSync(path.join(userRoot, "rbac/center-client-secret")), false);
    const worktree = path.join(edgeRoot, ".worktrees", taskId);
    const cli = async (args: string[]) => {
      const result = await spawnCli(["--root", worktree, "--json", ...args], { ...process.env, ...env });
      assert.ok(result.stdout.trim(), result.stderr);
      return JSON.parse(result.stdout) as JsonObject;
    };
    assert.equal((await cli(["task", "show", taskId])).outcome, "applied");
    const edgeLogout = await rpc("daemon.rbac.manage", { operation: "logout" });
    assert.equal(edgeLogout.ok, true, JSON.stringify(edgeLogout));
    const logout = await new OidcSessionService(path.join(f.root, "user")).logout();
    assert.equal(logout.ok, true, JSON.stringify(logout));
    for (const args of [
      ["task", "show", taskId],
      ["task", "read-set", taskId],
      ["doc", "status", "--task", taskId],
    ]) {
      const result = await cli(args);
      assert.equal(result.outcome, "applied", JSON.stringify(result));
    }
    const progress = await cli(["task", "progress", "append", taskId, "--text", "Edge worker after logout."]);
    assert.equal(progress.outcome, "applied", JSON.stringify(progress));
    const fact = await cli([
      "fact",
      "record",
      "--task",
      taskId,
      "--statement",
      "Edge credential remained valid after logout.",
      "--source",
      "fixture",
      "--confidence",
      "high",
    ]);
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    const artifactBytes = Buffer.from([0, 255, 1, 2]);
    writeFileSync(path.join(worktree, "incoming.bin"), artifactBytes);
    const artifact = await cli([
      "task",
      "artifact",
      "add",
      taskId,
      "--source",
      "incoming.bin",
      "--destination",
      "evidence.bin",
    ]);
    assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));
    assert.deepEqual(
      readFileSync(path.join(f.repo, "harness/tasks/task-fleet-fleet/artifacts/evidence.bin")),
      artifactBytes,
    );
    const wrong = await cli(["task", "show", "task-other"]);
    assert.equal(wrong.code, "execution_credential_rejected", JSON.stringify(wrong));
    const secret = env.HARNESS_EXECUTION_CREDENTIAL!;
    const foreignNode = await runFleetTaskCommandClient({
      ...peer,
      nodeId: "node-slow",
      executionCredential: secret,
      opId: "wrong-node",
      taskId,
      action: { kind: "task-show", taskId },
      waitMs: 0,
    });
    assert.equal(foreignNode.code, "execution_credential_rejected");
    f.owners.keycloak.revoke("person-owner", repoId, ["repository-read"]);
    assert.equal((await cli(["task", "show", taskId])).code, "authorization_denied");
    f.owners.keycloak.permit("person-owner", repoId, ["repository-read"]);
    const client = f.owners.keycloak.nodeClients.get(secret.split(":")[0]!)!;
    client.enabled = false;
    assert.equal((await cli(["task", "show", taskId])).code, "execution_credential_rejected");
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer,
        opId: "revoked-terminal",
        eventType: "runtime_session_exited",
        payload: { runtimeSessionId: runtimeId, exitedAt: new Date().toISOString(), exitCode: 0 },
      }),
      { code: "execution_credential_rejected" },
    );
    client.enabled = true;
    const principal = JSON.parse(client.attributes.harness_execution!);
    client.attributes.harness_execution = JSON.stringify({
      ...principal,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal((await cli(["task", "show", taskId])).code, "execution_credential_rejected");
    client.attributes.harness_execution = JSON.stringify(principal);
    f.setOwner("person-other");
    assert.equal((await cli(["task", "show", taskId])).outcome, "op_rejected");
    f.setOwner("person-owner");
    offline = true;
    assert.equal((await cli(["task", "show", taskId])).outcome, "op_rejected");
    offline = false;
    writeFileSync(
      path.join(edgeRoot, "harness/tasks/task-fleet-fleet/closeout.md"),
      "## Summary\nEdge implementation evidence.\n## Verification\nReal CLI after logout passed.\n## Residual Risk\nFixture only.\n## Same Mechanism Elsewhere\nFleet scopes bind the canonical dispatch.\n",
    );
    const doc = await cli(["doc", "sync", "--submit", "--task", taskId]);
    assert.equal(doc.outcome, "applied", JSON.stringify(doc));
    const unchanged = await cli(["doc", "sync", "--submit", "--task", taskId]);
    assert.equal(unchanged.outcome, "no_changes", JSON.stringify(unchanged));
    const submitted = await cli(["task", "submit", taskId]);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    signInAt(path.join(f.root, "user"), "person-owner");
    const forwarded = await f.host.run(
      repoId,
      {
        kind: "task-adjudicate",
        taskId,
        executionId: f.subject.executionId,
        forward: true,
        reason: "Review the isolated edge delivery.",
      },
      localAuthFixture(),
    );
    assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
    await runFleetReplicaPullClient({ ...peer, diskQuotaBytes: config.quotaBytes });
    applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    const reviewRoot = path.join(f.root, "review-edge"),
      reviewUser = path.join(f.root, "review-user"),
      reviewView = path.join(f.root, "review-view");
    git(f.root, "clone", remote, reviewRoot);
    const reviewConfig = { ...config, nodeId: "node-slow", viewRoot: reviewView };
    const { schema: _schema, ...reviewRoute } = reviewConfig;
    writeFileSync(path.join(reviewRoot, "fleet-edge.json"), JSON.stringify(reviewConfig));
    await runFleetReplicaPullClient({
      ...peer,
      nodeId: "node-slow",
      viewRoot: reviewView,
      diskQuotaBytes: config.quotaBytes,
    });
    applyFleetMirrorCut(reviewView, repoId, reviewRoot, "pull");
    registerBootstrappedDaemonRepo({
      canonicalRoot: reviewRoot,
      repoId,
      mode: "remote-edge",
      userRoot: reviewUser,
      createConvenienceLinks: false,
    });
    f.owners.keycloak.interactiveSession("person-owner", "node-slow", loginAuthorityUrl);
    managedRbacSessionStore(reviewUser).write(
      JSON.stringify({
        schema: "harness-oidc-session/v2",
        accessToken: "token-person-owner",
        subject: "person-owner",
        personId: "person-owner",
        expiresAt: Date.now() + 3_600_000,
        roles: [],
        loginTarget: reviewRoot,
      }),
    );
    const reviewDaemon = await startDaemon({
      userRoot: reviewUser,
      daemonId: "review-execution",
      buildSupersessionEnabled: false,
      runtimeDiscover: () => [
        {
          installationId: "edge-install",
          kindId: "codex",
          executablePath: provider,
          version: "fixture",
          observedAt: new Date().toISOString(),
        },
      ],
    });
    assert.ok("stop" in reviewDaemon);
    const reviewRpc = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(reviewDaemon.endpoint, method, params, 1000, 30_000);
    const reviewLive = new Set<string>(),
      firstCleanup = cleanup;
    cleanup = async () => {
      for (const runtimeSessionId of reviewLive)
        await reviewRpc("daemon.fleet.task.run", {
          payload: {
            ...reviewRoute,
            workspaceRoot: reviewRoot,
            action: { kind: "fleet-runtime", method: "repo.agentRuntime.cancel", payload: { runtimeSessionId } },
          },
        });
      await reviewDaemon.stop();
      await firstCleanup();
    };
    await eventuallyValue(async () => {
      const status = await reviewRpc("daemon.status", {});
      return (status.repos as JsonObject[])?.some((row) => row.state === "attached") ? true : null;
    });
    assert.equal(
      (
        await reviewRpc("daemon.runtimeInstance.create", {
          payload: {
            instanceId: "edge-worker",
            name: "Edge reviewer",
            kindId: "codex",
            installationId: "edge-install",
            providerId: "openai",
            models: ["fixture"],
            permissionMode: "workspace-write",
            authMode: "subscription",
          },
        })
      ).ok,
      true,
    );
    const reviewSpawn = await reviewRpc("daemon.fleet.task.run", {
      payload: {
        ...reviewRoute,
        workspaceRoot: reviewRoot,
        action: {
          kind: "fleet-runtime",
          method: "repo.agentRuntime.spawn",
          payload: {
            runtimeInstanceId: "edge-worker",
            taskId,
            role: "reviewer",
            cwd: { scope: "repo-root" },
            prompt: "Review the submitted cut.",
            idempotencyKey: "edge-review",
          },
        },
      },
    });
    assert.equal(reviewSpawn.outcome, "applied", JSON.stringify(reviewSpawn));
    const reviewRuntime = String(reviewSpawn.runtimeSessionId),
      reviewDispatch = String(reviewSpawn.dispatchId);
    reviewLive.add(reviewRuntime);
    const reviewEnv = await eventuallyValue(async () =>
      existsSync(path.join(f.root, `${reviewRuntime}.json`))
        ? (JSON.parse(readFileSync(path.join(f.root, `${reviewRuntime}.json`), "utf8")) as NodeJS.ProcessEnv)
        : null,
    );
    assert.notEqual(reviewEnv.HARNESS_EXECUTION_CREDENTIAL, secret);
    assert.equal(existsSync(path.join(reviewUser, "rbac/config.json")), false);
    assert.equal((await reviewRpc("daemon.rbac.manage", { operation: "logout" })).ok, true);
    await new OidcSessionService(path.join(f.root, "user")).logout();
    const reviewCli = async (args: string[]) => {
      const result = await spawnCli(["--root", reviewRoot, "--json", ...args], { ...process.env, ...reviewEnv });
      assert.ok(result.stdout.trim(), result.stderr);
      return JSON.parse(result.stdout) as JsonObject;
    };
    assert.equal((await reviewCli(["task", "show", taskId])).outcome, "applied");
    for (const [nodeId, executionCredential] of [
      ["node-slow", secret],
      [config.nodeId, reviewEnv.HARNESS_EXECUTION_CREDENTIAL!],
    ]) {
      const crossed = await runFleetTaskCommandClient({
        ...peer,
        nodeId,
        executionCredential,
        opId: `crossed-${nodeId}`,
        taskId,
        action: { kind: "task-show", taskId },
        waitMs: 0,
      });
      assert.equal(crossed.code, "execution_credential_rejected");
    }
    assert.equal(
      (await reviewCli(["task", "progress", "append", taskId, "--text", "Not a reviewer action."])).code,
      "execution_credential_rejected",
    );
    const reportDir = path.join(reviewRoot, "harness/tasks/task-fleet-fleet/artifacts/reports");
    mkdirSync(reportDir, { recursive: true });
    const packet = `harness/tasks/task-fleet-fleet/artifacts/reports/${reviewDispatch}.json`;
    writeFileSync(
      path.join(reviewRoot, packet),
      JSON.stringify({ verdict: "approved", reason: "Verified edge execution.", evidenceChecked: ["CLI receipts"] }),
    );
    writeFileSync(
      path.join(reportDir, `${reviewDispatch}.md`),
      "# Review\n\nVerified edge execution and its bounded CLI receipts.\n",
    );
    const wrongReport = await reviewCli([
      "task",
      "review-execution",
      taskId,
      "--execution-id",
      f.subject.executionId,
      "--review-id",
      "review-other",
      "--from-file",
      packet,
    ]);
    assert.equal(wrongReport.code, "execution_credential_rejected", JSON.stringify(wrongReport));
    const reviewed = await reviewCli([
      "task",
      "review-execution",
      taskId,
      "--execution-id",
      f.subject.executionId,
      "--review-id",
      `review-${reviewDispatch}`,
      "--from-file",
      packet,
    ]);
    assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
    const consent = await reviewCli([
      "task",
      "review-consent",
      taskId,
      "--execution-id",
      f.subject.executionId,
      "--review-id",
      `review-${reviewDispatch}`,
    ]);
    assert.equal(consent.code, "execution_credential_rejected", JSON.stringify(consent));
    writeFileSync(path.join(f.root, `${reviewRuntime}.finish`), "finish");
    const reviewSettled = await eventuallyValue(async () => {
      const result = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: reviewRuntime },
        f.auth,
      );
      return result.session.activity.outcome ? result.session : null;
    });
    assert.equal(reviewSettled.activity.outcome, "succeeded", JSON.stringify(f.runtimeArchiveReceipts));
    reviewLive.delete(reviewRuntime);
    writeFileSync(path.join(f.root, `${runtimeId}.finish`), "finish");
    const settled = await eventuallyValue(async () => {
      const result = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: runtimeId },
        f.auth,
      );
      return result.session.activity.outcome ? result.session : null;
    });
    assert.equal(settled.liveness, "exited");
    assert.equal(settled.activity.outcome, "succeeded", JSON.stringify(f.runtimeArchiveReceipts));
    live.delete(runtimeId);
    signInAt(path.join(f.root, "user"), "person-owner");
    const after = await cli(["task", "show", taskId]);
    assert.equal(after.code, "execution_credential_rejected", JSON.stringify(after));
  },
);
