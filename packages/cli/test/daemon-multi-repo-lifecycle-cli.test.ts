// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";

import { cli, git, register, run, runMaybe, setup, stop } from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("real CLI reaches one resident multi-workspace daemon and publishes Git event -> SQLite -> receipt", async () => {
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
    assert.equal(factRecord.commitSha, null);
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
        relations: [],
      }),
      decisionPropose = run(fixture.alpha, fixture.userRoot, ["decision", "propose", "--json-input", decisionPacket]);
    assert.equal(decisionPropose.outcome, "applied", JSON.stringify(decisionPropose));
    const decision = JSON.parse(String(decisionPropose.evidence)) as {
        decisionId: string;
        state: string;
      },
      decisionPath = `decisions/decision-${decision.decisionId}/decision.md`,
      beforeAccepted = makeTaskEventStore({
        rootDir: fixture.alpha,
        repoId: "alpha",
      }).readHead()!.revision;
    assert.equal(decision.state, "proposed");
    assert.equal(decisionPropose.path, decisionPath);
    assert.equal(decisionPropose.worktreeVisible, true);
    assert.equal(decisionPropose.commitSha, null);
    assert.ok(decisionPropose.cut);
    assert.match(String(decisionPropose.documentSha256), /^[0-9a-f]{64}$/u);
    assert.match(
      readFileSync(path.join(fixture.alpha, "harness", decisionPath), "utf8"),
      /^---\nschema: decision-package\/v1[\s\S]*\nstate: proposed[\s\S]*\n---\n\n# Canonical Decision from CLI\n$/u,
    );
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
      makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).readHead()?.revision,
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
    const canonicalEvents = makeTaskEventStore({
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
    assert.equal(progress.commitSha, null);
    assert.ok(progress.cut);
    assert.equal(progress.worktreeVisible, true);
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
    // The daemon's background local-repair reconciliation (repo-cell settleAuthoredCandidates, fired on
    // every WAL flush) is the same idempotent doc-sync as this explicit submit; it may incorporate the
    // freshly authored doc into canonical first. So this submit either applies it ("applied") or finds it
    // already reconciled ("no_changes") — both mean the doc reached canonical, which the doc show below is
    // the real proof of. Asserting a single outcome raced the background reconciliation (flake).
    const notesSubmit = run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--task", "task-alpha"]);
    assert.ok(
      notesSubmit.outcome === "applied" || notesSubmit.outcome === "no_changes",
      `submit must reconcile the authored doc (applied or no_changes), saw ${JSON.stringify(notesSubmit)}`,
    );
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
    writeFileSync(blockedFile, "# Stable\n");
    // Same background local-repair reconciliation as the notes submit above (repo-cell
    // settleAuthoredCandidates): it may incorporate this freshly authored doc first, which leaves this
    // explicit submit nothing to apply. Both outcomes mean the doc reached canonical.
    const stableSubmit = run(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit", "--path", blockedPath]);
    assert.ok(
      stableSubmit.outcome === "applied" || stableSubmit.outcome === "no_changes",
      `submit must reconcile the authored doc (applied or no_changes), saw ${JSON.stringify(stableSubmit)}`,
    );
    writeFileSync(blockedFile, "# Renamed\n");
    writeFileSync(path.join(fixture.alpha, "harness", eligiblePath), "# Eligible\n");
    // The background reconciliation issues this exact command — doc-submit over an empty selection.
    // Whichever sweep runs first applies context/this-session.md and skips the blocked
    // context/other-session.md; the sweep that runs second has no eligible row left and rejects on the
    // blocked row alone, which is the decided contract (doc-sync-slice-a-implicit-lease: "a blocked-only
    // implicit submit must reject without publishing an event"). Asserting one outcome raced that sweep
    // (flake). What holds either way: the blocked path is reported against its missing base region, the
    // eligible doc reaches canonical, and the blocked edit does not.
    const partial = runMaybe(fixture.alpha, fixture.userRoot, ["doc", "sync", "--submit"]),
      blockedTouch = 'context/other-session.md\tbase region is missing: "# Stable"';
    if (partial.status === 0) {
      assert.equal(partial.receipt.outcome, "applied", JSON.stringify(partial.receipt));
      assert.match(
        String(partial.receipt.summary),
        /doc-submit: applied[\s\S]*skipped:[\s\S]*context\/other-session\.md\tblocked\tbase region is missing: "# Stable"/u,
      );
    } else {
      assert.equal(partial.receipt.outcome, "op_rejected", JSON.stringify(partial.receipt));
      assert.equal(partial.receipt.code, "preview_blocked", JSON.stringify(partial.receipt));
      assert.deepEqual(
        (
          partial.receipt.detail as { unresolvedTouches?: readonly { path: string; reason: string }[] }
        ).unresolvedTouches?.map((touch) => `${touch.path}\t${touch.reason}`),
        [blockedTouch],
        JSON.stringify(partial.receipt),
      );
    }
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", eligiblePath]).evidence,
      "# Eligible\n",
    );
    assert.equal(run(fixture.alpha, fixture.userRoot, ["doc", "show", "--path", blockedPath]).evidence, "# Stable\n");
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
    assert.equal((spoof.error as { code?: string }).code, "invalid_request");
    const logicalRevisions = new Map([
      [fixture.alpha, makeTaskEventStore({ rootDir: fixture.alpha, repoId: "alpha" }).read().revision],
      [fixture.beta, makeTaskEventStore({ rootDir: fixture.beta, repoId: "beta" }).read().revision],
    ]);
    stop(fixture.alpha, fixture.userRoot); // explicit drain: Git/fresh readers catch up after acknowledged visibility
    for (const root of [fixture.alpha, fixture.beta]) {
      const gitHead = JSON.parse(git(root, "show", "refs/ha/canonical:harness/events/head.json")) as {
        revision: number;
      };
      assert.equal(gitHead.revision, logicalRevisions.get(root));
      assert.equal(
        git(root, "ls-tree", "--name-only", "refs/ha/canonical", "harness/events").includes("harness/events"),
        true,
      );
      assert.equal(existsSync(path.join(root, ".harness/cache/task.sqlite")), true);
      assert.equal(existsSync(path.join(root, ".harness/write-journal")), false);
    }
    assert.equal(
      git(fixture.alpha, "grep", "-l", "fact-event/v1", "refs/ha/canonical", "--", "harness/events").includes(
        "harness/events",
      ),
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
    const childEvent = makeTaskEventStore({
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
