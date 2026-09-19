// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

// Windows teardown: rmSync below cannot remove a ledger file while one of this process's readers
// still holds it open (nightly EPERM), so every reader opened in a test is drained before cleanup.
const trackLedgerReaders = () => {
  const readers: Array<ReturnType<typeof makeTaskEventReader>> = [];
  return {
    open: (rootDir: string, repoId: string) => {
      const reader = makeTaskEventReader({ rootDir, repoId });
      readers.push(reader);
      return reader;
    },
    drain: async () => {
      await Promise.all(readers.map((reader) => reader.drain()));
    },
  };
};

import {
  builtCli,
  cli,
  git,
  gitLedgerWriter,
  median,
  register,
  run,
  runMaybe,
  runNoop,
  settleFollower,
  setup,
  setupEmpty,
  stop,
} from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("real CLI reaches one resident multi-workspace daemon and accepts in SQLite before Git follower verification", async () => {
  const fixture = setup(),
    ledgerReaders = trackLedgerReaders();
  try {
    const noDaemon = runMaybe(fixture.alpha, fixture.userRoot, [
      "daemon",
      "repo",
      "register",
      "--repo-id",
      "alpha",
      "--root",
      fixture.alpha,
      "--no-link",
    ]);
    assert.notEqual(noDaemon.status, 0);
    assert.equal((noDaemon.receipt.error as { code?: string }).code, "daemon_unavailable");
    assert.equal(existsSync(path.join(fixture.userRoot, "registry.json")), false);
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    await register(fixture.alpha, fixture.userRoot, "alpha");
    await register(fixture.beta, fixture.userRoot, "beta");
    const alphaPreview = run(fixture.alpha, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-alpha",
      "--admin",
      "--title",
      "Alpha",
      "--dry-run",
    ]);
    assert.equal(alphaPreview.dryRun, true);
    assert.equal(alphaPreview.packagePath, "tasks/task-alpha-alpha");
    assert.equal(existsSync(path.join(fixture.alpha, "harness/tasks/task-alpha-alpha")), false);
    const textPreview = spawnSync(
      process.execPath,
      [
        cli,
        "--root",
        fixture.alpha,
        "task",
        "create",
        "--id",
        "task-alpha",
        "--admin",
        "--title",
        "Alpha",
        "--dry-run",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(fixture.alpha, ".home"),
          GIT_CONFIG_GLOBAL: "/dev/null",
          HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
        },
      },
    );
    assert.equal(textPreview.status, 0, textPreview.stderr);
    assert.equal(
      textPreview.stdout.trim(),
      [
        "would create task task-alpha at harness/tasks/task-alpha-alpha",
        "preset: standard-task/baseline",
        "outputShape: repository-diff",
        'completionGates: ["code-doc-reconciliation"]',
        "contract: repository-diff requires a committable public-repository diff, " +
          "real CI, and a code-doc reconciliation witness. For a task-package-only " +
          "report or decision, use the task-package-artifact preset docs-task.",
        "next: remove --dry-run to publish this exact resolved scaffold",
        "plan: write the concrete plan at harness/tasks/task-alpha-alpha/task_plan.md; required sections: Brief, " +
          "Goal, Context, Required Reading, Entry Conditions, Dependencies, Execution Surface, Constraints, " +
          "Checkpoint, CI/Gate Authority Stop Condition, Implementation Plan, Deliverable Contract, Evidence " +
          "Protocol, Verification",
        "agenda: use ha task pin task-alpha to pin it to the CEO agenda",
        "ledger: INDEX.md and closeout.md are coordinator-managed; update them through ha doc sync",
      ].join("\n"),
    );
    const alpha = run(fixture.alpha, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-alpha",
      "--admin",
      "--title",
      "Alpha",
    ]);
    const beta = run(fixture.beta, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-beta",
      "--admin",
      "--title",
      "Beta",
    ]);
    assert.equal(alpha.outcome, "applied", JSON.stringify(alpha));
    assert.equal(beta.outcome, "applied", JSON.stringify(beta));
    assert.equal(alpha.summary, "created task task-alpha at harness/tasks/task-alpha-alpha");
    settleFollower(fixture.alpha, fixture.userRoot, alpha);
    const alphaPlan = `${String(alpha.packagePath)}/task_plan.md`;
    writeFileSync(path.join(fixture.alpha, "harness", alphaPlan), realizedTaskPlan("Alpha"));
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--path", alphaPlan]).outcome,
      "applied",
    );
    const factRecord = run(fixture.alpha, fixture.userRoot, [
      "fact",
      "record",
      "--task",
      "task-alpha",
      "--statement",
      "Canonical Fact from CLI",
      "--source",
      "integration",
    ]);
    assert.equal(factRecord.outcome, "applied", JSON.stringify(factRecord));
    assert.match(String(settleFollower(fixture.alpha, fixture.userRoot, factRecord).commitSha), /^[0-9a-f]{40}$/u);
    assert.ok(factRecord.cut);
    const fact = JSON.parse(String(factRecord.evidence)) as {
      factId: string;
      state: string;
    };
    assert.equal(fact.state, "standing");
    const factShow = JSON.parse(
      String(run(fixture.alpha, fixture.userRoot, ["fact", "show", "--id", fact.factId]).evidence),
    ) as { fact: { statement: string } };
    assert.equal(factShow.fact.statement, "Canonical Fact from CLI");
    const decisionPacket = JSON.stringify({
        title: "Canonical Decision from CLI",
        question: "Should the real CLI own this Decision?",
        riskTier: "medium",
        urgency: "medium",
        vertical: "default",
        preset: "default",
        decisionClass: "ordinary",
        appliesTo: { modules: ["kernel"], productLines: [] },
        chosen: [{ id: "CH1", text: "Use events" }],
        rejected: [{ id: "RJ1", text: "Use files", whyNot: "Not canonical" }],
        claims: [],
        fulfillments: [],
      }),
      decisionPropose = run(fixture.alpha, fixture.userRoot, ["decision", "propose", "--json-input", decisionPacket]);
    assert.equal(decisionPropose.outcome, "applied", JSON.stringify(decisionPropose));
    const decision = JSON.parse(String(decisionPropose.evidence)) as {
        decisionId: string;
        state: string;
      },
      decisionPath = `decisions/decision-${decision.decisionId}/decision.md`;
    assert.equal(decision.state, "proposed");
    assert.equal(decisionPropose.path, decisionPath);
    assert.match(String(settleFollower(fixture.alpha, fixture.userRoot, decisionPropose).commitSha), /^[0-9a-f]{40}$/u);
    assert.ok(decisionPropose.cut);
    assert.match(String(decisionPropose.documentSha256), /^[0-9a-f]{64}$/u);
    const scaffoldPattern = new RegExp(
      "^---\\nschema: decision-package/v1[\\s\\S]*\\nstate: proposed[\\s\\S]*\\n---\\n\\n" +
        "# Canonical Decision from CLI\\n\\n## 背景\\n\\n说明需要裁定的问题与已知事实。\\n\\n" +
        "## 权衡\\n\\n说明所选方案、被拒方案与取舍理由。\\n\\n" +
        "## 结论\\n\\n说明最终裁定及其适用范围。\\n\\n" +
        "<!-- harness:relation-neighborhood:start -->\\n## 关联图谱 \\(Causal Graph\\)\\n\\n- none\\n\\n\\n" +
        "<!-- harness:relation-neighborhood:end -->\\n$",
      "u",
    );
    assert.match(readFileSync(path.join(fixture.alpha, "harness", decisionPath), "utf8"), scaffoldPattern);
    const decisionFile = path.join(fixture.alpha, "harness", decisionPath),
      decisionBody = readFileSync(decisionFile, "utf8"),
      bodyStart = decisionBody.indexOf("\n# Canonical Decision from CLI");
    assert.notEqual(bodyStart, -1);
    writeFileSync(
      decisionFile,
      decisionBody.slice(0, bodyStart) +
        "\n\n# Canonical Decision from CLI\n\n" +
        "## 背景\n\nThe real CLI must exercise the decision lifecycle.\n\n" +
        "## 权衡\n\nUse the event-backed path instead of direct document writes.\n\n" +
        "## 结论\n\nUse the event-backed lifecycle selected by this fixture.\n",
    );
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--path", decisionPath]).outcome,
      "applied",
    );
    const beforeAccepted = ledgerReaders.open(fixture.alpha, "alpha").readHead()!.revision;
    const acceptedDecision = run(fixture.alpha, fixture.userRoot, [
      "decision",
      "accept",
      decision.decisionId,
      "--rationale",
      "CEO approval",
      "--judgment-only",
      "CEO explicitly judges without evidence",
    ]);
    assert.equal(acceptedDecision.outcome, "applied");
    assert.match(String(acceptedDecision.consentId), /^djc_[0-9a-f]{26}$/u);
    assert.equal(ledgerReaders.open(fixture.alpha, "alpha").readHead()?.revision, beforeAccepted + 1);
    const decisionList = JSON.parse(
      String(run(fixture.alpha, fixture.userRoot, ["decision", "list", "--search", "Canonical Decision"]).evidence),
    ) as { decisions: readonly { decisionId: string }[] };
    assert.deepEqual(
      decisionList.decisions.map((row) => row.decisionId),
      [decision.decisionId],
    );
    assert.deepEqual(
      (
        JSON.parse(
          String(run(fixture.alpha, fixture.userRoot, ["decision", "list", "--search", "Uncanonical"]).evidence),
        ) as { decisions: readonly { decisionId: string }[] }
      ).decisions,
      [],
    );
    const decisionShow = JSON.parse(
      String(run(fixture.alpha, fixture.userRoot, ["decision", "show", decision.decisionId]).evidence),
    ) as { decision: { decisionId: string; body: unknown } };
    assert.equal(decisionShow.decision.decisionId, decision.decisionId);
    assert.equal(decisionShow.decision.body, null);
    const reckon = run(fixture.alpha, fixture.userRoot, [
      "decision",
      "reckon",
      decision.decisionId,
      "--task",
      "task-alpha",
    ]);
    assert.equal(reckon.outcome, "applied", JSON.stringify(reckon));
    const reckonFact = JSON.parse(String(reckon.evidence)) as {
      evidenceSource: string;
      statement: string;
    };
    assert.match(reckonFact.evidenceSource, new RegExp(`^decision/${decision.decisionId}@\\d+$`, "u"));
    assert.match(reckonFact.statement, /no load-bearing claims/u);
    const canonicalEvents = ledgerReaders.open(fixture.alpha, "alpha").read().events;
    assert.equal(
      canonicalEvents.some((event) => event.schema === "decision-event/v1" && event.decisionId === decision.decisionId),
      true,
    );
    assert.equal(
      canonicalEvents.some(
        (event) => event.schema === "fact-event/v1" && event.payload.evidenceSource === reckonFact.evidenceSource,
      ),
      true,
    );
    assert.match(String(run(fixture.alpha, fixture.userRoot, ["task", "show", "task-alpha"]).evidence), /Alpha/u);
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["task", "start", "task-alpha", "--execution-id", "exec-doc"]).outcome,
      "applied",
    );
    const progress = run(fixture.alpha, fixture.userRoot, [
      "task",
      "progress",
      "append",
      "task-alpha",
      "--text",
      "CLI progress is canonical.",
      "--evidence",
      "test:reports/cli.txt:passed",
    ]);
    assert.equal(progress.progressPath, "tasks/task-alpha-alpha/progress.md");
    assert.equal(progress.summary, "appended progress for task-alpha at harness/tasks/task-alpha-alpha/progress.md");
    assert.match(String(settleFollower(fixture.alpha, fixture.userRoot, progress).commitSha), /^[0-9a-f]{40}$/u);
    assert.ok(progress.cut);
    assert.match(String(progress.evidence), /file:tasks\/task-alpha-alpha\/progress\.md/u);
    assert.match(
      readFileSync(path.join(fixture.alpha, "harness/tasks/task-alpha-alpha/progress.md"), "utf8"),
      /CLI progress is canonical\..*Evidence: test:reports\/cli\.txt:passed/su,
    );
    const docPath = "tasks/task-alpha-alpha/notes.md",
      docBody = "# CLI canonical document\n",
      authored = path.join(fixture.alpha, "harness", docPath);
    mkdirSync(path.dirname(authored), { recursive: true });
    writeFileSync(authored, docBody);
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "status", "--path", docPath]).outcome, "applied");
    const reader = ledgerReaders.open(fixture.alpha, "alpha");
    const beforeFlush = reader.read().events.filter((event) => event.type === "documents_written");
    const flushTrigger = run(fixture.alpha, fixture.userRoot, [
      "task",
      "progress",
      "append",
      "task-alpha",
      "--text",
      "Flush with unsubmitted prose present.",
    ]);
    settleFollower(fixture.alpha, fixture.userRoot, flushTrigger);
    const afterFlushStatus = run(fixture.alpha, fixture.userRoot, ["doc", "status", "--path", docPath]);
    assert.match(String(afterFlushStatus.evidence), /"state":"eligible"/u);
    assert.deepEqual(
      reader.read().events.filter((event) => event.type === "documents_written"),
      beforeFlush,
    );
    const notesSubmit = run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--path", docPath]);
    assert.equal(notesSubmit.outcome, "applied", JSON.stringify(notesSubmit));
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", docPath]).evidence, docBody);
    const cleanSubmit = runMaybe(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--path", docPath]);
    assert.equal(cleanSubmit.status, 0, cleanSubmit.stderr);
    assert.equal(cleanSubmit.receipt.ok, true, JSON.stringify(cleanSubmit.receipt));
    assert.equal(cleanSubmit.receipt.outcome, "no_changes", JSON.stringify(cleanSubmit.receipt));
    assert.equal(cleanSubmit.receipt.code, "no_changes");
    const invalidSubmit = runMaybe(fixture.alpha, fixture.userRoot, [
      "doc",
      "sync",
      "--submit",
      "--path",
      "context/missing.md",
    ]);
    assert.equal(invalidSubmit.status, 1, JSON.stringify(invalidSubmit.receipt));
    assert.equal(invalidSubmit.receipt.ok, false, JSON.stringify(invalidSubmit.receipt));
    assert.equal(invalidSubmit.receipt.outcome, "op_rejected");
    assert.equal(invalidSubmit.receipt.code, "document_not_found");
    const blockedPath = "context/other-session.md",
      eligiblePath = "context/this-session.md",
      blockedFile = path.join(fixture.alpha, "harness", blockedPath);
    mkdirSync(path.dirname(blockedFile), { recursive: true });
    const stableMachineDocument = "---\nschema: stable\n---\n# Stable\n";
    writeFileSync(blockedFile, stableMachineDocument);
    const stableSubmit = run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--path", blockedPath]);
    assert.equal(stableSubmit.outcome, "applied", JSON.stringify(stableSubmit));
    settleFollower(fixture.alpha, fixture.userRoot, stableSubmit);
    writeFileSync(blockedFile, "---\nschema: changed\n---\n# Stable\n");
    writeFileSync(path.join(fixture.alpha, "harness", eligiblePath), "# Eligible\n");
    const partial = runMaybe(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--all"]);
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(partial.receipt.outcome, "applied", JSON.stringify(partial.receipt));
    assert.match(
      String(partial.receipt.summary),
      /doc-submit: applied[\s\S]*blocked \(not submitted; owning task and required route shown\):[\s\S]*context\/other-session\.md\tblocked\ttask=-\trequiredRoute=typed-machine-writer\tmachine region changed/u,
    );
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", eligiblePath]).evidence,
      "# Eligible\n",
    );
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", blockedPath]).evidence,
      stableMachineDocument,
    );
    const spoof = await requestLocalDaemonJsonRpc(
      fixture.alpha,
      "repo.task.create",
      {
        repo: { repoId: "alpha" },
        payload: {
          taskId: "task-spoof",
          title: "Spoof",
          actor: { principal: { personId: "attacker" } },
        },
      },
      100,
      { userRoot: fixture.userRoot },
    );
    assert.equal(spoof.ok, false);
    assert.equal((spoof.error as { code?: string }).code, "unknown_field");
    const logicalRevisions = new Map([
      [fixture.alpha, ledgerReaders.open(fixture.alpha, "alpha").read().revision],
      [fixture.beta, ledgerReaders.open(fixture.beta, "beta").read().revision],
    ]);
    stop(fixture.alpha, fixture.userRoot); // Drain the event-derived follower before independent Git read-back.
    for (const root of [fixture.alpha, fixture.beta]) {
      const manifest = JSON.parse(git(root, "show", "HEAD:harness/events/segments/manifest.json")) as {
        schema: string;
        generation: number;
        cut: { revision: number };
      };
      assert.equal(manifest.schema, "sqlite-ledger-segment-manifest/v1");
      assert.equal(manifest.generation, 2);
      assert.equal(manifest.cut.revision, logicalRevisions.get(root));
      assert.equal(
        git(root, "ls-tree", "-r", "--name-only", "HEAD", "harness/events").trim(),
        "harness/events/segments/manifest.json",
      );
      assert.equal(existsSync(path.join(root, ".harness/cache/task.sqlite")), true);
      assert.equal(existsSync(path.join(root, ".harness/write-journal")), false);
    }
    assert.equal(
      ledgerReaders
        .open(fixture.alpha, "alpha")
        .read()
        .events.some((event) => event.schema === "fact-event/v1"),
      true,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    await ledgerReaders.drain();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real CLI creates module and subtask-expansion packages through their declared providers", async () => {
  const fixture = setup(),
    ledgerReaders = trackLedgerReaders();
  try {
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    await register(fixture.alpha, fixture.userRoot, "alpha");
    const catalog = JSON.parse(String(run(fixture.alpha, fixture.userRoot, ["preset", "list"]).evidence)) as Array<{
      id: string;
      validity: string;
    }>;
    assert.deepEqual(
      catalog
        .filter(({ id }) => ["module", "subtask-expansion"].includes(id))
        .map(({ id, validity }) => ({ id, validity })),
      [
        { id: "module", validity: "valid" },
        { id: "subtask-expansion", validity: "valid" },
      ],
    );
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["task", "create", "--id", "task-parent", "--admin", "--title", "Parent"])
        .outcome,
      "applied",
    );
    const moduleTask = run(fixture.alpha, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-module",
      "--admin",
      "--title",
      "Module task",
      "--preset",
      "module",
      "--module",
      "kernel",
      "--register-module",
      "kernel",
      "--module-title",
      "Kernel",
      "--module-prefix",
      "KER",
      "--module-scope",
      "packages/kernel/**",
    ]);
    assert.equal(moduleTask.outcome, "applied", JSON.stringify(moduleTask));
    settleFollower(fixture.alpha, fixture.userRoot, moduleTask);
    assert.deepEqual(
      (moduleTask.generatedPaths as string[])
        .filter((target) => /(?:module\.md|module_(?:plan|brief|session_prompt)\.md)$/u.test(target))
        .map((target) => path.basename(target))
        .sort(),
      ["module.md", "module_brief.md", "module_plan.md", "module_session_prompt.md"],
    );
    assert.match(
      readFileSync(path.join(fixture.alpha, "harness/tasks/task-module-module-task/module.md"), "utf8"),
      /Module key: kernel[\s\S]*Module title: Kernel[\s\S]*Module prefix: KER[\s\S]*Module scope: packages\/kernel\/\*\*/u,
    );
    const child = run(fixture.alpha, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-child",
      "--admin",
      "--title",
      "Child",
      "--preset",
      "subtask-expansion",
      "--parent",
      "task-parent",
    ]);
    assert.equal(child.outcome, "applied", JSON.stringify(child));
    const childEvent = ledgerReaders
      .open(fixture.alpha, "alpha")
      .read()
      .events.find((event) => event.schema === "task-bootstrap-event/v1" && event.taskId === "task-child");
    assert.equal(
      childEvent?.schema === "task-bootstrap-event/v1" ? childEvent.payload.task.metadata.parentTaskId : null,
      "task-parent",
    );
    const children = JSON.parse(
      String(run(fixture.alpha, fixture.userRoot, ["task", "list", "--parent", "task-parent"]).evidence),
    ) as { rows: Array<{ taskId: string }> };
    assert.deepEqual(
      children.rows.map(({ taskId }) => taskId),
      ["task-child"],
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    await ledgerReaders.drain();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resident daemon CLI write p50 includes process startup through parsed receipt", async (context) => {
  const fixture = setup();
  try {
    // npm is npm.cmd on Windows, and Node refuses to execute a .cmd directly, so this failed
    // with ENOENT before the measurement even started -- a launcher defect wearing a
    // performance test's clothes. A shell resolves the shim; the arguments here are literals.
    execFileSync("npm", ["run", "build", "--workspace", "@harness-anything/cli"], {
      cwd: process.cwd(),
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"], builtCli).ok, true);
    await register(fixture.alpha, fixture.userRoot, "alpha", builtCli);
    // Warm two short rounds before measuring. GitHub's runner has a cold page/cache
    // penalty that is absent on the developer machine; one measured sample reached
    // 357ms while load stayed at 0.33. Warmup absorbs that one-time penalty, while
    // measured rounds still alternate arm order and use medians so a scheduler pause
    // affects one sample, not a verdict. The baseline is the same compiled CLI's
    // no-op help path: it includes process startup, static module loading, and argument
    // handling, while returning before a daemon request or a persisted write.
    const warmupRounds = 2,
      rounds = 5,
      samplesPerRound = 3,
      cliSamples: number[] = [],
      noopSamples: number[] = [],
      ratios: number[] = [],
      loadSamples: number[] = [];
    for (let warmup = 0; warmup < warmupRounds; warmup += 1) {
      for (let sample = 0; sample < samplesPerRound; sample += 1) {
        const id = warmup * samplesPerRound + sample;
        const first = (warmup + sample) % 2 === 0;
        const warmCli = (): void => {
          const receipt = run(
            fixture.alpha,
            fixture.userRoot,
            ["task", "create", "--id", `task-latency-warmup-${id}`, "--admin", "--title", `Latency warmup ${id}`],
            builtCli,
          );
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        };
        const warmNoop = (): void => {
          assert.equal(runNoop(fixture.alpha, fixture.userRoot, builtCli).status, 0);
        };
        if (first) {
          warmCli();
          warmNoop();
        } else {
          warmNoop();
          warmCli();
        }
      }
    }
    for (let round = 0; round < rounds; round += 1) {
      const cliRound: number[] = [],
        noopRound: number[] = [];
      for (let sample = 0; sample < samplesPerRound; sample += 1) {
        const index = round * samplesPerRound + sample;
        const measureCli = (): void => {
          const started = performance.now();
          const receipt = run(
            fixture.alpha,
            fixture.userRoot,
            ["task", "create", "--id", `task-latency-${index}`, "--admin", "--title", `Latency ${index}`],
            builtCli,
          );
          assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
          const elapsed = performance.now() - started;
          cliSamples.push(elapsed);
          cliRound.push(elapsed);
        };
        const measureNoop = (): void => {
          const started = performance.now();
          assert.equal(runNoop(fixture.alpha, fixture.userRoot, builtCli).status, 0);
          const elapsed = performance.now() - started;
          noopSamples.push(elapsed);
          noopRound.push(elapsed);
        };
        if ((round + sample) % 2 === 0) {
          measureCli();
          measureNoop();
        } else {
          measureNoop();
          measureCli();
        }
      }
      ratios.push(median(cliRound) / median(noopRound));
      loadSamples.push(loadavg()[0] / availableParallelism());
    }
    const p50 = median(cliSamples),
      noopP50 = median(noopSamples),
      startupRatio = median(ratios);
    const orderedRatios = [...ratios].sort((left, right) => left - right);
    context.diagnostic(
      `latency-window=before-cli-process-spawn-through-exit-and-parsed-receipt samples=${cliSamples.length} p50=${p50.toFixed(3)}ms min=${Math.min(...cliSamples).toFixed(3)}ms max=${Math.max(...cliSamples).toFixed(3)}ms`,
    );
    context.diagnostic(
      `latency-baseline=compiled-cli-help-noop samples=${noopSamples.length} p50=${noopP50.toFixed(3)}ms min=${Math.min(...noopSamples).toFixed(3)}ms max=${Math.max(...noopSamples).toFixed(3)}ms`,
    );
    context.diagnostic(
      `latency-ratio=paired-round-cli-write-over-cli-help-noop warmup-rounds=${warmupRounds} rounds=${ratios.length} samples-per-round=${samplesPerRound} p50=${startupRatio.toFixed(3)}x min=${orderedRatios[0]!.toFixed(3)}x max=${orderedRatios.at(-1)!.toFixed(3)}x load1-per-parallelism=${loadSamples.map((value) => value.toFixed(2)).join(",")}`,
    );
    context.diagnostic(`latency-round-ratios=${ratios.map((value) => value.toFixed(3)).join(",")}`);
  } finally {
    stop(fixture.alpha, fixture.userRoot, builtCli);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("U-12 Configure-Verify failure keeps the canonical publication and returns an honest partial receipt", () => {
  const fixture = setup(),
    configPath = path.join(fixture.alpha, "harness/harness.yaml"),
    overlayPath = path.join(fixture.alpha, "harness/governance/task-scaffold.json");
  try {
    writeFileSync(
      configPath,
      "layout:\n  authoredRoot: harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n  locale: en-US\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance/repository-scaffold.json\n",
    );
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, "{}\n");
    git(fixture.alpha, "add", "harness");
    git(fixture.alpha, "commit", "--quiet", "-m", "invalid task overlay");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      result = runMaybe(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]),
      ledgerRoot = path.join(fixture.alpha, "harness");
    assert.notEqual(result.status, 0);
    assert.equal(result.receipt.outcome, "partial");
    assert.equal((result.receipt.error as { code?: string }).code, "configure_verify_failed");
    assert.match(String((result.receipt.error as { hint?: string }).hint), /^init Configure-Verify smoke failed:/u);
    assert.equal((result.receipt.publication as { ok: boolean }).ok, true);
    assert.match(String(result.receipt.commit), /^[0-9a-f]{40}$/u);
    assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), before);
    assert.equal((result.receipt.created as string[]).length > 0, true);
    assert.match(String(result.receipt.next), /daemon status/u);
    const stream = makeTaskEventReader({
      rootDir: fixture.alpha,
      repoId: "alpha",
    }).read();
    assert.equal(
      git(ledgerRoot, "ls-tree", "-r", "--name-only", "HEAD")
        .split("\n")
        .some((target) => target.startsWith("tasks/")),
      false,
    );
    assert.equal(stream.revision, 2);
    assert.equal(stream.events[0]?.schema, "settings-event/v1");
    assert.equal(stream.events[1]?.schema, "vertical-declaration-event/v1");
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing c606 pair upgrades additively and explicit name is the only config byte change", () => {
  const fixture = setup();
  try {
    const configPath = path.join(fixture.alpha, "harness/harness.yaml"),
      peoplePath = path.join(fixture.alpha, "harness/people.yaml"),
      originalConfig = readFileSync(configPath, "utf8"),
      originalPeople = readFileSync(peoplePath, "utf8");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const additive = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(additive.outcome, "applied");
    assert.deepEqual(additive.updated, []);
    assert.equal((additive.created as string[]).includes("harness/harness.yaml"), false);
    assert.equal((additive.created as string[]).includes("harness/people.yaml"), false);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.equal(readFileSync(peoplePath, "utf8"), originalPeople);
    const named = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--name",
      "Alpha Project",
    ]);
    assert.equal(named.outcome, "applied");
    assert.deepEqual(named.created, []);
    assert.deepEqual(named.updated, ["harness/harness.yaml#name"]);
    assert.equal(readFileSync(configPath, "utf8"), `name: "Alpha Project"\n${originalConfig}`);
    assert.equal(readFileSync(peoplePath, "utf8"), originalPeople);
    const same = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--name",
      "Alpha Project",
    ]);
    assert.equal(same.outcome, "noop");
    assert.deepEqual(same.created, []);
    assert.deepEqual(same.updated, []);
    assert.equal(same.commit, null);
    assert.equal(readFileSync(configPath, "utf8"), `name: "Alpha Project"\n${originalConfig}`);
    const renamed = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
      "--name",
      "Renamed",
    ]);
    assert.deepEqual(renamed.updated, ["harness/harness.yaml#name"]);
    assert.equal(readFileSync(configPath, "utf8"), `name: "Renamed"\n${originalConfig}`);
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("partial bootstrap pair fails closed before any scaffold write", () => {
  const fixture = setupEmpty();
  try {
    mkdirSync(path.join(fixture.repo, "harness"));
    writeFileSync(path.join(fixture.repo, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n");
    assert.equal(run(fixture.repo, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const before = readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"),
      rejected = runMaybe(fixture.repo, fixture.userRoot, [
        "init",
        "--repo-id",
        "partial",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.notEqual(rejected.status, 0);
    assert.equal((rejected.receipt.error as { code?: string }).code, "bootstrap_incomplete");
    assert.equal(readFileSync(path.join(fixture.repo, "harness/harness.yaml"), "utf8"), before);
    assert.equal(existsSync(path.join(fixture.repo, "harness/people.yaml")), false);
    assert.equal(existsSync(path.join(fixture.repo, "harness/context")), false);
    assert.equal(existsSync(path.join(fixture.repo, ".git")), false);
  } finally {
    stop(fixture.repo, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("existing architecture assets remain byte-owned and a half model is not completed", () => {
  const fixture = setup();
  try {
    const architectureRoot = path.join(fixture.alpha, "harness/context/architecture"),
      readme = "# Project Architecture\n\nProject-owned without builtin anchors.\n",
      manifest = '{"schema":"project-architecture/v1"}\n',
      nodes = '{"nodes":["owned"]}\n';
    mkdirSync(path.join(architectureRoot, "model"), { recursive: true });
    writeFileSync(path.join(architectureRoot, "README.md"), readme);
    writeFileSync(path.join(architectureRoot, "manifest.json"), manifest);
    writeFileSync(path.join(architectureRoot, "model/nodes.json"), nodes);
    git(fixture.alpha, "add", "harness/context/architecture");
    git(fixture.alpha, "commit", "--quiet", "-m", "partial architecture");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const initialized = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal(readFileSync(path.join(architectureRoot, "README.md"), "utf8"), readme);
    assert.equal(readFileSync(path.join(architectureRoot, "manifest.json"), "utf8"), manifest);
    assert.equal(readFileSync(path.join(architectureRoot, "model/nodes.json"), "utf8"), nodes);
    assert.equal(existsSync(path.join(architectureRoot, "model/edges.json")), false);
    assert.equal(existsSync(path.join(architectureRoot, "view")), false);
    assert.equal((initialized.preserved as string[]).includes("harness/context/architecture/README.md"), true);
    assert.equal((initialized.drifted as string[]).includes("harness/context/architecture/README.md"), true);
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("repository overlay is additive, preserves authored prose, and rejects an invalid plan before publication", () => {
  const fixture = setup();
  try {
    const custom = "# Existing Context\n\nOwned by the project.\n",
      customAgents = "# Existing Agents\n\nProject-owned.\n",
      customClaude = "# Existing Claude\n\nProject-owned.\n",
      config =
        "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance-repository-scaffold.json\n",
      people = readFileSync(path.join(fixture.alpha, "harness/people.yaml"), "utf8");
    mkdirSync(path.join(fixture.alpha, "harness/context"), { recursive: true });
    writeFileSync(path.join(fixture.alpha, "harness/context/README.md"), custom);
    writeFileSync(path.join(fixture.alpha, "AGENTS.md"), customAgents);
    writeFileSync(path.join(fixture.alpha, "CLAUDE.md"), customClaude);
    writeFileSync(
      path.join(fixture.alpha, "harness/templates-architecture.md"),
      "# Architecture\n\n## Purpose\n\nCustom.\n\n## Opt-in Boundary\n\nNo model.\n",
    );
    writeFileSync(
      path.join(fixture.alpha, "harness/templates-project.md"),
      "# Project\n\n## Project Notes\n\nCustom.\n",
    );
    writeFileSync(
      path.join(fixture.alpha, "harness/governance-repository-scaffold.json"),
      `${JSON.stringify({ schema: "repository-scaffold/v1", replaceTemplate: [{ slot: "repository.context.architecture", template: "templates-architecture.md" }], addDocument: [{ slot: "repository.context.project", path: "harness/context/project.md", template: "templates-project.md", requiredAnchors: ["## Project Notes"] }] })}\n`,
    );
    writeFileSync(path.join(fixture.alpha, "harness/harness.yaml"), config);
    git(fixture.alpha, "add", "harness", "AGENTS.md", "CLAUDE.md");
    git(fixture.alpha, "commit", "--quiet", "-m", "repository overlay");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      initialized = run(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.equal(initialized.outcome, "applied");
    assert.equal(readFileSync(path.join(fixture.alpha, "harness/harness.yaml"), "utf8"), config);
    assert.equal(readFileSync(path.join(fixture.alpha, "harness/people.yaml"), "utf8"), people);
    assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/README.md"), "utf8"), custom);
    assert.equal(readFileSync(path.join(fixture.alpha, "AGENTS.md"), "utf8"), customAgents);
    assert.equal(readFileSync(path.join(fixture.alpha, "CLAUDE.md"), "utf8"), customClaude);
    for (const target of ["harness/context/README.md", "AGENTS.md", "CLAUDE.md"])
      assert.equal((initialized.drifted as string[]).includes(target), true, target);
    assert.equal(
      readFileSync(path.join(fixture.alpha, "harness/context/architecture/README.md"), "utf8").includes("Custom."),
      true,
    );
    assert.equal(
      readFileSync(path.join(fixture.alpha, "harness/context/project.md"), "utf8").includes("Project Notes"),
      true,
    );
    assert.match(String((initialized.plan as { projectOverlayDigest?: string }).projectOverlayDigest), /^sha256:/u);
    const stream = makeTaskEventReader({
      rootDir: fixture.alpha,
      repoId: "alpha",
    }).read();
    assert.equal(stream.revision, 2);
    assert.equal(stream.events[0]?.schema, "settings-event/v1");
    assert.equal(stream.events[1]?.schema, "vertical-declaration-event/v1");
    assert.equal(
      stream.events[0]?.schema === "settings-event/v1" ? stream.events[0].payload.settings.scaffolds.repository : null,
      "governance-repository-scaffold.json",
    );
    assert.notEqual(initialized.commit, before);
    stop(fixture.alpha, fixture.userRoot);
    const invalid = setup();
    writeFileSync(
      path.join(invalid.alpha, "harness/harness.yaml"),
      "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: invalid.json\n",
    );
    writeFileSync(path.join(invalid.alpha, "harness/invalid.json"), "{}\n");
    git(invalid.alpha, "add", "harness");
    git(invalid.alpha, "commit", "--quiet", "-m", "invalid overlay");
    assert.equal(run(invalid.alpha, invalid.userRoot, ["daemon", "start", "--service"]).ok, true);
    const invalidHead = git(invalid.alpha, "rev-parse", "HEAD"),
      invalidStatus = git(invalid.alpha, "status", "--porcelain"),
      rejected = runMaybe(invalid.alpha, invalid.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.notEqual(rejected.status, 0);
    assert.equal((rejected.receipt.error as { code?: string }).code, "invalid_repository_scaffold");
    assert.equal(git(invalid.alpha, "rev-parse", "HEAD"), invalidHead);
    assert.equal(git(invalid.alpha, "status", "--porcelain"), invalidStatus);
    assert.equal(existsSync(path.join(invalid.alpha, "harness/context")), false);
    stop(invalid.alpha, invalid.userRoot);
    rmSync(invalid.root, { recursive: true, force: true });
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a changed overlay path leaves the prior authored document and reports it as governance drift", () => {
  const fixture = setup();
  try {
    const config =
        "layout:\n  authoredRoot: harness\nsettings:\n  scaffolds:\n    task: governance/task-scaffold.json\n    repository: governance/repository-scaffold.json\n",
      overlayPath = path.join(fixture.alpha, "harness/governance/repository-scaffold.json"),
      templatePath = path.join(fixture.alpha, "harness/project-notes.md"),
      overlay = (target: string) =>
        `${JSON.stringify({ schema: "repository-scaffold/v1", replaceTemplate: [], addDocument: [{ slot: "repository.context.project", path: target, template: "project-notes.md", requiredAnchors: ["## Project Notes"] }] })}\n`;
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(path.join(fixture.alpha, "harness/harness.yaml"), config);
    writeFileSync(templatePath, "# Project\n\n## Project Notes\n\nOwned.\n");
    writeFileSync(overlayPath, overlay("harness/context/old-project.md"));
    git(fixture.alpha, "add", "harness");
    git(fixture.alpha, "commit", "--quiet", "-m", "add project document");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const first = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.equal((first.created as string[]).includes("harness/context/old-project.md"), true);
    const oldBody = readFileSync(path.join(fixture.alpha, "harness/context/old-project.md"), "utf8"),
      ledgerRoot = path.join(fixture.alpha, "harness");
    stop(fixture.alpha, fixture.userRoot);
    writeFileSync(overlayPath, overlay("harness/context/new-project.md"));
    git(ledgerRoot, "add", "governance/repository-scaffold.json");
    // Constructing the out-of-band overlay change means committing inside the
    // ledger repository itself; the fixture plays that writer via the marker.
    gitLedgerWriter(ledgerRoot, "commit", "--quiet", "-m", "change project document path");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const changed = run(fixture.alpha, fixture.userRoot, [
      "init",
      "--repo-id",
      "alpha",
      "--person-id",
      "owner",
      "--display-name",
      "Owner",
    ]);
    assert.deepEqual(changed.created, ["harness/context/new-project.md"]);
    assert.equal((changed.drifted as string[]).includes("harness/context/old-project.md"), true);
    assert.match(String(changed.next), /governance/iu);
    assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/old-project.md"), "utf8"), oldBody);
    assert.equal(readFileSync(path.join(fixture.alpha, "harness/context/new-project.md"), "utf8"), oldBody);
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("old-only standards fail closed before repository scaffold publication", () => {
  const fixture = setup();
  try {
    mkdirSync(path.join(fixture.alpha, "harness/standards"), {
      recursive: true,
    });
    writeFileSync(path.join(fixture.alpha, "harness/standards/README.md"), "# Legacy standards\n");
    git(fixture.alpha, "add", "harness/standards");
    git(fixture.alpha, "commit", "--quiet", "-m", "legacy standards");
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    const before = git(fixture.alpha, "rev-parse", "HEAD"),
      status = git(fixture.alpha, "status", "--porcelain"),
      rejected = runMaybe(fixture.alpha, fixture.userRoot, [
        "init",
        "--repo-id",
        "alpha",
        "--person-id",
        "owner",
        "--display-name",
        "Owner",
      ]);
    assert.notEqual(rejected.status, 0);
    const error = rejected.receipt.error as { code?: string };
    assert.equal(error.code, "standards_migration_required");
    assert.equal(git(fixture.alpha, "rev-parse", "HEAD"), before);
    assert.equal(git(fixture.alpha, "status", "--porcelain"), status);
    assert.equal(existsSync(path.join(fixture.alpha, "harness/governance")), false);
    assert.equal(existsSync(path.join(fixture.alpha, "harness/context")), false);
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
