// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { readRuntimeExecutionPrincipal } from "../src/runtime-execution-principal-store.ts";
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
    const center = await f.center(undefined, loginAuthorityUrl, (auth) =>
        new OidcSessionService(path.join(f.root, "user")).bind(auth),
      ),
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
    const daemonOptions = {
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
    };
    let daemon = await startDaemon(daemonOptions);
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
    assert.equal(
      readRuntimeExecutionPrincipal(edgeRoot, env.HARNESS_EXECUTION_CREDENTIAL)?.personId,
      "person-owner",
      JSON.stringify(readDispatchStream(edgeRoot, String(spawned.dispatchId))?.records),
    );
    const executionPrincipalRecord = readDispatchStream(edgeRoot, String(spawned.dispatchId))?.records.find(
      (record) => record.kind === "execution_principal",
    );
    assert.equal(typeof executionPrincipalRecord?.grantFingerprint, "string");
    assert.equal(JSON.stringify(executionPrincipalRecord).includes(env.HARNESS_EXECUTION_CREDENTIAL), false);
    assert.equal(
      readRuntimeExecutionPrincipal(edgeRoot, env.HARNESS_EXECUTION_CREDENTIAL, Number.MAX_SAFE_INTEGER),
      null,
    );
    assert.equal(existsSync(path.join(userRoot, "rbac/config.json")), false);
    assert.equal(existsSync(path.join(userRoot, "rbac/center-client-secret")), false);
    const worktree = path.join(edgeRoot, ".worktrees", taskId);
    const cli = async (args: string[]) => {
      const result = await spawnCli(["--root", worktree, "--json", ...args], { ...process.env, ...env });
      assert.ok(result.stdout.trim(), result.stderr);
      return JSON.parse(result.stdout) as JsonObject;
    };
    await runFleetReplicaPullClient({ ...peer, diskQuotaBytes: config.quotaBytes });
    applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    const initialLocalRead = await cli(["task", "show", taskId]);
    assert.equal(initialLocalRead.outcome, "applied", JSON.stringify(initialLocalRead));
    const edgeLogout = await rpc("daemon.rbac.manage", { operation: "logout" });
    assert.equal(edgeLogout.ok, true, JSON.stringify(edgeLogout));
    const logout = await new OidcSessionService(path.join(f.root, "user")).logout();
    assert.equal(logout.ok, true, JSON.stringify(logout));
    await daemon.stop();
    daemon = await startDaemon(daemonOptions);
    assert.ok("stop" in daemon);
    for (const args of [
      ["task", "show", taskId],
      ["task", "read-set", taskId],
      ["doc", "status", "--task", taskId],
    ]) {
      const result = await cli(args);
      assert.equal(result.outcome, "applied", JSON.stringify(result));
    }
    const unknownCredential = await spawnCli(["--root", worktree, "--json", "task", "show", taskId], {
      ...process.env,
      ...env,
      HARNESS_EXECUTION_CREDENTIAL: "unknown-execution-credential",
    });
    assert.match(unknownCredential.stdout, /authorization_denied/u);
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
    const secret = env.HARNESS_EXECUTION_CREDENTIAL!;
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer,
        nodeId: "node-slow",
        executionCredential: secret,
        opId: "wrong-node",
        eventType: "runtime_session_exited",
        payload: { runtimeSessionId: runtimeId, exitedAt: new Date().toISOString(), exitCode: 0 },
      }),
      { code: "execution_credential_rejected" },
    );
    // Edge reads answer from the local read model; a revocation lands at the next sync attempt.
    const resync = async () => {
      await runFleetReplicaPullClient({ ...peer, diskQuotaBytes: config.quotaBytes });
      applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    };
    f.owners.keycloak.revoke("person-owner", repoId, ["repository-read"]);
    await assert.rejects(resync(), { code: "authorization_denied" });
    assert.equal((await cli(["task", "show", taskId])).code, "authorization_denied");
    f.owners.keycloak.permit("person-owner", repoId, ["repository-read"]);
    await resync();
    const client = f.owners.keycloak.nodeClients.get(secret.split(":")[0]!)!;
    client.enabled = false;
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer,
        opId: "disabled-terminal",
        eventType: "runtime_session_exited",
        payload: { runtimeSessionId: runtimeId, exitedAt: new Date().toISOString(), exitCode: 0 },
      }),
      { code: "execution_credential_rejected" },
    );
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
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer,
        opId: "expired-terminal",
        eventType: "runtime_session_exited",
        payload: { runtimeSessionId: runtimeId, exitedAt: new Date().toISOString(), exitCode: 0 },
      }),
      { code: "execution_credential_rejected" },
    );
    client.attributes.harness_execution = JSON.stringify(principal);
    // Reassigning the node voids the execution's authority at the center; reads stay local.
    f.setOwner("person-other");
    const reassigned = await cli(["task", "progress", "append", taskId, "--text", "Owner was reassigned."]);
    assert.equal(reassigned.outcome, "op_rejected", JSON.stringify(reassigned));
    f.setOwner("person-owner");
    offline = true;
    const offlineShow = await cli(["task", "show", taskId]);
    assert.equal(offlineShow.outcome, "applied", JSON.stringify(offlineShow));
    assert.ok(offlineShow.freshness, JSON.stringify(offlineShow));
    offline = false;
    const settledCut = f.host.replica(repoId);
    settledCut.activate();
    await settledCut.waitForCut(f.eventCount());
    await runFleetReplicaPullClient({ ...peer, diskQuotaBytes: config.quotaBytes });
    applyFleetMirrorCut(viewRoot, repoId, edgeRoot, "pull");
    writeFileSync(
      path.join(edgeRoot, "harness/tasks/task-fleet-fleet/closeout.md"),
      "## Summary\nEdge implementation evidence.\n## Verification\nReal CLI after logout passed.\n## Residual Risk\nFixture only.\n## Same Mechanism Elsewhere\nFleet scopes bind the canonical dispatch.\n",
    );
    const frozenEvidencePath = "tasks/task-fleet-fleet/artifacts/full-evidence.txt",
      frozenEvidence = `FROZEN-HEAD\n${"accepted evidence line🛰\n".repeat(9000)}FROZEN-TAIL\n`;
    writeFileSync(path.join(edgeRoot, "harness", frozenEvidencePath), frozenEvidence);
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
    const reviewCut = f.host.replica(repoId);
    reviewCut.activate();
    await reviewCut.waitForCut(f.eventCount());
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
    const spawnReviewer = (idempotencyKey: string) =>
      reviewRpc("daemon.fleet.task.run", {
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
              idempotencyKey,
            },
          },
        },
      });
    const cancelSpawn = await spawnReviewer("edge-review-s1-cancel");
    assert.equal(cancelSpawn.outcome, "applied", JSON.stringify(cancelSpawn));
    const cancelRuntime = String(cancelSpawn.runtimeSessionId),
      cancelDispatch = String(cancelSpawn.dispatchId);
    reviewLive.add(cancelRuntime);
    const reviewSpawn = await spawnReviewer("edge-review-s1");
    assert.equal(reviewSpawn.outcome, "applied", JSON.stringify(reviewSpawn));
    let reviewRuntime = String(reviewSpawn.runtimeSessionId),
      reviewDispatch = String(reviewSpawn.dispatchId);
    reviewLive.add(reviewRuntime);
    let reviewEnv = await eventuallyValue(async () =>
      existsSync(path.join(f.root, `${reviewRuntime}.json`))
        ? (JSON.parse(readFileSync(path.join(f.root, `${reviewRuntime}.json`), "utf8")) as NodeJS.ProcessEnv)
        : null,
    );
    assert.ok(reviewEnv.HARNESS_EXECUTION_CREDENTIAL);
    assert.notEqual(reviewEnv.HARNESS_EXECUTION_CREDENTIAL, secret);
    assert.equal(existsSync(path.join(reviewUser, "rbac/config.json")), false);
    assert.equal((await reviewRpc("daemon.rbac.manage", { operation: "logout" })).ok, true);
    await new OidcSessionService(path.join(f.root, "user")).logout();
    const reviewCli = async (args: string[]) => {
      const result = await spawnCli(["--root", reviewRoot, "--json", ...args], { ...process.env, ...reviewEnv });
      assert.ok(result.stdout.trim(), result.stderr);
      return JSON.parse(result.stdout) as JsonObject;
    };
    const reviewedTask = await reviewCli(["task", "show", taskId]);
    assert.equal(reviewedTask.outcome, "applied", JSON.stringify(reviewedTask));
    // Frozen evidence is served by the center, even when the edge's workspace content differs.
    writeFileSync(path.join(reviewRoot, "harness", frozenEvidencePath), "Changed local evidence.\n");
    const fullEvidence = await reviewCli(["doc", "show", "--path", frozenEvidencePath]);
    assert.equal(fullEvidence.outcome, "applied", JSON.stringify(fullEvidence));
    assert.equal(fullEvidence.evidence, frozenEvidence);
    t.diagnostic(`Frozen evidence read ${Buffer.byteLength(frozenEvidence)} bytes through center chunk frames.`);
    const rawEvidence = await spawnCli(["--root", reviewRoot, "doc", "show", "--path", frozenEvidencePath, "--raw"], {
      ...process.env,
      ...reviewEnv,
    });
    assert.equal(rawEvidence.stdout, frozenEvidence);
    const binaryEvidence = await reviewCli(["doc", "show", "--path", "tasks/task-fleet-fleet/artifacts/evidence.bin"]);
    assert.equal(binaryEvidence.evidence, artifactBytes.toString("base64"));
    for (const deniedPath of [
      "tasks/task-other/artifacts/full-evidence.txt",
      "tasks/task-fleet-fleet/artifacts/unregistered.txt",
      "tasks/task-fleet-fleet/task_plan.md",
    ])
      assert.equal((await reviewCli(["doc", "show", "--path", deniedPath])).code, "execution_credential_rejected");
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
        action: { kind: "task-progress-append", taskId, text: "crossed credential probe" },
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
    let packet = `harness/tasks/task-fleet-fleet/artifacts/reports/${reviewDispatch}.json`;
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
    // Amend through the supported owner CLI path while the S1 reviewer remains live.
    // Only the edge document is edited; Fleet publishes it through the center writer.
    const show = async () => {
      const result = await f.host.run(repoId, { kind: "task-show", taskId }, localAuthFixture());
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      return JSON.parse(String(result.evidence)) as {
        task: { status: string };
        executions: Array<{ executionId: string; submission: unknown }>;
        reviews: Array<{ reviewId: string }>;
      };
    };
    signInAt(path.join(f.root, "user"), "person-owner");
    const s1 = await show();
    assert.ok(Array.isArray(s1.reviews));
    const ownerSession = {
      schema: "harness-oidc-session/v2",
      accessToken: "token-person-owner",
      subject: "person-owner",
      personId: "person-owner",
      expiresAt: Date.now() + 3_600_000,
      roles: [],
      loginTarget: edgeRoot,
    };
    f.owners.keycloak.interactiveSession("person-owner", f.subject.nodeId, f.owners.url);
    managedRbacSessionStore(userRoot).write(JSON.stringify(ownerSession));
    const closeout = path.join(edgeRoot, "harness/tasks/task-fleet-fleet/closeout.md");
    writeFileSync(
      closeout,
      readFileSync(closeout, "utf8").replace(
        "Edge implementation evidence.",
        "Amended edge implementation evidence for S2.",
      ),
    );
    const amendedCli = await spawnCli(
      [
        "--root",
        worktree,
        "--json",
        "task",
        "submit",
        taskId,
        "--execution-id",
        f.subject.executionId,
        "--amend",
        "--as-owner",
      ],
      {
        ...process.env,
        ...env,
        HARNESS_EXECUTION_CREDENTIAL: undefined,
        HARNESS_ACTOR: undefined,
        HARNESS_TASK_BOUND: undefined,
      },
    );
    const amended = JSON.parse(amendedCli.stdout) as JsonObject;
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    const s2 = await show();
    assert.notDeepEqual(
      s2.executions.find((execution) => execution.executionId === f.subject.executionId)?.submission,
      s1.executions.find((execution) => execution.executionId === f.subject.executionId)?.submission,
      "the supported amendment must change the submitted cut",
    );
    t.diagnostic("Owner CLI/Fleet TLS amended S1 to a distinct S2 submission.");
    // The stale credential still reads the local replica; the center refuses only its writes below.
    const staleRead = await reviewCli(["task", "show", taskId]);
    assert.equal(staleRead.outcome, "applied", JSON.stringify(staleRead));
    assert.equal(
      (await reviewCli(["doc", "show", "--path", frozenEvidencePath])).code,
      "execution_credential_rejected",
      "a superseded reviewer cannot read the replacement submission",
    );
    const staleReceipt = await reviewCli([
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
    assert.equal(staleReceipt.code, "execution_credential_rejected", JSON.stringify(staleReceipt));
    assert.deepEqual((await show()).reviews, s1.reviews, "rejected S1 receipt must not create a review");
    assert.equal(
      existsSync(path.join(f.repo, `harness/tasks/task-fleet-fleet/artifacts/reports/${reviewDispatch}.md`)),
      false,
    );
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer,
        nodeId: "node-slow",
        opId: "stale-success-terminal",
        eventType: "runtime_session_outcome_observed",
        payload: {
          runtimeSessionId: reviewRuntime,
          outcome: "succeeded",
          exitCode: 0,
          result: null,
          resultRef: "artifact:stale-success",
        },
      }),
      { code: "execution_credential_rejected" },
    );
    await assert.rejects(
      runFleetRuntimeEventClient({
        ...peer,
        opId: "foreign-stale-exit",
        eventType: "runtime_session_exited",
        payload: { runtimeSessionId: reviewRuntime },
      }),
      { code: "execution_credential_rejected" },
    );
    const beforeStaleExit = await f.host.read(
      repoId,
      "repo.agentRuntime.sessions.read",
      { runtimeSessionId: reviewRuntime },
      f.auth,
    );
    assert.notEqual(beforeStaleExit.session.liveness, "exited");
    assert.equal(beforeStaleExit.session.activity.outcome, null);
    t.diagnostic("S1 reviewer read and fixed receipt rejected; canonical reviews unchanged and report absent.");
    assert.equal(s2.task.status, "in_review", "amend preserves the already forwarded review stage");
    f.owners.keycloak.interactiveSession("person-owner", "node-slow", loginAuthorityUrl);
    managedRbacSessionStore(reviewUser).write(JSON.stringify({ ...ownerSession, loginTarget: reviewRoot }));
    writeFileSync(path.join(f.root, `${reviewRuntime}.finish`), "finish");
    const staleSettled = await eventuallyValue(async () => {
      const result = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: reviewRuntime },
        f.auth,
      );
      return result.session.activity.outcome ? result.session : null;
    });
    assert.equal(staleSettled.activity.outcome, "failed", JSON.stringify(f.runtimeArchiveReceipts));
    assert.equal(staleSettled.liveness, "exited");
    const staleStream = await eventuallyValue(() => readDispatchStream(reviewRoot, reviewDispatch));
    assert.equal(staleStream?.terminalOutcome?.payload.reasonCode, "runtime_archive_failed");
    assert.match(staleStream?.terminalOutcome?.body ?? "", /execution_credential_rejected/u);
    reviewLive.delete(reviewRuntime);
    const cancelled = await reviewRpc("daemon.fleet.task.run", {
      payload: {
        ...reviewRoute,
        workspaceRoot: reviewRoot,
        action: {
          kind: "fleet-runtime",
          method: "repo.agentRuntime.cancel",
          payload: { runtimeSessionId: cancelRuntime },
        },
      },
    });
    assert.equal(cancelled.outcome, "applied", JSON.stringify(cancelled));
    // Cancellation acknowledgement can race the provider exit callback. Observe the
    // canonical exit as well as cancellation before inspecting completed settlement.
    const cancelSettled = await eventuallyValue(async () => {
      const result = await f.host.read(
        repoId,
        "repo.agentRuntime.sessions.read",
        { runtimeSessionId: cancelRuntime },
        f.auth,
      );
      return result.session.liveness === "exited" && result.session.activity.resultRef ? result.session : null;
    });
    assert.equal(cancelSettled.liveness, "exited");
    assert.equal(cancelSettled.activity.outcome, "cancelled");
    const cancelledStream = await eventuallyValue(() => readDispatchStream(reviewRoot, cancelDispatch));
    assert.equal(cancelledStream.terminalOutcome?.payload.outcome, "cancelled", JSON.stringify(cancelledStream));
    reviewLive.delete(cancelRuntime);
    assert.deepEqual((await show()).reviews, s1.reviews, "neither stale settlement may register a review");
    for (const dispatchId of [reviewDispatch, cancelDispatch])
      assert.equal(
        existsSync(path.join(f.repo, `harness/tasks/task-fleet-fleet/artifacts/reports/${dispatchId}.md`)),
        false,
      );
    t.diagnostic(
      "Stale S1 natural exit and owner cancel reached canonical failed/cancelled terminals without reviews.",
    );
    await runFleetReplicaPullClient({
      ...peer,
      nodeId: "node-slow",
      viewRoot: reviewView,
      diskQuotaBytes: config.quotaBytes,
    });
    applyFleetMirrorCut(reviewView, repoId, reviewRoot, "pull");
    const fresh = await spawnReviewer("edge-review-s2");
    assert.equal(fresh.outcome, "applied", JSON.stringify(fresh));
    reviewRuntime = String(fresh.runtimeSessionId);
    reviewDispatch = String(fresh.dispatchId);
    reviewLive.add(reviewRuntime);
    const oldSecret = reviewEnv.HARNESS_EXECUTION_CREDENTIAL;
    reviewEnv = await eventuallyValue(async () =>
      existsSync(path.join(f.root, `${reviewRuntime}.json`))
        ? (JSON.parse(readFileSync(path.join(f.root, `${reviewRuntime}.json`), "utf8")) as NodeJS.ProcessEnv)
        : null,
    );
    assert.ok(reviewEnv.HARNESS_EXECUTION_CREDENTIAL);
    assert.notEqual(reviewEnv.HARNESS_EXECUTION_CREDENTIAL, oldSecret);
    assert.equal((await reviewRpc("daemon.rbac.manage", { operation: "logout" })).ok, true);
    await new OidcSessionService(path.join(f.root, "user")).logout();
    assert.equal((await reviewCli(["task", "show", taskId])).outcome, "applied");
    packet = `harness/tasks/task-fleet-fleet/artifacts/reports/${reviewDispatch}.json`;
    writeFileSync(
      path.join(reviewRoot, packet),
      JSON.stringify({
        verdict: "approved",
        reason: "Verified amended S2 cut.",
        evidenceChecked: ["S2 CLI receipts"],
      }),
    );
    writeFileSync(path.join(reportDir, `${reviewDispatch}.md`), "# Review\n\nVerified amended S2 cut.\n");
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
    // The edge settles without a local projection, so its reviewer settlement cannot witness the
    // registered review; the receipt stays honestly unknown instead of restating success from the
    // exit/result pair. The registered review itself is asserted through `show()` below.
    assert.equal(reviewSettled.activity.outcome, "unknown", JSON.stringify(f.runtimeArchiveReceipts));
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
    // Same edge honesty: no local delivery witness, so the session reports its settled unknown.
    assert.equal(settled.activity.outcome, "unknown", JSON.stringify(f.runtimeArchiveReceipts));
    live.delete(runtimeId);
    signInAt(path.join(f.root, "user"), "person-owner");
    assert.ok((await show()).reviews.some((review) => review.reviewId === `review-${reviewDispatch}`));
    t.diagnostic("Fresh S2 reviewer read, fixed receipt and honest unknown settlement passed after logout.");
    // The settled execution's edge-local identity is no longer available, so the write is refused.
    const after = await cli(["task", "progress", "append", taskId, "--text", "After settlement."]);
    assert.equal(after.code, "authorization_denied", JSON.stringify(after));
  },
);
