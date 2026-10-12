// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  makeTaskEventReader,
  makeTaskProjection,
} from "@harness-anything/kernel";
import { openRepoCell } from "../src/repo-cell-open.ts";
import { startDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { dispatchStreamPath, readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { createRealizedTaskPlanFixture, realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";
import { initIngressRepo, eventuallyValue, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import type { CredentialPort } from "../src/agent-runtime-credential-port.ts";

// The real daemon, writer process, socket, CLI, and provider executable run in a dedicated user root.
// Keycloak wire behavior is a realm fixture; the fixed real-server mechanism is recorded in F-02C8A42D.
test("runtime CLI requires device login and bounded execution", { timeout: 120_000 }, async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-execution-logout-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "logout-repo",
    daemonId = "logout-test",
    githubCredentialRef = "credential:v1:logout-ci",
    githubToken = "logout-ci-fixture-token",
    realm = await serveKeycloak();
  const live = new Set<string>();
  let cleanupRuntimes = async () => {};
  let stop = async (): Promise<void> => {};
  t.after(async () => {
    await cleanupRuntimes();
    await stop();
    await realm.close();
    rmSync(parent, { recursive: true, force: true });
  });
  initIngressRepo(root, process.getuid?.() ?? 0);
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
  writeFileSync(path.join(root, "delivery.ts"), "export const delivered = true;\n");
  execFileSync("git", ["add", "delivery.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "test: delivery"], { cwd: root });
  const delivery = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  realm.bind(userRoot);
  realm.keycloak.account("owner");
  realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
  signInAt(userRoot, "owner");
  registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
  const executablePath = writeProviderExecutable(
    path.join(parent, "codex.mjs"),
    `
    import fs from "node:fs";
    import path from "node:path";
    if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);
    fs.readFileSync(0, "utf8");
    const id = process.env.HARNESS_ACTOR.split(":").at(-1), dir = ${JSON.stringify(parent)};
    console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
    const keys = ["HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT", "HARNESS_ACTOR", "HARNESS_DAEMON_USER_ROOT", "HARNESS_DAEMON_ID", "HARNESS_DAEMON_ENDPOINT", "HARNESS_DAEMON_REPO_ID", "HARNESS_CANONICAL_ROOT", "HARNESS_TASK_BOUND", "HARNESS_DAEMON_RELAY"];
    const envPath = path.join(dir, id + ".json");
    fs.writeFileSync(envPath + ".tmp", JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))), { mode: 0o600 });
    fs.renameSync(envPath + ".tmp", envPath);
    const finish = () => {
      if (!fs.existsSync(path.join(dir, id + ".finish"))) return;
      watcher.close();
      console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Completed permitted task actions." } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
    };
    const watcher = fs.watch(dir, finish);
    finish();
  `,
  );
  const opened = Promise.withResolvers<Awaited<ReturnType<typeof openRepoCell>>>();
  const daemon = await startDaemon({
    daemonId,
    userRoot,
    runtimeCredentialPort: {
      issue: () => githubCredentialRef,
      store: async () => {},
      resolve: async (reference) => {
        assert.equal(reference, githubCredentialRef);
        return githubToken;
      },
      remove: async () => {},
    } satisfies CredentialPort,
    buildSupersessionEnabled: false,
    openCell: (input) => {
      const opening = openRepoCell(input);
      opened.resolve(opening);
      return opening;
    },
    runtimeDiscover: () => [
      {
        installationId: "codex-fixture",
        kindId: "codex",
        executablePath,
        version: "1.0",
        observedAt: new Date().toISOString(),
      },
    ],
  });
  assert.ok("stop" in daemon);
  stop = daemon.stop;
  const rpc = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000),
    run = (action: JsonObject) => {
      const method = commandDescriptorForAction(String(action.kind)).method;
      const { kind: _kind, ...payload } = action;
      return rpc(method, {
        repo: { repoId },
        payload: method === "repo.task.run" || method === "repo.task.read" ? { action } : payload,
      });
    };
  cleanupRuntimes = async () => {
    if (live.size === 0) return;
    signInAt(userRoot, "owner");
    for (const runtimeSessionId of live) {
      await rpc("repo.agentRuntime.cancel", { repo: { repoId }, payload: { runtimeSessionId } });
    }
  };
  // Observe the actual writer open; cold startup is not a provider-event polling budget.
  await opened.promise;
  const status = await rpc("daemon.status", {});
  assert.ok((status.repos as JsonObject[]).some((repo) => repo.repoId === repoId && repo.state === "attached"));
  const instance = await rpc("daemon.runtimeInstance.create", {
    payload: {
      instanceId: "codex-worker",
      name: "Logout worker",
      kindId: "codex",
      installationId: "codex-fixture",
      providerId: "openai",
      models: ["fixture"],
      permissionMode: "workspace-write",
      authMode: "subscription",
      githubCredentialRef,
    },
  });
  assert.equal(instance.ok, true, JSON.stringify(instance));
  assert.equal((await run({ kind: "settings-update", runtimeAllowedInstances: ["codex-worker"] })).outcome, "applied");
  const taskId = "task-logout",
    executionId = "execution-logout";
  await createRealizedTaskPlanFixture(
    root,
    async () => {
      const created = await run({ kind: "task-create", taskId, title: "Logout runtime", presetId: "docs-task" });
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await run({
        kind: "receipt-show",
        opId: created.opId,
        waitFor: ["git_verified", "worktree_visible"],
        timeoutMs: 5000,
      });
      return created;
    },
    (planPath: string) => run({ kind: "doc-submit", paths: [planPath] }),
    "Logout runtime",
  );
  const started = await run({ kind: "task-start", taskId, executionId });
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  const proposedDecision = await run({
    kind: "decision-propose",
    body: realizedDecisionBody("Runtime reviewer decision read"),
    jsonInput: JSON.stringify({
      title: "Runtime reviewer decision read",
      question: "Can the dispatched reviewer read its bound decision?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "standard-task",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Bind the reviewer to this decision" }],
      rejected: [{ id: "RJ1", text: "Allow arbitrary decisions", whyNot: "The dispatch scope is bounded" }],
      claims: [{ id: "C1", text: "The reviewer can read the bound decision.", loadBearing: true }],
      fulfillments: [],
    }),
  });
  assert.equal(proposedDecision.outcome, "applied", JSON.stringify(proposedDecision));
  const decisionId = String((JSON.parse(String(proposedDecision.evidence)) as { decisionId: string }).decisionId);
  const shownDecision = await run({ kind: "decision-show", decisionId, includeBody: true });
  assert.equal(shownDecision.outcome, "applied", JSON.stringify(shownDecision));
  const decisionDigest = String(
    (JSON.parse(String(shownDecision.evidence)) as { decision: { currentReviewContentDigest: string } }).decision
      .currentReviewContentDigest,
  );
  const projection = () =>
    makeTaskProjection({ rootDir: root, eventStore: makeTaskEventReader({ rootDir: root, repoId }) });
  const read = projection(),
    packagePath = read.read(taskId).packagePath!;
  read.close();
  const launch = async (role: "implementation" | "reviewer") => {
    const result = await rpc("repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-worker",
        cwd: { scope: "repo-root" },
        taskId,
        ...(role === "reviewer" ? { role } : {}),
        ...(role === "reviewer" ? { reviewTarget: { kind: "decision", decisionId, digest: decisionDigest } } : {}),
        prompt: "Exercise logout boundaries.",
        idempotencyKey: `logout-${role}`,
      },
    });
    assert.equal(result.outcome, "applied", JSON.stringify(result));
    live.add(String(result.runtimeSessionId));
    const runtime = String(result.runtimeSessionId),
      env = await eventuallyValue(async () =>
        existsSync(path.join(parent, `${runtime}.json`))
          ? (JSON.parse(readFileSync(path.join(parent, `${runtime}.json`), "utf8")) as NodeJS.ProcessEnv)
          : null,
      );
    assert.equal(env.HARNESS_DAEMON_USER_ROOT, userRoot);
    assert.equal(env.HARNESS_DAEMON_ID, daemonId);
    assert.ok(env.HARNESS_EXECUTION_CREDENTIAL);
    assert.ok(Date.parse(env.HARNESS_EXECUTION_EXPIRES_AT!) > Date.now());
    const cli = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
      const response = await spawnCli(["--root", root, "--json", ...args], { ...process.env, ...env, ...overrides });
      assert.ok(response.stdout.trim(), response.stderr);
      return JSON.parse(response.stdout) as JsonObject;
    };
    return { result, runtime, env, cli };
  };
  const implementation = await launch("implementation");
  const signedInRead = await implementation.cli(["task", "show", taskId]);
  assert.equal(signedInRead.outcome, "applied", JSON.stringify(signedInRead));
  const readSet = await implementation.cli(["task", "read-set", taskId]);
  assert.equal(readSet.outcome, "applied", JSON.stringify(readSet));
  const settings = await implementation.cli(["settings", "read"]);
  assert.equal(settings.outcome, "applied", JSON.stringify(settings));
  const ci = await implementation.cli(["task", "ci", taskId]);
  assert.equal(ci.outcome, "applied", JSON.stringify(ci));
  const events = await implementation.cli(["event", "list", "--type", "runtime_session_started", "--limit", "100"]);
  assert.equal(events.outcome, "applied", JSON.stringify(events));
  const eventRows = (JSON.parse(String(events.evidence)) as { rows: { type: string }[] }).rows;
  assert.ok(eventRows.length > 0, JSON.stringify(events));
  assert.ok(eventRows.every((row) => row.type === "runtime_session_started"));
  const logout = await rpc("daemon.rbac.manage", { operation: "logout" });
  assert.equal(logout.ok, true, JSON.stringify(logout));
  // dec_F01770FD0DCF72683B7C4C7A47/CH5: local execution needs the same current user session as Fleet.
  assert.equal((await implementation.cli(["task", "show", taskId])).code, "authentication_required");
  assert.equal(
    (await implementation.cli(["task", "progress", "append", taskId, "--text", "No session"])).code,
    "authentication_required",
  );
  signInAt(userRoot, "owner");
  for (const args of [
    ["event", "list", "--limit", "1"],
    ["task", "show", taskId],
    ["task", "read-set", taskId],
    ["doc", "status", "--task", taskId],
  ]) {
    const result = await implementation.cli(args);
    assert.equal(result.outcome, "applied", JSON.stringify(result));
  }
  const progress = await implementation.cli([
    "task",
    "progress",
    "append",
    taskId,
    "--text",
    "Worker continued after the device owner signed in again.",
  ]);
  assert.equal(progress.outcome, "applied", JSON.stringify(progress));
  for (const args of [
    ["task", "show", "task-other"],
    ["task", "list"],
    ["daemon", "stop"],
  ]) {
    const denied = await implementation.cli(args);
    assert.equal(denied.code, "execution_credential_rejected", JSON.stringify(denied));
  }
  realm.keycloak.revoke("owner", repoId, ["repository-read"]);
  assert.equal((await implementation.cli(["event", "list"])).code, "authorization_denied");
  assert.equal((await implementation.cli(["task", "read-set", taskId])).code, "authorization_denied");
  realm.keycloak.permit("owner", repoId, ["repository-read"]);
  writeFileSync(path.join(root, "incoming.md"), "Logout execution evidence.\n");
  const artifact = await implementation.cli([
    "task",
    "artifact",
    "add",
    taskId,
    "--source",
    "incoming.md",
    "--destination",
    "report.md",
  ]);
  assert.equal(artifact.outcome, "applied", JSON.stringify(artifact));
  writeFileSync(
    path.join(root, "harness", packagePath, "closeout.md"),
    `## Summary\nDelivered ${delivery}.\n## Verification\nReal daemon CLI logout refusal and reauthenticated progress passed.\n## Residual Risk\nIsolated fixture only.\n## Same Mechanism Elsewhere\nReviewer ingress uses the same independent credential.\n`,
  );
  const doc = await implementation.cli(["doc", "sync", "--submit", "--task", taskId]);
  assert.equal(doc.outcome, "applied", JSON.stringify(doc));
  const submitted = await implementation.cli(["task", "submit", taskId]);
  assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
  // Owner forwards the frozen cut; the worker credential cannot perform this action.
  signInAt(userRoot, "owner");
  const forward = await run({
    kind: "task-adjudicate",
    taskId,
    executionId,
    forward: true,
    reason: "Review isolated logout evidence.",
  });
  assert.equal(forward.outcome, "applied", JSON.stringify(forward));
  const reviewer = await launch("reviewer");
  assert.equal((await rpc("daemon.rbac.manage", { operation: "logout" })).ok, true);
  assert.equal((await reviewer.cli(["task", "show", taskId])).code, "authentication_required");
  signInAt(userRoot, "owner");
  assert.equal((await reviewer.cli(["task", "show", taskId])).outcome, "applied");
  assert.equal((await reviewer.cli(["task", "read-set", taskId])).outcome, "applied");
  const decisionRead = await reviewer.cli(["decision", "show", decisionId]);
  assert.equal(decisionRead.outcome, "applied", JSON.stringify(decisionRead));
  const dispatchId = String(reviewer.result.dispatchId),
    reportDir = path.join(root, "harness", packagePath, "artifacts/reports");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, `${dispatchId}.json`),
    JSON.stringify({
      verdict: "approved",
      reason: "The bounded runtime completed after device reauthentication.",
      evidenceChecked: ["isolated CLI receipts"],
    }),
  );
  writeFileSync(
    path.join(reportDir, `${dispatchId}.md`),
    "# Review\n\nVerified device session requirement and current permission refusal.\n",
  );
  const wrongReport = await reviewer.cli([
    "task",
    "review-execution",
    taskId,
    "--execution-id",
    executionId,
    "--review-id",
    "review-other",
    "--from-file",
    `harness/${packagePath}/artifacts/reports/${dispatchId}.json`,
  ]);
  assert.equal(wrongReport.code, "execution_credential_rejected", JSON.stringify(wrongReport));
  const review = await reviewer.cli([
    "task",
    "review-execution",
    taskId,
    "--execution-id",
    executionId,
    "--review-id",
    `review-${dispatchId}`,
    "--from-file",
    `harness/${packagePath}/artifacts/reports/${dispatchId}.json`,
  ]);
  assert.equal(review.outcome, "applied", JSON.stringify(review));
  const consent = await reviewer.cli([
    "task",
    "review-consent",
    taskId,
    "--execution-id",
    executionId,
    "--review-id",
    `review-${dispatchId}`,
  ]);
  assert.equal(consent.code, "execution_credential_rejected", JSON.stringify(consent));
  // Disable the Keycloak client, including while a CLI reconnects, without changing the user's grants.
  const clients = (await (
    await fetch(`${realm.url}/admin/realms/harness/clients?clientId=harness-execution-${dispatchId}`)
  ).json()) as { id: string }[];
  await fetch(`${realm.url}/admin/realms/harness/clients/${clients[0]!.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await reviewer.cli(["task", "show", taskId])).code, "execution_credential_rejected");
  await fetch(`${realm.url}/admin/realms/harness/clients/${clients[0]!.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal((await reviewer.cli(["task", "show", taskId])).outcome, "applied");
  const expired = {
    ...JSON.parse(
      (
        await (await fetch(`${realm.url}/admin/realms/harness/clients?clientId=harness-execution-${dispatchId}`)).json()
      )[0].attributes.harness_execution,
    ),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  const validExpiresAt = reviewer.env.HARNESS_EXECUTION_EXPIRES_AT;
  for (const [expiresAt, expected] of [
    [expired.expiresAt, "execution_credential_rejected"],
    [validExpiresAt, undefined],
  ] as const) {
    await fetch(`${realm.url}/admin/realms/harness/clients/${clients[0]!.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attributes: { harness_execution: JSON.stringify({ ...expired, expiresAt }) } }),
    });
    const read = await reviewer.cli(["task", "show", taskId]);
    if (expected) assert.equal(read.code, expected);
    else assert.equal(read.outcome, "applied", JSON.stringify(read));
  }
  signInAt(userRoot, "owner");
  const direct = { HARNESS_DAEMON_ENDPOINT: daemon.endpoint, HARNESS_DAEMON_RELAY: "" };
  for (const runtime of [implementation, reviewer]) {
    if (runtime === implementation) {
      const cancelled = await rpc("repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: runtime.runtime },
      });
      assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    } else {
      assert.equal((await rpc("daemon.rbac.manage", { operation: "logout" })).ok, true);
      assert.equal((await reviewer.cli(["task", "show", taskId])).code, "authentication_required");
      signInAt(userRoot, "owner");
      writeFileSync(path.join(parent, `${runtime.runtime}.finish`), "finish");
    }
    // The stream records the outcome before the ledger does; settlement archives the stream only
    // after both terminal ledger events land, and only then is the credential's session settled.
    const dispatchId = String(runtime.result.dispatchId);
    const terminal = await eventuallyValue(async () =>
      dispatchStreamPath(root, dispatchId).endsWith(path.join("archive", `${dispatchId}.jsonl`))
        ? (readDispatchStreamSummary(root, dispatchId)?.terminalOutcome ?? null)
        : null,
    );
    assert.equal(
      terminal.payload.outcome,
      runtime === implementation ? "cancelled" : "succeeded",
      JSON.stringify(terminal),
    );
    live.delete(runtime.runtime);
    const refused = await runtime.cli(["task", "show", taskId], direct);
    assert.equal(refused.code, "execution_credential_rejected", JSON.stringify(refused));
  }
  await realm.close();
  const offline = await implementation.cli(["task", "show", taskId], direct);
  assert.notEqual(offline.outcome, "applied");
});
