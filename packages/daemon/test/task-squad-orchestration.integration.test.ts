// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RuntimeLauncher } from "../src/runtime-spawn-types.ts";
import type { WorkerAttempt } from "../src/squad-leader-decision.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeader } from "../src/dispatch-stream.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { evidence, git, initRepo } from "./task-surface.fixtures.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const binding = {
  actor: { principal: { personId: "squad-owner" }, executor: { kind: "agent" as const, id: "coordinator" } },
  source: "local" as const,
};
type Provider = {
  prompt: string;
  cwd: string;
  dispatchId: string;
  sessionId: string;
  output?: (chunk: string) => void;
  exit?: (code: number | null) => void;
};
type Status = {
  squadRunId: string;
  status: string;
  error: string | null;
  leaders: Array<{ dispatchId: string; runtimeSessionId: string }>;
  workers: WorkerAttempt[];
  workerCallbackCount: number;
  pendingLeaderCallbackCount: number;
};

test(
  "squad children submit independently, resume one leader and integrate a verified local-remote delivery",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await openFixture(t, "delivery");
    await fixture.plan(["src/a.txt"], ["docs/"]);
    const running = await fixture.waitStatus(
      (state) => state.workers.length === 2 && state.workers.every((w) => w.runtimeSessionId),
    );
    const [first, second] = running.workers;
    assert.ok(first.taskId && second.taskId && first.executionId && second.executionId);
    assert.notEqual(first.taskId, second.taskId);
    assert.notEqual(first.executionId, second.executionId);
    assert.notEqual(first.taskId, fixture.taskId);
    for (const child of running.workers) {
      const row = fixture.task(child.taskId!);
      assert.equal(row.snapshot.lease?.executionId, child.executionId);
      assert.match(
        readFileSync(path.join(fixture.root, "harness", row.packagePath!, "task_plan.md"), "utf8"),
        /worker mission/u,
      );
    }
    const heads: string[] = [];
    for (const [index, child] of running.workers.entries()) {
      assert.ok(child.worktree);
      const target = index === 0 ? "src/a.txt" : "docs/b.txt";
      mkdirSync(path.dirname(path.join(child.worktree.cwd, target)), { recursive: true });
      writeFileSync(path.join(child.worktree.cwd, target), `child ${index}\n`);
      if (index === 1) writeFileSync(path.join(child.worktree.cwd, "outside.txt"), "ownership finding\n");
      git(child.worktree.cwd, "add", ".");
      git(child.worktree.cwd, "commit", "-qm", `docs: child ${index} delivery`);
      heads.push(git(child.worktree.cwd, "rev-parse", "HEAD"));
      await fixture.submit(child, heads[index]);
      fixture.finish(child.dispatchId!, "child delivery");
      if (index === 0) {
        await fixture.waitStatus((state) => state.workerCallbackCount === 1);
        assert.equal((await fixture.status()).leaders.length, 1, "one live child keeps the leader suspended");
      }
    }
    const resumed = await fixture.waitStatus((state) => state.leaders.length === 2);
    assert.equal(resumed.workerCallbackCount, 2);
    assert.deepEqual(resumed.workers[1].ownershipCheck?.outsidePaths, ["outside.txt"]);
    assert.equal(git(second.worktree!.cwd, "rev-parse", "HEAD"), heads[1], "finding does not roll back delivery");
    for (const child of resumed.workers) {
      assert.equal(fixture.task(child.taskId!).snapshot.lease, null);
      const submitted = makeTaskEventReader({ repoId: fixture.repoId, rootDir: fixture.root })
        .read()
        .events.filter((event) => event.type === "execution_submitted" && event.taskId === child.taskId);
      assert.equal(submitted.length, 1);
    }
    // Duplicate process notifications must not create another leader turn.
    for (const child of resumed.workers) fixture.providers.find((p) => p.dispatchId === child.dispatchId)!.exit!(0);
    await fixture.cell.settlePendingMaterialization("duplicate child notifications");
    assert.equal((await fixture.status()).leaders.length, 2);
    const leader = fixture.providers.find((p) => p.dispatchId === resumed.leaders[1].dispatchId)!;
    assert.match(leader.prompt, /outside\.txt/u);
    assert.match(leader.prompt, /git push origin codex\/<mission-slug>/u);
    assert.match(leader.prompt, /gh pr create/u);
    assert.match(leader.prompt, /Do not merge/u);
    await fixture.cell.settlePendingMaterialization("before public integration");
    git(fixture.root, "checkout", "-qb", "codex/mission-delivery");
    for (const head of heads) git(fixture.root, "cherry-pick", head);
    assert.equal(readFileSync(path.join(fixture.root, "src/a.txt"), "utf8"), "child 0\n");
    assert.equal(readFileSync(path.join(fixture.root, "docs/b.txt"), "utf8"), "child 1\n");
    const bare = fixture.bare;
    assert.equal(
      git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/"),
      "",
      "child settlement leaves the configured remote unpublished",
    );
    git(fixture.root, "push", "origin", "codex/mission-delivery");
    assert.equal(git(bare, "rev-parse", "refs/heads/codex/mission-delivery"), git(fixture.root, "rev-parse", "HEAD"));
    assert.equal(git(bare, "for-each-ref", "--format=%(refname)", "refs/heads/codex/squad-"), "");
    verifyPrCommand(fixture.parent);
    fixture.finish(
      leader.dispatchId,
      JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Delivery\n\nIntegrated child evidence; local PR command verified.",
      }),
    );
    await fixture.waitStatus((state) => state.status === "converged");
    const launches = fixture.providers.length;
    await fixture.reopen();
    const recovered = await fixture.status();
    assert.equal(recovered.status, "converged");
    assert.equal(recovered.leaders.length, 2);
    assert.equal(fixture.providers.length, launches, "reopening the center must not dispatch another leader");
  },
);

for (const restart of [false, true])
  test(
    `targeted task publishes while same-squad child stays local (restart=${restart})`,
    { timeout: 30_000 },
    async (t) => {
      const fixture = await openFixture(t, "publication-owner");
      await fixture.plan(["a.txt"], ["b.txt"]);
      const running = await fixture.waitStatus(
        (state) => state.workers.length === 2 && state.workers.every((w) => w.runtimeSessionId),
      );
      const child = running.workers[0],
        taskId = "task-direct-targeted",
        created = await fixture.cell.run(
          {
            kind: "task-create",
            taskId,
            title: "Direct targeted",
            presetId: "docs-task",
          },
          binding,
        );
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(fixture.cell, created.opId, binding);
      await realizeTaskPlanFixture(fixture.root, String((created as Record<string, unknown>).packagePath), (planPath) =>
        fixture.cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      assert.equal((await fixture.cell.run({ kind: "task-start", taskId }, binding)).outcome, "applied");
      const cwd = path.join(fixture.root, ".worktrees", "direct-targeted");
      await fixture.cell.settlePendingMaterialization("before direct branch");
      git(fixture.root, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(fixture.root, "worktree", "add", "-b", "codex/direct-targeted", cwd);
      const direct = await fixture.cell.spawnRuntime(
        {
          runtimeInstanceId: "stub",
          agentId: "leader",
          targetAgentId: "one",
          taskId,
          cwd: { scope: "repo-relative", path: ".worktrees/direct-targeted" },
          prompt: "Deliver the directly targeted task.",
          idempotencyKey: "direct-targeted",
        },
        binding,
      );
      const childHeader = readDispatchStreamHeader(fixture.root, child.dispatchId!)!,
        directHeader = readDispatchStreamHeader(fixture.root, String(direct.dispatchId))!;
      assert.equal(childHeader.squadId, "squad");
      assert.equal(directHeader.squadId, childHeader.squadId);
      assert.equal(childHeader.publicationOwner, "commander");
      assert.equal(directHeader.publicationOwner, "runtime");
      for (const directory of [child.worktree!.cwd, cwd]) {
        writeFileSync(path.join(directory, "a.txt"), "delivery\n");
        git(directory, "add", "a.txt");
        git(directory, "commit", "-qm", "feat: targeted delivery");
      }
      fixture.finish(child.dispatchId!, "child delivery", 0, restart);
      fixture.finish(String(direct.dispatchId), "direct delivery", 0, restart);
      if (restart) await fixture.reopen();
      await fixture.waitStatus((state) => state.workerCallbackCount >= 1);
      await fixture.cell.settlePendingMaterialization("publication owner");
      const rows = (await fixture.cell.read("repo.task.dispatches", { taskId })).dispatches;
      assert.equal(rows[0]?.outcome, "succeeded");
      const childRows = (await fixture.cell.read("repo.task.dispatches", { taskId: child.taskId! })).dispatches;
      assert.equal(childRows[0]?.outcome, "succeeded");
      assert.equal(
        readFileSync(path.join(fixture.root, "harness", childRows[0].reportPath!), "utf8").trim(),
        "child delivery",
      );
      const report = readFileSync(path.join(fixture.root, "harness", rows[0].reportPath!), "utf8");
      assert.match(report, /Worker branch pushed at settlement: codex\/direct-targeted/u);
      assert.equal(
        git(fixture.bare, "for-each-ref", "--format=%(objectname)", "refs/heads/codex/direct-targeted"),
        git(cwd, "rev-parse", "HEAD"),
      );
      assert.equal(git(fixture.bare, "for-each-ref", "--format=%(refname)", "refs/heads/codex/squad-"), "");
    },
  );

test("failed child wakes the leader with the failure after its sibling settles", { timeout: 30_000 }, async (t) => {
  const fixture = await openFixture(t, "failure");
  await fixture.plan(["a.txt"], ["b.txt"]);
  const running = await fixture.waitStatus(
    (state) => state.workers.length === 2 && state.workers.every((w) => w.runtimeSessionId),
  );
  fixture.finish(running.workers[0].dispatchId!, "child could not complete", 1);
  await fixture.waitStatus((state) => state.workerCallbackCount === 1);
  assert.equal((await fixture.status()).leaders.length, 1);
  fixture.finish(running.workers[1].dispatchId!, "sibling completed");
  const resumed = await fixture.waitStatus((state) => state.leaders.length === 2);
  const leader = fixture.providers.find((p) => p.dispatchId === resumed.leaders[1].dispatchId)!;
  assert.match(leader.prompt, /failed/u);
  fixture.finish(
    leader.dispatchId,
    JSON.stringify({
      schema: "squad-decision/v1",
      action: "converged",
      report: "# Failure review\n\nChild failed; delivery is incomplete.",
    }),
  );
  await fixture.waitStatus((state) => state.status === "converged");
});

test("overlapping worker declarations reject the second child before execution", { timeout: 30_000 }, async (t) => {
  const fixture = await openFixture(t, "overlap");
  await fixture.plan(["src/"], ["SRC/a.txt"]);
  const state = await fixture.waitStatus((value) => value.workers.length === 2);
  assert.ok(state.workers[0].runtimeSessionId);
  assert.match(state.workers[1].rejection ?? "", /Ownership conflict/u);
  assert.equal(state.workers[1].taskId, null);
  assert.equal(state.workers[1].runtimeSessionId, null);
  fixture.finish(state.workers[0].dispatchId!, "first child completed");
  const resumed = await fixture.waitStatus((value) => value.leaders.length === 2);
  fixture.finish(
    resumed.leaders[1].dispatchId,
    JSON.stringify({
      schema: "squad-decision/v1",
      action: "converged",
      report: "# Overlap\n\nConflicting child rejected.",
    }),
  );
  await fixture.waitStatus((value) => value.status === "converged");
});

test(
  "a real parent runtime actor dispatches child plans through its canonical parent lease",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await openFixture(t, "runtime-caller", true);
    await fixture.plan(["a.txt"], ["b.txt"]);
    const running = await fixture.waitStatus(
      (state) => state.workers.length === 2 && state.workers.every((w) => w.runtimeSessionId),
    );
    for (const child of running.workers) {
      assert.ok(child.taskId && child.executionId);
      assert.equal(fixture.task(child.taskId).snapshot.task?.metadata?.parentTaskId, fixture.taskId);
      fixture.finish(child.dispatchId!, "runtime caller child delivery");
    }
    const resumed = await fixture.waitStatus((state) => state.leaders.length === 2 && state.workerCallbackCount === 2);
    assert.equal(resumed.pendingLeaderCallbackCount, 0, "same-cut child outcomes are consumed by one leader turn");
    fixture.finish(
      resumed.leaders[1].dispatchId,
      JSON.stringify({
        schema: "squad-decision/v1",
        action: "converged",
        report: "# Runtime caller\n\nChild plans published under the actual parent runtime identity.",
      }),
    );
    await fixture.waitStatus((state) => state.status === "converged");
    fixture.finish(fixture.parentDispatchId!, "parent caller completed");
  },
);

async function openFixture(t: { after(fn: () => Promise<void>): void }, slug: string, runtimeCaller = false) {
  const parent = mkdtempSync(path.join(tmpdir(), `ha-squad-e2e-${slug}-`)),
    root = path.join(parent, "repo"),
    repoId = workspaceId(`squad-e2e-${slug}`),
    taskId = `task-squad-e2e-${slug}`,
    providers: Provider[] = [];
  mkdirSync(root);
  initRepo(root);
  const bare = path.join(parent, "remote.git");
  git(parent, "init", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  mkdirSync(path.join(root, "harness"));
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: docs-task\n  defaultProfile: baseline\n",
  );
  writeFileSync(path.join(root, ".gitignore"), "harness/\n.harness/\n.worktrees/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-qm", "test: fixture boundaries");
  const runtimeLaunch: RuntimeLauncher = (prepared, persistence) => {
    const provider: Provider = {
      prompt: prepared.prompt,
      cwd: prepared.cwd,
      dispatchId: persistence.dispatchId,
      sessionId: prepared.args[0] ?? `provider-${persistence.dispatchId}`,
    };
    providers.push(provider);
    return {
      pid: process.pid,
      onOutput: (listener) => {
        provider.output = listener;
        queueMicrotask(() =>
          listener(JSON.stringify({ type: "thread.started", thread_id: provider.sessionId }) + "\n"),
        );
      },
      onErrorOutput: () => undefined,
      onExit: (listener) => {
        provider.exit = listener;
      },
      terminate: () => undefined,
    };
  };
  const open = () =>
    openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: `squad-${slug}`,
      runtimeDaemonRoute: {
        userRoot: path.join(parent, "user"),
        daemonId: "test",
        endpoint: path.join(parent, "socket"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: "stub",
          name: "Stub",
          kindId: "codex",
          installationId: "installation-stub",
          providerId: "openai",
          models: ["stub-model"],
          defaultModel: "stub-model",
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: "subscription",
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId: "installation-stub",
          kindId: "codex",
          providerId: "openai",
          model: "stub-model",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
        installation: {
          installationId: "installation-stub",
          kindId: "codex",
          executablePath: "/fixture/stub",
          version: "1.0.0",
          observedAt: "2026-09-20T00:00:00.000Z",
        },
        executablePath: "/fixture/stub",
        args: request.providerSessionId ? [request.providerSessionId] : [],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch,
    });
  let cell = await open();
  t.after(async () => {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  });
  for (const [id, role] of [
    ["leader", "commander"],
    ["one", "worker"],
    ["two", "worker"],
  ]) {
    const receipt = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id,
          name: id,
          role,
          instructions: "Perform the assigned role.",
          runtimes: [{ type: "codex" }],
        },
      },
      binding,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  }
  const installed = await cell.run(
    {
      kind: "squad-install",
      declaration: {
        schema: "squad-declaration/v1",
        id: "squad",
        name: "Squad",
        leader: "leader",
        workers: ["one", "two"],
        leaderTurnBudget: 4,
        roster: "Leader integrates two independent workers and writes artifacts/reports/{squadRunId}.md.",
      },
    },
    binding,
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  const created = await cell.run(
    { kind: "task-create", taskId, title: "Squad mission", presetId: "docs-task" },
    binding,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, binding);
  await realizeTaskPlanFixture(root, String((created as Record<string, unknown>).packagePath), (planPath) =>
    cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
  );
  let squadBinding = binding,
    parentDispatchId: string | null = null;
  if (runtimeCaller) {
    const executing = await cell.run({ kind: "task-start", taskId }, binding);
    assert.equal(executing.outcome, "applied", JSON.stringify(executing));
    const caller = await cell.spawnRuntime(
      {
        runtimeInstanceId: "stub",
        agentId: "leader",
        taskId,
        cwd: { scope: "repo-root" },
        prompt: "Coordinate the mission through squad-run.",
        idempotencyKey: "parent-caller",
      },
      binding,
    );
    parentDispatchId = String(caller.dispatchId);
    squadBinding = {
      ...binding,
      actor: {
        ...binding.actor,
        executor: { kind: "agent", id: `runtime-session:${String(caller.runtimeSessionId)}` },
      },
    };
  }
  const started = await cell.run(
    { kind: "squad-run", squadId: "squad", taskId, runtimeInstanceId: "stub", cwd: { scope: "repo-root" } },
    squadBinding,
  );
  assert.equal(started.outcome, "completed", JSON.stringify(started));
  const squadRunId = String(evidence(started).squadRunId);
  const status = async () =>
    evidence(await cell.run({ kind: "squad-status", squadRunId }, binding)) as unknown as Status;
  const task = (id: string) => {
    const projection = makeTaskProjection({
      rootDir: root,
      eventStore: makeTaskEventReader({ repoId, rootDir: root }),
    });
    try {
      projection.catchUp();
      return projection.read(id);
    } finally {
      projection.close();
    }
  };
  const finish = (dispatchId: string, text: string, code = 0, offline = false) => {
    const provider = providers.find((row) => row.dispatchId === dispatchId)!;
    if (offline)
      appendRuntimeWorkerRecord(root, dispatchId, {
        kind: "process_started",
        occurredAt: new Date().toISOString(),
        pid: process.pid,
      });
    for (const event of [
      { type: "thread.started", thread_id: provider.sessionId },
      {
        type: "item.completed",
        item: {
          id: "write",
          type: "file_change",
          changes: [{ path: "delivery.txt", kind: "add" }],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "result", type: "agent_message", text },
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]) {
      if (offline)
        appendRuntimeWorkerRecord(root, dispatchId, {
          kind: "provider_event",
          occurredAt: new Date().toISOString(),
          event,
        });
      else provider.output!(JSON.stringify(event) + "\n");
    }
    appendRuntimeWorkerRecord(root, dispatchId, {
      kind: "process_exit",
      occurredAt: new Date().toISOString(),
      exitCode: code,
      signal: null,
    });
    if (!offline) provider.exit!(code);
  };
  const waitStatus = async (predicate: (state: Status) => unknown) => {
    let last: Status | undefined;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      last = await status();
      if (predicate(last)) return last;
      if (last.status === "failed") throw new Error(JSON.stringify(last));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Squad did not reach expected state: ${JSON.stringify(last)}`);
  };
  return {
    parent,
    root,
    bare,
    repoId,
    taskId,
    get cell() {
      return cell;
    },
    providers,
    status,
    task,
    finish,
    waitStatus,
    parentDispatchId,
    reopen: async () => {
      await cell.close();
      cell = await open();
    },
    plan: async (first: string[], second: string[]) => {
      const state = await status();
      finish(
        state.leaders[0].dispatchId,
        JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [
            { to: "one", prompt: realizedTaskPlan("worker mission one"), ownedPaths: first },
            { to: "two", prompt: realizedTaskPlan("worker mission two"), ownedPaths: second },
          ],
        }),
      );
    },
    submit: async (child: WorkerAttempt, head: string) => {
      await cell.settlePendingMaterialization("child closeout fixture");
      const row = task(child.taskId!),
        holder = {
          ...binding,
          actor: {
            principal: binding.actor.principal,
            executor: { kind: "agent" as const, id: `runtime-session:${child.runtimeSessionId}` },
          },
        };
      writeFileSync(
        path.join(root, "harness", row.packagePath!, "closeout.md"),
        `# Closeout\n\n## Summary\n\nDelivered ${head}.\n\n## Verification\n\nCommitted child file contents inspected.\n\n## Residual Risk\n\nIntegration review remains.\n\n## Same Mechanism Elsewhere\n\nSibling delivery uses the same protocol.\n`,
      );
      const receipt = await cell.run(
        { kind: "task-submit", taskId: child.taskId!, executionId: child.executionId! },
        holder,
      );
      assert.equal(receipt.outcome, "applied", `real child submit: ${JSON.stringify(receipt)}`);
    },
  };
}

function verifyPrCommand(root: string) {
  const template = readFileSync(new URL("../../../.github/pull_request_template.md", import.meta.url), "utf8"),
    bodyPath = path.join(root, "pr-body.md"),
    script = path.join(root, "gh-stub.cjs"),
    receipt = path.join(root, "pr-command.json");
  const sections: Record<string, string> = {
    Summary: "Integrate the two child commits after inspecting the delivered files and ownership finding.",
    "Architectural Justification": "Use the existing squad coordinator and independent child tasks. No new scheduler.",
    "What Changed": "The integration branch contains src/a.txt, docs/b.txt, and the reported outside.txt finding.",
    "Gate Harvest / 门收割": "Deleted-Production-Paths: none\nDeleted-Gates-Fixtures: none",
    "Machine-Readable Declarations": "This isolated fixture changes no dependencies or event schema.",
    "Optional Evidence Claims": "This is a local command protocol observation, not a GitHub CI claim.",
    "Task And Scope": "Task: isolated squad fixture. Branch: codex/mission-delivery. Scope: the child commits.",
    "Version Impact": "No version change: isolated fixture delivery only.",
    "Governance Declaration":
      "Protected surface touched: no. Break-glass: no. Test artifacts stay in the temporary repository.",
    Verification:
      "Both children submitted through task-submit. File contents were inspected; the bare remote ref equals integration HEAD.",
    "Per-Write Cost": "Not applicable: this fixture PR contains document files only.",
    "Review Evidence": "Assigned fixture-reviewer. Reviewer approval and GitHub CI remain unverified.",
    "Residual Risk": "outside.txt is an ownership finding requiring integration review. No real GitHub PR is created.",
    References: "Evidence: child submission events, ownership report, and the captured local PR command receipt.",
    概要: "检查两个子任务提交与所有权发现后，将其合流到集成分支。",
    架构辩护: "复用现有小队协调器和独立子任务，没有新增调度器。",
    改动内容: "集成分支包含 src/a.txt、docs/b.txt 以及已报告的 outside.txt 越界文件。",
    "门收割 / Gate Harvest": "本演练没有删除生产路径或门。",
    机读声明说明: "演练不修改依赖或事件 schema。",
    任务与范围: "任务为隔离小队演练，分支 codex/mission-delivery，范围为两个子任务提交。",
    版本影响: "只交付隔离夹具，不修改版本。",
    治理声明: "没有修改 protected surface，也没有 break-glass。产物仅存临时仓库。",
    验证: "两个子任务真实调用 task-submit；核验交付文件和 bare remote 的集成 HEAD。",
    单次写入成本: "不适用：本演练 PR 只有文档文件。",
    审查证据: "已传入 fixture-reviewer 参数。实际评审批准与 GitHub CI 均为 unverified。",
    残余风险: "outside.txt 的越界发现需要集成审查。本测试没有创建真实 GitHub PR。",
    关联材料: "证据为子任务提交事件、所有权报告与本地 PR 命令回执。",
    "PR Gate Checklist / PR 门禁清单":
      "Local integration and command arguments checked. Real CI and reviewer approval unverified.\n本地集成与命令参数已核验，真实 CI 和评审批准未验证。",
  };
  const body = [...template.matchAll(/^(#{1,3}) (.+)$/gmu)]
    .map(([, level, heading]) => {
      if (heading === "English" || heading === "中文") return `${level} ${heading}\n`;
      assert.ok(sections[heading], `fixture must fill template section ${heading}`);
      return `${level} ${heading}\n\n${sections[heading]}\n`;
    })
    .join("\n")
    .replace("# 中文", "---\n\n# 中文");
  writeFileSync(bodyPath, body);
  writeFileSync(
    script,
    `const fs = require('node:fs'); const args = process.argv.slice(2);\nif(args[0] !== 'pr' || args[1] !== 'create' || !args.includes('--reviewer')) process.exit(2);\nconst body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');\nif(!body.includes('# English') || !body.includes('# 中文') || !body.includes('## Verification')) process.exit(3);\nfs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({args, body}));\n`,
  );
  assert.throws(() => execFileSync(process.execPath, [script, "pr", "create", "--body-file", bodyPath]));
  execFileSync(process.execPath, [
    script,
    "pr",
    "create",
    "--head",
    "codex/mission-delivery",
    "--title",
    "Integrate squad delivery",
    "--body-file",
    bodyPath,
    "--reviewer",
    "fixture-reviewer",
  ]);
  const captured = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(captured.args.slice(0, 4), ["pr", "create", "--head", "codex/mission-delivery"]);
  assert.equal(captured.body, readFileSync(bodyPath, "utf8"));
}
