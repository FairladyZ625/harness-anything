// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

import {
  cli,
  git,
  register,
  run,
  runMaybe,
  settleFollower,
  setup,
  stop,
} from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("real CLI reaches one resident multi-workspace daemon and accepts in SQLite before Git follower verification", async () => {
  const fixture = setup();
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
    register(fixture.alpha, fixture.userRoot, "alpha");
    register(fixture.beta, fixture.userRoot, "beta");
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
        "would create task task-alpha at tasks/task-alpha-alpha",
        "preset: standard-task/baseline",
        "outputShape: repository-diff",
        'completionGates: ["ci","code-doc-reconciliation"]',
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
    const factSearch = JSON.parse(
      String(run(fixture.alpha, fixture.userRoot, ["fact", "search", "Canonical", "--task", "task-alpha"]).evidence),
    ) as { facts: readonly { factId: string }[] };
    assert.deepEqual(
      factSearch.facts.map((row) => row.factId),
      [fact.factId],
    );
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
        "## 结论\\n\\n说明最终裁定及其适用范围。\\n$",
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
    const beforeAccepted = makeTaskEventReader({
      rootDir: fixture.alpha,
      repoId: "alpha",
    }).readHead()!.revision;
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
    assert.equal(
      makeTaskEventReader({ rootDir: fixture.alpha, repoId: "alpha" }).readHead()?.revision,
      beforeAccepted + 1,
    );
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
    const canonicalEvents = makeTaskEventReader({
      rootDir: fixture.alpha,
      repoId: "alpha",
    }).read().events;
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
    const reader = makeTaskEventReader({ rootDir: fixture.alpha, repoId: "alpha" });
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
      /doc-submit: applied[\s\S]*skipped:[\s\S]*context\/other-session\.md\tblocked\tmachine region changed/u,
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
      [fixture.alpha, makeTaskEventReader({ rootDir: fixture.alpha, repoId: "alpha" }).read().revision],
      [fixture.beta, makeTaskEventReader({ rootDir: fixture.beta, repoId: "beta" }).read().revision],
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
      makeTaskEventReader({ rootDir: fixture.alpha, repoId: "alpha" })
        .read()
        .events.some((event) => event.schema === "fact-event/v1"),
      true,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real CLI creates module and subtask-expansion packages through their declared providers", () => {
  const fixture = setup();
  try {
    assert.equal(run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
    register(fixture.alpha, fixture.userRoot, "alpha");
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
    const childEvent = makeTaskEventReader({
      rootDir: fixture.alpha,
      repoId: "alpha",
    })
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
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
