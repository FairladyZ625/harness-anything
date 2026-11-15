// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import {
  cli,
  createRuntimeFixture,
  installIdentities,
  readPublishedDispatch,
  runMaybe,
  seedTask,
} from "./runtime-cli.fixtures.ts";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { workspaceId } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { waitForPromise, waitForValue } from "../../../tools/fixtures/wait-for-condition.ts";
import {
  eventuallyFile,
  eventuallyRuntimeStatus,
  killProcessIfAlive,
  readDispatchRecords,
  run,
  runAsync,
} from "./runtime-cli.fixtures.ts";

// F-3AC0AFF0: a worker handed ledger paths that resolve only under the canonical checkout takes that checkout for
// its repository root and edits source there. A task-worktree dispatch names one root, and every path resolves in it.
test("a task-worktree dispatch hands the worker only paths under its own root, ledger included", async (context) => {
  const fixture = createRuntimeFixture(context),
    { parent, root, env } = fixture;
  gitRepository(root);
  installIdentities(parent, root, env);
  // The worker reads its plan and writes into its task package through the package root the mission names.
  writeProviderExecutable(
    path.join(parent, "bin", "codex"),
    [
      'const fs = require("node:fs"), path = require("node:path");',
      "const args = process.argv.slice(2);",
      `if (args[0] === "--version") { console.log("codex ${fixture.version}"); process.exit(0); }`,
      'if (args[0] === "login" && args[1] === "status") process.exit(0);',
      'const prompt = fs.readFileSync(0, "utf8");',
      'const packageRoot = prompt.split("Task package root: ")[1].split("\\n")[0];',
      'const taskId = prompt.split("Canonical Task ID: ")[1].split("\\n")[0];',
      'const destination = path.relative(process.cwd(), packageRoot).split(path.sep).join("/") + "/artifacts/worker-probe.json";',
      'const plan = fs.readFileSync(path.join(packageRoot, "task_plan.md"), "utf8");',
      // The CLI run from the worker root still reaches the registered repository, not the worktree as a repository.
      `const shown = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "show", taskId], { encoding: "utf8", env: process.env });`,
      "const probe = { cwd: process.cwd(), packageRoot, plan, prompt, shown: { status: shown.status, stdout: shown.stdout, stderr: shown.stderr } };",
      // New files in a worker-local task package are published through the artifact command. The command transcript
      // is the canonical artifact; its stdout carries the probe bytes without reaching into the canonical checkout.
      `const publish = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(cli)}, "--root", process.cwd(), "--json", "task", "artifact", "add", taskId, "--run", "--destination", destination, "--", process.execPath, "-e", "process.stdout.write(process.env.WORKER_PROBE)"], { encoding: "utf8", env: { ...process.env, WORKER_PROBE: JSON.stringify(probe) } });`,
      'if (publish.status !== 0) { process.stderr.write("artifact publish failed: " + publish.stdout + publish.stderr); process.exit(8); }',
      'console.log(JSON.stringify({ type: "thread.started", thread_id: "provider-cli-session" }));',
      'console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "final" } }));',
      'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));',
      "",
    ].join("\n"),
  );
  const task = seedTask(root, env, "wt-worker-root"),
    canonical = realpathSync(root),
    worktree = path.join(canonical, ".worktrees", task.taskId);
  // The probe worker writes its artifact but commits nothing and submits nothing, so the dispatch
  // stops without a submitted delivery and exits 1; the path scoping below is what this case verifies.
  const probeRun = runMaybe(root, env, ["agent", "run", "terra", "--task", task.taskId, "--no-stream"]);
  assert.equal(probeRun.status, 1, `${probeRun.stderr}\n${JSON.stringify(probeRun.receipt)}`);
  assert.equal(probeRun.receipt.outcome, "stopped", `${probeRun.stderr}\n${JSON.stringify(probeRun.receipt)}`);
  // The probe was written through the worker root and is read here from the canonical ledger: one ledger.
  const transcript = JSON.parse(await readPublishedDispatch(path.join(task.artifactRoot, "worker-probe.json"))) as {
    readonly stdout: string;
  };
  const probe = JSON.parse(transcript.stdout) as {
    readonly cwd: string;
    readonly packageRoot: string;
    readonly plan: string;
    readonly prompt: string;
    readonly shown: { readonly status: number | null; readonly stdout: string; readonly stderr: string };
  };

  assert.equal(probe.cwd, worktree, "the worker process runs in its task worktree");
  assert.equal(probe.packageRoot, path.join(worktree, task.packagePath));
  assert.equal(probe.plan, readFileSync(path.join(root, task.packagePath, "task_plan.md"), "utf8"));
  assert.equal(probe.shown.status, 0, probe.shown.stdout + probe.shown.stderr);
  assert.ok(probe.shown.stdout.includes(task.taskId), probe.shown.stdout);
  assert.match(probe.prompt, new RegExp(`^Worker repository root: ${escapeRegExp(worktree)}$`, "mu"));
  const reviewSkillLine = probe.prompt.split("\n").find((line) => line.startsWith("- review: "));
  assert.ok(reviewSkillLine, probe.prompt);
  assert.match(reviewSkillLine!, /ledger-files[/\\]skills[/\\]review[/\\]SKILL\.md$/u);
  assert.doesNotMatch(probe.prompt, /Canonical repository root/u);
  assert.deepEqual(
    probe.prompt
      .replaceAll(worktree, "<worker-root>")
      .split("\n")
      .filter((line) => line.includes(canonical)),
    [],
    "outside its own root the worker is never told where the canonical checkout is",
  );
  // Static entry files may retain canonical ledger references for owner guidance. Runtime path consumers receive
  // worker-local paths above; the only ledger content materialized in the checkout is this task's package.
  assert.equal(existsSync(path.join(worktree, task.packagePath, "task_plan.md")), true);
  // The link is invisible to git in the worktree, and nothing was written into the canonical checkout's source.
  assert.equal(git(worktree, "status", "--short"), "");
  assert.equal(git(root, "diff", "--name-only"), "");
});

function gitRepository(root: string): void {
  const remote = path.join(path.dirname(root), "origin.git"),
    ignore = path.join(root, ".gitignore");
  git(path.dirname(root), "init", "--bare", "-q", remote);
  git(root, "config", "user.name", "Worktree Demo");
  git(root, "config", "user.email", "worktree@example.invalid");
  writeFileSync(ignore, `${readFileSync(ignore, "utf8")}node_modules/\n`);
  writeFileSync(path.join(root, "README.md"), "demo\n");
  git(root, "add", ".gitignore", "README.md", "AGENTS.md", "CLAUDE.md");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "-M", "main");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

for (const afterResult of [false, true])
  test(
    `runtime status --wait settles a killed native host (result=${afterResult})`,
    {
      skip: process.platform === "win32" ? "requires POSIX SIGKILL kill point semantics" : false,
    },
    async (context) => {
      const { parent, root, env, version } = createRuntimeFixture(context);
      installIdentities(parent, root, env);
      const pidPath = path.join(parent, "lost-provider.pid");
      writeProviderExecutable(
        path.join(parent, "bin", "codex"),
        `
      const fs = require("node:fs");
      if (process.argv[2] === "--version") { console.log("codex ${version}"); process.exit(0); }
      if (process.argv[2] === "login") process.exit(0);
      fs.readFileSync(0, "utf8");
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      console.log(JSON.stringify({ type: "thread.started", thread_id: "lost-provider-session" }));
      if (${afterResult}) console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
      setInterval(() => {}, 1000);
    `,
      );
      const { taskId } = seedTask(root, env, `host-loss-${afterResult}`);
      const spawned = run(root, env, [
        "agent",
        "run",
        "terra",
        "--prompt",
        "host loss",
        "--cwd",
        ".",
        "--task",
        taskId,
        "--detach",
      ]);
      const sessionId = String(spawned.runtimeSessionId),
        dispatchId = String(spawned.dispatchId);
      await eventuallyFile(pidPath);
      await eventuallyRuntimeStatus(root, env, sessionId, "live");
      if (afterResult) {
        await waitForValue(
          () =>
            readDispatchRecords(root, dispatchId).some(
              (record) =>
                record.kind === "provider_event" && (record.event as Record<string, unknown>).type === "turn.completed",
            )
              ? true
              : null,
          `dispatch ${dispatchId} provider result to be durable before killing the host`,
          { describeLast: () => JSON.stringify(readDispatchRecords(root, dispatchId)) },
        );
      }
      const hostPid = Number(
        readDispatchRecords(root, dispatchId).find((record) => record.kind === "process_started")!.pid,
      );
      try {
        const wait = runAsync(root, env, ["runtime", "status", sessionId, "--wait", "--no-stream"]);
        process.kill(hostPid, "SIGKILL");
        const result = await waitForPromise(wait, "runtime status --wait to settle after host loss");
        context.diagnostic(`native host loss invocation: ${JSON.stringify(result)}`);
        // dec_614F7BBB18C8687E7EFC72173D/CH3: a lost host has no process-exit evidence.
        assert.equal(result.receipt.outcome, "unknown", JSON.stringify(result));
        assert.equal(result.status, 1, JSON.stringify(result));
        assert.equal(typeof result.receipt.nextAction, "string", JSON.stringify(result));
        assert.ok(String(result.receipt.nextAction).includes(taskId));
        const settledSession = result.receipt.session as {
          associations?: readonly { taskId?: string; lease?: { phase?: string } }[];
        };
        assert.equal(
          settledSession.associations?.find((association) => association.taskId === taskId)?.lease?.phase,
          "released",
          "the stopped provider must release its task lease before the terminal outcome",
        );
        const reader = makeTaskEventReader({ repoId: workspaceId("runtime-cli"), rootDir: root }),
          projection = makeTaskProjection({ rootDir: root, eventStore: reader });
        try {
          const lifecycle = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [dispatchId] });
          assert.equal(lifecycle.status, "ready");
          assert.equal(lifecycle.rows[0]?.attempt.stopProof, "proven_stopped");
          assert.equal(lifecycle.rows[0]?.attempt.task?.leaseReleased, true);
          assert.equal(lifecycle.rows[0]?.groupPhase, "closed");
          const events = reader.read().events,
            exitIndex = events.findIndex(
              (event) => event.type === "runtime_session_exited" && event.payload.runtimeSessionId === sessionId,
            ),
            releaseIndexes = events.flatMap((event, index) =>
              event.type === "lease_released" && event.taskId === taskId ? [index] : [],
            ),
            outcomeIndex = events.findIndex(
              (event) =>
                event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === sessionId,
            );
          assert.equal(releaseIndexes.length, 1, "the matching lease is released exactly once");
          assert.ok(exitIndex >= 0 && exitIndex < releaseIndexes[0]! && releaseIndexes[0]! < outcomeIndex);
        } finally {
          projection.close();
          await reader.drain();
        }
        const dispatches = runMaybe(root, env, ["task", "dispatches", taskId]).receipt.dispatches as Record<
          string,
          unknown
        >[];
        const row = dispatches.find((candidate) => candidate.dispatchId === dispatchId)!;
        // Public dispatch status is the accepted outcome; process loss remains in the owner's stream below.
        assert.deepEqual({ status: row.status, outcome: row.outcome }, { status: "unknown", outcome: "unknown" });
        assert.match(JSON.stringify(result.receipt), /no longer alive/u);
        const records = readDispatchRecords(root, dispatchId);
        assert.ok(records.some((record) => record.kind === "process_lost"));
        assert.equal(
          records.some((record) => record.kind === "process_exit"),
          false,
        );
        if (afterResult)
          assert.ok(
            records.some(
              (record) =>
                record.kind === "provider_event" && (record.event as Record<string, unknown>).type === "turn.completed",
            ),
          );
        context.diagnostic(`native host loss: ${JSON.stringify(result.receipt)}`);
      } finally {
        killProcessIfAlive(Number(readFileSync(pidPath, "utf8")));
      }
    },
  );
