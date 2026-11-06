// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openDaemonHost } from "../src/daemon-host.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol.contract.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { registerSettledBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-rpc-")),
    userRoot = path.join(root, "user"),
    repoRoot = path.join(root, "repo"),
    repoId = "lifecycle-rpc";
  rosterRepo(repoRoot, repoId);
  await registerSettledBootstrappedDaemonRepo({ repoId, canonicalRoot: repoRoot, userRoot });
  const signIn = (person: string, tier: "viewer" | "contributor" | "maintainer") =>
    signInPolicyTestUser(userRoot, person, [repoId], tier);
  signIn("lifecycle-owner", "contributor");
  const host = await openDaemonHost({ daemonId: "lifecycle-rpc", userRoot, runtimeDiscover: () => [] });
  t.after(async () => {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  await host.attachmentsSettled();
  const transport = createUnixSocketTransportServer({
    daemonId: "lifecycle-rpc",
    socketPath: localUserDaemonEndpoint(userRoot, "lifecycle-rpc"),
    createProtocolServer: (authContext, emit, connectionId, signal) =>
      createJsonRpcProtocolServer({
        host,
        build: { commit: null },
        authContext: { ...authContext, connectionSignal: signal },
        sessionPrincipal: (method, params) => host.sessionPrincipal(authContext, method, params),
        emit,
        connectionId,
      }),
  });
  await transport.start();
  t.after(() => transport.stop());
  const run = (action: Readonly<Record<string, unknown>>) => {
      const { kind, ...payload } = action,
        descriptor = daemonProtocolCommands.find(
          (command) => ("actionKind" in command ? command.actionKind : command.id) === kind,
        );
      assert.ok(descriptor, `Missing command descriptor for ${String(kind)}`);
      return requestDaemonJsonRpcAt(
        transport.endpoint,
        descriptor.method,
        {
          repo: { repoId },
          payload: ["repo.task.run", "repo.task.read"].includes(descriptor.method) ? { action } : payload,
        },
        5_000,
        30_000,
      );
    },
    events = () => makeTaskEventReader({ repoId, rootDir: repoRoot }).read(),
    applied = async (action: Readonly<Record<string, unknown>>) => {
      const result = await run(action);
      assert.equal(result.outcome, "applied", JSON.stringify(result));
      return result;
    },
    denied = async (action: Readonly<Record<string, unknown>>, person = "lifecycle-reader") => {
      const before = events().revision;
      signIn(person, "viewer");
      const result = await run(action);
      assert.equal(result.outcome, "op_rejected", JSON.stringify(result));
      assert.equal(result.code, "authorization_denied", JSON.stringify(result));
      assert.equal(events().revision, before, "an unauthorized RPC must publish no event");
      t.diagnostic(JSON.stringify({ intent: action, denied: result.code, revision: before }));
      signIn("lifecycle-owner", "contributor");
    },
    published = async (opId: unknown) => {
      const receipt = await run({
        kind: "receipt-show",
        opId,
        waitFor: ["git_verified", "worktree_visible"],
        timeoutMs: 5_000,
      });
      assert.equal((receipt.wait as { state?: string } | undefined)?.state, "satisfied", JSON.stringify(receipt));
    };
  return { repoRoot, signIn, run, applied, denied, events, published };
}

test("real daemon RPC unblocks, replans, cancels and reinstates through the shared transition action", async (t) => {
  const f = await fixture(t),
    taskId = "task-rpc-transition",
    created = await f.applied({ kind: "task-create", taskId, title: "RPC transitions" });
  await f.published(created.opId);
  await f.applied({ kind: "task-transition", taskId, status: "blocked", reason: "Wait for an external dependency." });

  for (const [status, reason] of [
    ["active", undefined],
    ["planned", "Return this unleased task to the backlog."],
    ["cancelled", "The planned work is no longer needed."],
    ["planned", "Restore the task cancelled in error."],
  ] as const) {
    const action = { kind: "task-transition", taskId, status, ...(reason ? { reason } : {}) };
    await f.denied(action);
    const result = await f.applied(action),
      event = f.events().events.find(({ opId }) => opId === result.opId);
    assert.equal(event?.type, "task_transitioned", JSON.stringify(event));
    if (event?.type !== "task_transitioned") throw new Error("RPC transition event missing");
    assert.equal(event.payload.task.status, status);
    assert.equal(event.payload.task.currentNode, "implementation");
    t.diagnostic(JSON.stringify({ status, event: event.type, outcome: result.outcome }));
  }

  for (const status of ["in_review", "done"] as const) {
    const result = await f.run({ kind: "task-transition", taskId, status, reason: "Cannot bypass the review cut." });
    assert.equal(result.code, "invalid_transition", JSON.stringify(result));
  }
  const submitted = await f.run({ kind: "task-transition", taskId, status: "submitted" });
  assert.equal(submitted.code, "invalid_request", JSON.stringify(submitted));
  for (const status of ["planned", "cancelled"] as const) {
    await f.applied({ kind: "task-transition", taskId, status: "blocked" });
    const result = await f.run({ kind: "task-transition", taskId, status });
    assert.equal(result.code, "missing_field", JSON.stringify(result));
    assert.match(String(result.rejectionExplanation), /auditable reason/u);
    await f.applied({ kind: "task-transition", taskId, status: "active" });
  }
});

test("real daemon RPC review-return uses owner rework and retains policy and owner checks", async (t) => {
  const f = await fixture(t),
    taskId = "task-rpc-rework",
    executionId = "execution-rpc-rework",
    created = await f.applied({ kind: "task-create", taskId, title: "RPC owner rework" }),
    packagePath = String(created.packagePath);
  await f.published(created.opId);
  await realizeTaskPlanFixture(f.repoRoot, packagePath, (planPath) =>
    f.applied({ kind: "doc-submit", paths: [planPath] }),
  );
  const started = await f.applied({ kind: "task-start", taskId, executionId });
  await f.published(started.opId);
  writeFileSync(path.join(f.repoRoot, "README.md"), "# RPC lifecycle delivery\n");
  for (const args of [
    ["add", "README.md"],
    ["commit", "-qm", "fixture delivery"],
  ])
    execFileSync("git", args, { cwd: f.repoRoot, stdio: "pipe", windowsHide: true });
  const closeout = path.join(f.repoRoot, "harness", packagePath, "closeout.md");
  mkdirSync(path.dirname(closeout), { recursive: true });
  writeFileSync(
    closeout,
    "# Closeout\n\n## Summary\n\nRPC lifecycle delivery.\n\n## Verification\n\nReal socket assertions.\n\n" +
      "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared lifecycle ingress.\n",
  );
  const submitted = await f.applied({ kind: "task-submit", taskId, executionId });
  await f.published(submitted.opId);
  const action = { kind: "task-rework", taskId, executionId, reason: "Return this submitted cut for another pass." };
  await f.denied(action);
  const ownerWithoutGrant = await f.run(action);
  assert.equal(ownerWithoutGrant.code, "authorization_denied", JSON.stringify(ownerWithoutGrant));
  const before = f.events().revision;
  f.signIn("lifecycle-foreign-maintainer", "maintainer");
  const foreign = await f.run(action);
  assert.equal(foreign.code, "invalid_proof", JSON.stringify(foreign));
  assert.equal(f.events().revision, before);
  f.signIn("lifecycle-owner", "maintainer");
  const returned = await f.applied(action),
    event = f.events().events.find(({ opId }) => opId === returned.opId);
  assert.equal(event?.type, "submission_returned", JSON.stringify(event));
  if (event?.type !== "submission_returned") throw new Error("RPC rework event missing");
  assert.equal(event.payload.task.status, "active");
  assert.equal(event.payload.task.currentNode, "implementation");
  assert.equal(event.payload.task.iteration, 1);
  assert.equal(event.payload.execution.state, "changes_requested");
  t.diagnostic(JSON.stringify({ intent: "review-return", event: event.type, outcome: returned.outcome }));
});

test("owner rework past the rework budget requires a premise review recorded after the last return", async (t) => {
  const f = await fixture(t),
    taskId = "task-rpc-premise",
    created = await f.applied({ kind: "task-create", taskId, title: "RPC premise review" }),
    packagePath = String(created.packagePath);
  await f.published(created.opId);
  await realizeTaskPlanFixture(f.repoRoot, packagePath, (planPath) =>
    f.applied({ kind: "doc-submit", paths: [planPath] }),
  );
  f.signIn("lifecycle-owner", "maintainer");
  const submitRound = async (round: number) => {
      const executionId = `execution-rpc-premise-${String(round)}`,
        started = await f.applied({ kind: "task-start", taskId, executionId });
      await f.published(started.opId);
      writeFileSync(path.join(f.repoRoot, "README.md"), `# Premise round ${String(round)}\n`);
      for (const args of [
        ["add", "README.md"],
        ["commit", "-qm", `premise round ${String(round)}`],
      ])
        execFileSync("git", args, { cwd: f.repoRoot, stdio: "pipe", windowsHide: true });
      const closeout = path.join(f.repoRoot, "harness", packagePath, "closeout.md");
      mkdirSync(path.dirname(closeout), { recursive: true });
      writeFileSync(
        closeout,
        `# Closeout\n\n## Summary\n\nRound ${String(round)}.\n\n## Verification\n\nSocket assertions.\n\n` +
          "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nShared rework ingress.\n",
      );
      const submitted = await f.applied({ kind: "task-submit", taskId, executionId });
      await f.published(submitted.opId);
      return executionId;
    },
    rework = (executionId: string) =>
      f.run({ kind: "task-rework", taskId, executionId, reason: "Return the cut once more." }),
    premise = (conclusion: string) =>
      f.applied({
        kind: "fact-record",
        taskId,
        statement:
          "restart: only if the attach pause is measured first. alternative: schedule upgrades off-peak. " +
          `sunk-cost: three rounds spent; not a reason. conclusion: ${conclusion}`,
        evidenceSource: "review:premise",
        confidence: "medium",
        memoryClass: "episodic",
        memoryTags: [],
      });

  // Below the repository rework budget the owner returns cuts unasked.
  const shown = await f.run({ kind: "task-show", taskId }),
    budget = (JSON.parse(String(shown.evidence)) as { returnBudget: number }).returnBudget;
  for (let round = 0; round < budget; round += 1) {
    const executionId = await submitRound(round);
    // A premise review written before the latest return does not cover the round after it.
    if (round === budget - 1) await premise("continue");
    const returned = await rework(executionId);
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
  }
  const pastBudget = await submitRound(budget);
  const before = f.events().revision;
  const refused = await rework(pastBudget);
  assert.equal(refused.code, "premise_review_required", JSON.stringify(refused));
  assert.match(JSON.stringify(refused), /ha fact record --task task-rpc-premise --source review:premise/u);
  assert.equal(f.events().revision, before, "a refused return publishes no event");

  await premise("stop");
  const stopped = await rework(pastBudget);
  assert.equal(stopped.code, "premise_review_stop", JSON.stringify(stopped));

  await premise("narrow");
  const returned = await rework(pastBudget),
    event = f.events().events.find(({ opId }) => opId === returned.opId);
  assert.equal(returned.outcome, "applied", JSON.stringify(returned));
  assert.equal(event?.type, "submission_returned", JSON.stringify(event));
  t.diagnostic(JSON.stringify({ refused: refused.code, stopped: stopped.code, returned: returned.outcome }));
});
