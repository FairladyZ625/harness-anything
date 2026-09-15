// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseRuntimeBatchEntry } from "../src/cli-runtime-batch-input.ts";
import { runtimeBatchSpawnAction } from "../src/cli-runtime-batch.ts";
import { firstCliCommand, firstCliCommandIndex, parseThinCommand } from "../src/cli/thin-command.ts";

test("lifecycle CLI maps explicit selectors and accepts every derivable execution or Review selector", () => {
  const submit = parseThinCommand(["task", "submit", "task-1", "--execution-id", "execution-1"]),
    declare = parseThinCommand([
      "task",
      "declare-executor",
      "task-1",
      "--execution-id",
      "execution-1",
      "--agent",
      "runtime-session:runtime-1",
      "--reason",
      "Recover omitted executor attribution",
    ]),
    review = parseThinCommand([
      "task",
      "review-execution",
      "task-1",
      "--execution-id",
      "execution-1",
      "--review-id",
      "review-1",
      "--from-file",
      "review.json",
    ]),
    consent = parseThinCommand([
      "task",
      "review-consent",
      "task-1",
      "--execution-id",
      "execution-1",
      "--review-id",
      "review-1",
    ]),
    reconcile = parseThinCommand(["task", "code-doc", "reconcile", "task-1", "--path", "README.md"]),
    complete = parseThinCommand([
      "task",
      "complete",
      "task-1",
      "--execution-id",
      "execution-1",
      "--fact-holds",
      "F-ABCDEFGH:The upstream observation remains true after this task.",
    ]);
  for (const parsed of [submit, declare, review, consent, reconcile, complete])
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (submit.ok)
    assert.deepEqual(submit.command.action, {
      kind: "task-submit",
      verb: "submit",
      commandType: "SubmitExecution",
      taskId: "task-1",
      executionId: "execution-1",
    });
  if (declare.ok)
    assert.deepEqual(declare.command.action, {
      kind: "task-declare-executor",
      taskId: "task-1",
      executionId: "execution-1",
      agent: "runtime-session:runtime-1",
      reason: "Recover omitted executor attribution",
    });
  if (review.ok)
    assert.deepEqual(review.command.action, {
      kind: "task-review-execution",
      taskId: "task-1",
      executionId: "execution-1",
      reviewId: "review-1",
      commandType: "RecordReview",
      fromFile: "review.json",
    });
  if (consent.ok)
    assert.deepEqual(consent.command.action, {
      kind: "task-review-consent",
      taskId: "task-1",
      executionId: "execution-1",
      reviewId: "review-1",
      commandType: "RecordReviewConsent",
    });
  const derivedConsent = parseThinCommand([
    "task",
    "review-consent",
    "task-1",
    "--execution-id",
    "execution-1",
    "--review-id",
    "review-1",
  ]);
  assert.equal(derivedConsent.ok, true, JSON.stringify(derivedConsent));
  if (derivedConsent.ok)
    assert.deepEqual(derivedConsent.command.action, {
      kind: "task-review-consent",
      taskId: "task-1",
      executionId: "execution-1",
      reviewId: "review-1",
      commandType: "RecordReviewConsent",
    });
  if (reconcile.ok)
    assert.deepEqual(reconcile.command.action, {
      kind: "task-code-doc-reconcile",
      taskId: "task-1",
      paths: ["README.md"],
    });
  if (complete.ok)
    assert.deepEqual(complete.command.action, {
      kind: "task-complete",
      verb: "complete",
      commandType: "CompleteTask",
      taskId: "task-1",
      executionId: "execution-1",
      factHolds: [
        {
          factRef: "fact/F-ABCDEFGH",
          rationale: "The upstream observation remains true after this task.",
        },
      ],
    });
  const derivedDeclare = parseThinCommand([
      "task",
      "declare-executor",
      "task-1",
      "--reason",
      "Recover omitted executor attribution",
    ]),
    derivedSubmit = parseThinCommand(["task", "submit", "task-1"]),
    derivedReview = parseThinCommand([
      "task",
      "review-execution",
      "task-1",
      "--review-id",
      "review-1",
      "--from-file",
      "review.json",
    ]),
    inlineReview = parseThinCommand([
      "task",
      "review-execution",
      "task-1",
      "--review-id",
      "review-2",
      "--json-input",
      '{"verdict":"approved","reason":"ok","evidenceChecked":[]}',
    ]),
    derivedPairConsent = parseThinCommand(["task", "review-consent", "task-1"]),
    derivedComplete = parseThinCommand(["task", "complete", "task-1"]);
  for (const parsed of [
    derivedDeclare,
    derivedSubmit,
    derivedReview,
    inlineReview,
    derivedPairConsent,
    derivedComplete,
  ])
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (derivedDeclare.ok)
    assert.deepEqual(derivedDeclare.command.action, {
      kind: "task-declare-executor",
      taskId: "task-1",
      reason: "Recover omitted executor attribution",
    });
  if (derivedSubmit.ok)
    assert.deepEqual(derivedSubmit.command.action, {
      kind: "task-submit",
      verb: "submit",
      commandType: "SubmitExecution",
      taskId: "task-1",
    });
  if (derivedReview.ok)
    assert.deepEqual(derivedReview.command.action, {
      kind: "task-review-execution",
      taskId: "task-1",
      reviewId: "review-1",
      commandType: "RecordReview",
      fromFile: "review.json",
    });
  if (inlineReview.ok)
    assert.deepEqual(inlineReview.command.action, {
      kind: "task-review-execution",
      taskId: "task-1",
      reviewId: "review-2",
      commandType: "RecordReview",
      jsonInput: '{"verdict":"approved","reason":"ok","evidenceChecked":[]}',
    });
  if (derivedPairConsent.ok)
    assert.deepEqual(derivedPairConsent.command.action, {
      kind: "task-review-consent",
      taskId: "task-1",
      commandType: "RecordReviewConsent",
    });
  if (derivedComplete.ok)
    assert.deepEqual(derivedComplete.command.action, {
      kind: "task-complete",
      verb: "complete",
      commandType: "CompleteTask",
      taskId: "task-1",
    });
  assert.equal(parseThinCommand(["task", "submit", "task-1", "--execution-id", "execution-1"]).ok, true);
  assert.equal(parseThinCommand(["task", "review-consent", "task-1", "--json-input", "{}"]).ok, false);
  assert.equal(parseThinCommand(["task", "declare-executor", "task-1", "--execution-id", "execution-1"]).ok, false);
  assert.equal(
    parseThinCommand(["task", "review-execution", "task-1", "--execution-id", "execution-1", "--review-id", "review-1"])
      .ok,
    false,
  );
  assert.equal(
    parseThinCommand(["task", "review-consent", "task-1", "--execution-id", "execution-1", "--review-id", "review-1"])
      .ok,
    true,
  );
  assert.equal(
    parseThinCommand([
      "task",
      "code-doc",
      "reconcile",
      "task-1",
      "--execution-id",
      "execution-1",
      "--commit-sha",
      "short",
      "--iteration",
      "2",
      "--path",
      "a.ts",
    ]).ok,
    false,
  );
  assert.equal(parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--ci"]).ok, false);
  assert.equal(parseThinCommand(["task", "complete", "task-1", "--path", "README.md"]).ok, false);
  assert.equal(
    parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--commit-sha", "a".repeat(40)])
      .ok,
    false,
  );
});

test("task settle parses to the closed orchestration action", () => {
  const settle = parseThinCommand(["task", "settle", "task-1"]);
  assert.equal(settle.ok, true, JSON.stringify(settle));
  if (settle.ok) assert.deepEqual(settle.command.action, { kind: "task-settle", taskId: "task-1" });
  const flagged = parseThinCommand(["task", "settle", "task-1", "--execution-id", "execution-1"]);
  assert.equal(flagged.ok, true, JSON.stringify(flagged));
  if (flagged.ok)
    assert.deepEqual(flagged.command.action, {
      kind: "task-settle",
      taskId: "task-1",
      executionId: "execution-1",
    });
  assert.equal(parseThinCommand(["task", "settle"]).ok, false);
  assert.equal(parseThinCommand(["task", "settle", "task-1", "--amend"]).ok, false);
  assert.equal(parseThinCommand(["task", "settle", "task-1", "--from-file", "x.json"]).ok, false);
});

test("consent accepts only server-derived Review inputs", () => {
  const complete = parseThinCommand(["task", "complete", "task-1", "--consent"]);
  assert.equal(complete.ok, true, JSON.stringify(complete));
  if (complete.ok) assert.equal(complete.command.action.consent, true);
  for (const flag of ["--consent-id", "--from-file", "--json-input"])
    assert.equal(parseThinCommand(["task", "review-consent", "task-1", flag, "obsolete"]).ok, false, flag);
});

test("progress append preserves ordered duplicate evidence in its closed daemon action", () => {
  const parsed = parseThinCommand([
    "task",
    "progress",
    "append",
    "task-1",
    "--text",
    "Exact progress",
    "--evidence",
    "test:reports/result.txt:same",
    "--evidence",
    "test:reports/result.txt:same",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "task-progress-append",
      taskId: "task-1",
      text: "Exact progress",
      evidence: [
        { type: "test", path: "reports/result.txt", summary: "same" },
        { type: "test", path: "reports/result.txt", summary: "same" },
      ],
    });
  const invalidEvidence = parseThinCommand([
    "task",
    "progress",
    "append",
    "task-1",
    "--text",
    "x",
    "--evidence",
    "bad",
  ]);
  assert.equal(invalidEvidence.ok, false);
  if (!invalidEvidence.ok)
    assert.equal(invalidEvidence.nextAction, 'Use --evidence with format <type>:<path>:<summary>. Received "bad".');
  const oldNote = parseThinCommand(["task", "progress", "append", "task-1", "--note=legacy"]),
    oldEvidence = parseThinCommand([
      "task",
      "progress",
      "append",
      "task-1",
      "--text",
      "x",
      "--evidence-source",
      "legacy",
    ]);
  for (const [result, hint] of [
    [oldNote, "--note was removed. Use --text <progress-text>."],
    [oldEvidence, "--evidence-source was removed. Use --evidence <type>:<path>:<summary>."],
  ] as const) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unknown_field");
      assert.equal(result.nextAction, hint);
    }
  }
  assert.equal(parseThinCommand(["task", "progress", "append", "task-1"]).ok, false);
  const ownerBackfill = parseThinCommand([
    "task",
    "progress",
    "append",
    "task-1",
    "--text",
    "Post-release note",
    "--as-owner",
  ]);
  assert.equal(ownerBackfill.ok, true, JSON.stringify(ownerBackfill));
  if (ownerBackfill.ok) assert.equal(ownerBackfill.command.action.asOwner, true);
});

test("task submit uses closeout and rejects packet inputs while code-doc rejects retired witness flags", () => {
  assert.equal(parseThinCommand(["task", "submit", "task-1"]).ok, true);
  for (const args of [
    ["--from-file", "submission.json"],
    ["--json-input", "{}"],
  ])
    assert.equal(parseThinCommand(["task", "submit", "task-1", ...args]).ok, false);
  const obsolete = parseThinCommand([
    "task",
    "code-doc",
    "reconcile",
    "task-1",
    "--path",
    "README.md",
    "--execution-id",
    "execution-1",
  ]);
  assert.equal(obsolete.ok, false);
  if (!obsolete.ok)
    assert.match(obsolete.nextAction, /submitted execution supplies execution id, commit, and iteration/u);
});
test("task show accepts the id positionally or as --id and reports flag misuse as unknown_field", () => {
  const positional = parseThinCommand(["task", "show", "task-1"]),
    flagged = parseThinCommand(["task", "show", "--id", "task-1"]);
  assert.equal(positional.ok, true);
  assert.equal(flagged.ok, true, JSON.stringify(flagged));
  if (positional.ok && flagged.ok) {
    assert.deepEqual(positional.command.action, { kind: "task-show", verb: "show", taskId: "task-1" });
    assert.deepEqual(flagged.command.action, positional.command.action);
  }
  const both = parseThinCommand(["task", "show", "task-1", "--id", "task-1"]);
  assert.equal(both.ok, false);
  if (!both.ok) assert.equal(both.code, "duplicate_field");
  const missing = parseThinCommand(["task", "show"]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "missing_field");
  const misused = parseThinCommand(["task", "show", "--id", "task-1", "--bogus", "x"]);
  assert.equal(misused.ok, false);
  if (!misused.ok) {
    assert.equal(misused.code, "unknown_field");
    assert.match(misused.nextAction, /ha task show --help/u);
  }
});

test("artifact add emits only a source-to-destination descriptor", () => {
  const parsed = parseThinCommand([
    "task",
    "artifact",
    "add",
    "task-1",
    "--source",
    "tmp/result.md",
    "--destination",
    "reports/result.md",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "task-artifact-add",
      taskId: "task-1",
      source: "tmp/result.md",
      destination: "reports/result.md",
    });
});

test("code-doc repoint derives the commit and rejects the retired caller cut", () => {
  const parsed = parseThinCommand([
    "task",
    "code-doc",
    "repoint",
    "task-1",
    "--record",
    "code-doc-old",
    "--path",
    "README.md",
    "--reason",
    "Correct archive root",
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "task-code-doc-repoint",
      taskId: "task-1",
      record: "code-doc-old",
      paths: ["README.md"],
      reason: "Correct archive root",
    });
  for (const argv of [
    ["task", "code-doc", "repoint", "task-1", "--reason", "why"],
    ["task", "code-doc", "repoint", "task-1", "--record", "code-doc-old"],
  ])
    assert.equal(parseThinCommand(argv).ok, false, JSON.stringify(argv));
  for (const retired of ["--commit-sha", `--commit-sha=${"b".repeat(40)}`]) {
    const obsolete = parseThinCommand([
      "task",
      "code-doc",
      "repoint",
      "task-1",
      "--record",
      "code-doc-old",
      retired,
      ...(retired.includes("=") ? [] : ["b".repeat(40)]),
      "--reason",
      "why",
    ]);
    assert.equal(obsolete.ok, false);
    if (!obsolete.ok)
      assert.equal(
        obsolete.nextAction,
        "Run ha task code-doc repoint task-1 without --commit-sha; " +
          "the submitted execution supplies the witness cut. See ha task code-doc repoint --help.",
      );
  }
});

// A route decided by scanning the whole argv lets a flag *value* spelling a command name hijack it.
// `daemon` and `gui` are both registered modules in this repository, so `--module daemon` is an
// ordinary invocation that was impossible to express: it reached daemon control and died there.
test("the command token is a position, not an argv membership test", () => {
  for (const [argv, expected] of [
    [["task", "create", "--title", "T", "--module", "daemon"], "task"],
    [["task", "create", "--title", "T", "--module", "gui"], "task"],
    [["task", "list", "--search", "daemon"], "task"],
    [["daemon", "status"], "daemon"],
    [["gui"], "gui"],
    [["--json", "daemon", "status"], "daemon"],
    [["--root", "/tmp/x", "daemon", "status"], "daemon"],
    // A global whose value spells a command must not be mistaken for the command itself.
    [["--repo", "daemon", "task", "list"], "task"],
    [["--json"], undefined],
  ] as const)
    assert.equal(firstCliCommand(argv as readonly string[]), expected, JSON.stringify(argv));
  assert.equal(firstCliCommandIndex(["--repo", "daemon", "task", "list"]), 2);
  assert.equal(firstCliCommandIndex(["--json"]), -1);
});

test("a flag value that spells a command still parses as its real command", () => {
  for (const value of ["daemon", "gui"]) {
    const parsed = parseThinCommand(["task", "create", "--title", "Wave", "--module", value]);
    assert.equal(parsed.ok, true, `--module ${value}`);
    if (parsed.ok) assert.equal(parsed.command.action.kind, "task-create");
  }
});

test("thin parser converts the sole preset script target into closed typed start params", () => {
  const parsed = parseThinCommand([
    "script",
    "run",
    "preset:user-canary/check",
    "--idempotency-key",
    "once",
    "--task",
    "task-1",
    "--inputs",
    '{"title":"Canary"}',
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command, {
      rootDir: parsed.command.rootDir,
      json: false,
      method: "repo.preset.run.start",
      action: {
        kind: "preset-run-start",
        presetId: "user-canary",
        entrypoint: "check",
        idempotencyKey: "once",
        taskId: "task-1",
        inputs: { title: "Canary" },
      },
    });
  assert.equal(parseThinCommand(["script", "run", "user-canary/check", "--idempotency-key", "once"]).ok, false);
  assert.equal(
    parseThinCommand(["script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--task-id", "task-1"])
      .ok,
    false,
  );
  assert.equal(
    parseThinCommand(["script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--inputs", "not-json"])
      .ok,
    false,
  );
});

test("init leaves identity defaults for daemon bootstrap and preserves explicit overrides", () => {
  const parsed = parseThinCommand(["init"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "repo-bootstrap" });
  const overrides = parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]);
  assert.equal(overrides.ok, true);
  if (overrides.ok)
    assert.deepEqual(overrides.command.action, {
      kind: "repo-bootstrap",
      repoId: "alpha",
      personId: "owner",
      displayName: "Owner",
    });
});

test("thin doc commands derive descriptor-only actions from the protocol directory", () => {
  const status = parseThinCommand(["doc", "status"]),
    selectedStatus = parseThinCommand(["doc", "status", "--path", "context/a.md", "--path", "context/b.md"]),
    dryRun = parseThinCommand(["doc", "sync", "--dry-run", "--path", "context/a.md", "--path", "context/b.md"]),
    materialize = parseThinCommand(["doc", "materialize"]),
    selectedMaterialize = parseThinCommand(["doc", "materialize", "--path", "context/a.md"]),
    allMaterialize = parseThinCommand(["doc", "materialize", "--all"]),
    show = parseThinCommand(["doc", "show", "--path", "tasks/task-1/INDEX.md"]),
    retire = parseThinCommand(["doc", "retire", "--path", "context/old.md", "--reason", "superseded scratch"]),
    submit = parseThinCommand(["doc", "sync", "--submit", "--path", "context/a.md", "--path", "context/b.md"]),
    allSubmit = parseThinCommand(["doc", "sync", "--submit", "--all"]),
    taskSubmit = parseThinCommand(["doc", "sync", "--submit", "--task", "task-1"]);
  assert.equal(status.ok, true);
  assert.equal(selectedStatus.ok, true);
  assert.equal(dryRun.ok, true);
  assert.equal(materialize.ok, true);
  assert.equal(selectedMaterialize.ok, true);
  assert.equal(allMaterialize.ok, true);
  assert.equal(show.ok, true);
  assert.equal(retire.ok, true);
  assert.equal(submit.ok, true);
  assert.equal(allSubmit.ok, true);
  assert.equal(taskSubmit.ok, true);
  if (status.ok) assert.deepEqual(status.command.action, { kind: "doc-status", paths: [] });
  if (selectedStatus.ok)
    assert.deepEqual(selectedStatus.command.action, {
      kind: "doc-status",
      paths: ["context/a.md", "context/b.md"],
    });
  if (dryRun.ok)
    assert.deepEqual(dryRun.command.action, {
      kind: "doc-dry-run",
      paths: ["context/a.md", "context/b.md"],
    });
  if (materialize.ok) assert.deepEqual(materialize.command.action, { kind: "doc-materialize", paths: [] });
  if (selectedMaterialize.ok)
    assert.deepEqual(selectedMaterialize.command.action, {
      kind: "doc-materialize",
      paths: ["context/a.md"],
    });
  if (allMaterialize.ok)
    assert.deepEqual(allMaterialize.command.action, {
      kind: "doc-materialize",
      paths: [],
      all: true,
    });
  if (show.ok)
    assert.deepEqual(show.command.action, {
      kind: "doc-show",
      path: "tasks/task-1/INDEX.md",
    });
  const rawShow = parseThinCommand(["doc", "show", "--path", "tasks/task-1/INDEX.md", "--raw"]);
  assert.equal(rawShow.ok, true);
  if (rawShow.ok)
    assert.deepEqual(rawShow.command.action, {
      kind: "doc-show",
      path: "tasks/task-1/INDEX.md",
      raw: true,
    });
  if (retire.ok)
    assert.deepEqual(retire.command.action, {
      kind: "doc-retire",
      path: "context/old.md",
      reason: "superseded scratch",
    });
  if (submit.ok) {
    assert.deepEqual(submit.command.action, {
      kind: "doc-submit",
      paths: ["context/a.md", "context/b.md"],
    });
    assert.deepEqual(Object.keys(submit.command.action).sort(), ["kind", "paths"]);
  }
  if (allSubmit.ok)
    assert.deepEqual(allSubmit.command.action, {
      kind: "doc-submit",
      paths: [],
      all: true,
    });
  if (taskSubmit.ok)
    assert.deepEqual(taskSubmit.command.action, {
      kind: "doc-submit",
      taskId: "task-1",
    });
  assert.equal(
    parseThinCommand(["doc", "sync", "--submit", "--task", "task-1", "--path", "tasks/task-1/task_plan.md"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["doc", "sync", "--submit", "--all", "--path", "context/a.md"]).ok, false);
  assert.equal(parseThinCommand(["doc", "sync", "--submit", "--all", "--task", "task-1"]).ok, false);
  assert.equal(parseThinCommand(["doc", "materialize", "--all", "--path", "context/a.md"]).ok, false);
  assert.equal(parseThinCommand(["doc", "sync", "--submit", "--execution-id", "exec-1"]).ok, false);
  assert.equal(parseThinCommand(["doc", "show", "--path", "INDEX.md", "--body", "inline"]).ok, false);
  assert.equal(parseThinCommand(["doc", "retire", "--path", "context/old.md"]).ok, false);
});

test("doc CLI and GUI delivery surfaces do not import store, Git, or semantic compiler code", () => {
  const sources = [
    "../src/cli/thin-command.ts",
    "../../gui/src/api/api-contract-registry.ts",
    "../../gui/src/api/service-bridge.ts",
    "../../gui/src/main/local-composition-root.ts",
  ];
  for (const source of sources)
    assert.doesNotMatch(
      readFileSync(new URL(source, import.meta.url), "utf8"),
      /kernel\/src\/(?:store|domain)|local-version-control|simple-git|semantic-compiler|node:(?:child_process|fs)/u,
      source,
    );
});

test("thin parser exposes daemon-backed workspace bootstrap", () => {
  const parsed = parseThinCommand([
    "init",
    "--repo-id",
    "alpha",
    "--person-id",
    "owner",
    "--display-name",
    "Owner",
    "--name",
    "Alpha Project",
    "--add-npm-scripts",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "repo-bootstrap",
      repoId: "alpha",
      personId: "owner",
      displayName: "Owner",
      name: "Alpha Project",
      addNpmScripts: true,
    });
  const configureOnly = parseThinCommand([
    "init",
    "--repo-id",
    "alpha",
    "--person-id",
    "owner",
    "--display-name",
    "Owner",
    "--configure-only",
  ]);
  assert.equal(configureOnly.ok, true);
  if (configureOnly.ok)
    assert.deepEqual(configureOnly.command.action, {
      kind: "repo-bootstrap",
      repoId: "alpha",
      personId: "owner",
      displayName: "Owner",
      configureOnly: true,
    });
});

test("runtime work commands parse into closed daemon facade actions", () => {
  const run = parseThinCommand([
      "agent",
      "run",
      "fable",
      "--instance",
      "worker",
      "--prompt",
      "Inspect",
      "--cwd",
      "packages/cli",
      "--task",
      "task-1",
      "--no-stream",
    ]),
    taskOnly = parseThinCommand(["agent", "run", "terra", "--task", "task-1", "--cwd", "."]),
    modeled = parseThinCommand(["agent", "run", "terra", "--task", "task-1", "--model", "gpt-5.6-sol"]),
    reviewer = parseThinCommand(["runtime", "run", "worker", "--task", "task-1", "--role", "reviewer"]),
    file = parseThinCommand(["runtime", "run", "worker", "--prompt-file", "prompt.txt"]),
    mission = parseThinCommand(["agent", "run", "terra", "--task", "task-1", "--mission", "api-review"]),
    missionJson = parseThinCommand(["agent", "run", "terra", "--task", "task-1", "--mission", "api-review", "--json"]),
    batch = parseThinCommand(["runtime", "batch", "dispatches.json"]),
    detached = parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--prompt",
      "Inspect",
      "--detach",
      "--on-exit",
      "./notify.sh",
    ]),
    resumed = parseThinCommand([
      "runtime",
      "run",
      "--resume-dispatch",
      "dispatch_0123456789abcdef01234567",
      "--prompt",
      "Continue",
    ]),
    dispatches = parseThinCommand(["task", "dispatches", "task-1"]),
    list = parseThinCommand(["runtime", "status", "--task", "task-1"]),
    show = parseThinCommand(["runtime", "status", "runtime-1"]),
    wait = parseThinCommand(["runtime", "status", "runtime-1", "--wait", "--no-stream"]),
    cancel = parseThinCommand(["runtime", "cancel", "runtime-1"]);
  for (const parsed of [
    run,
    taskOnly,
    modeled,
    mission,
    missionJson,
    batch,
    detached,
    resumed,
    dispatches,
    list,
    show,
    wait,
    cancel,
  ])
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(file.ok, false);
  if (run.ok)
    assert.deepEqual(run.command.action, {
      kind: "runtime-run",
      runtimeInstanceId: "worker",
      agentId: "fable",
      prompt: "Inspect",
      cwd: { scope: "repo-relative", path: "packages/cli" },
      taskId: "task-1",
      noStream: true,
    });
  if (taskOnly.ok)
    assert.deepEqual(taskOnly.command.action, {
      kind: "runtime-run",
      agentId: "terra",
      cwd: { scope: "repo-root" },
      taskId: "task-1",
      detach: true,
    });
  // agent run --model overrides the Agent-declared model for this one dispatch; the spawn payload
  // field is the same `model` the instance filter and runtime run already consume.
  if (modeled.ok)
    assert.deepEqual(modeled.command.action, {
      kind: "runtime-run",
      agentId: "terra",
      model: "gpt-5.6-sol",
      cwd: { scope: "repo-root" },
      taskId: "task-1",
      detach: true,
    });
  assert.equal(reviewer.ok, false);
  const reviewDispatch = parseThinCommand([
      "task",
      "dispatch-review",
      "task-1",
      "--task",
      "task-2",
      "--agent",
      "closeout-reviewer",
      "--model",
      "review-model",
    ]),
    reviewDispatchOne = parseThinCommand(["task", "dispatch-review", "task-1", "--execution-id", "exec-1"]);
  if (reviewDispatch.ok)
    assert.deepEqual(reviewDispatch.command.action, {
      kind: "task-dispatch-review",
      taskIds: ["task-1", "task-2"],
      agentId: "closeout-reviewer",
      model: "review-model",
    });
  if (reviewDispatchOne.ok)
    assert.deepEqual(reviewDispatchOne.command.action, {
      kind: "task-dispatch-review",
      taskIds: ["task-1"],
      executionId: "exec-1",
    });
  if (mission.ok)
    assert.deepEqual(mission.command.action, {
      kind: "runtime-run",
      agentId: "terra",
      missionName: "api-review",
      cwd: { scope: "repo-root" },
      taskId: "task-1",
      detach: true,
    });
  if (mission.ok && missionJson.ok) {
    assert.equal(missionJson.command.json, true);
    assert.deepEqual(missionJson.command.action, mission.command.action);
  }
  if (batch.ok)
    assert.deepEqual(batch.command.action, {
      kind: "runtime-batch",
      batchFile: "dispatches.json",
    });
  if (detached.ok)
    assert.deepEqual(detached.command.action, {
      kind: "runtime-run",
      runtimeInstanceId: "worker",
      prompt: "Inspect",
      cwd: { scope: "repo-root" },
      taskId: null,
      detach: true,
      onExitCommand: "./notify.sh",
    });
  if (resumed.ok)
    assert.deepEqual(resumed.command.action, {
      kind: "runtime-run",
      dispatchId: "dispatch_0123456789abcdef01234567",
      prompt: "Continue",
    });
  if (dispatches.ok)
    assert.deepEqual(
      { method: dispatches.command.method, action: dispatches.command.action },
      {
        method: "repo.task.dispatches",
        action: { kind: "task-dispatches", taskId: "task-1" },
      },
    );
  if (list.ok)
    assert.deepEqual(
      { method: list.command.method, action: list.command.action },
      {
        method: "repo.agentRuntime.overview",
        action: { kind: "runtime-status", taskId: "task-1" },
      },
    );
  if (show.ok)
    assert.deepEqual(
      { method: show.command.method, action: show.command.action },
      {
        method: "repo.agentRuntime.sessions.read",
        action: { kind: "runtime-status", runtimeSessionId: "runtime-1" },
      },
    );
  if (wait.ok)
    assert.deepEqual(wait.command.action, {
      kind: "runtime-status",
      runtimeSessionId: "runtime-1",
      wait: true,
      noStream: true,
    });
  if (cancel.ok)
    assert.deepEqual(cancel.command.action, {
      kind: "runtime-cancel",
      runtimeSessionId: "runtime-1",
    });
  assert.equal(parseThinCommand(["runtime", "run", "worker"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "batch"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "batch", "dispatches.json", "--detach"]).ok, false);
  assert.deepEqual(parseThinCommand(["runtime", "run", "worker", "--prompt", "Inspect", "--on-exit", "./notify.sh"]), {
    ok: false,
    code: "invalid_field",
    nextAction: "--on-exit requires --detach.",
    json: false,
  });
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "run",
      "--resume-dispatch",
      "dispatch_0123456789abcdef01234567",
      "--prompt",
      "Continue",
      "--on-exit",
      "./notify.sh",
    ]),
    {
      ok: false,
      code: "invalid_field",
      nextAction: "--on-exit requires --detach.",
      json: false,
    },
  );
  assert.equal(
    parseThinCommand(["runtime", "run", "worker", "--squad", "runtime-squad", "--prompt", "Inspect"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["runtime", "run", "worker", "--prompt", "one", "--prompt-file", "two"]).ok, false);
  assert.equal(
    parseThinCommand(["runtime", "run", "worker", "--task", "task-1", "--prompt", "one", "--prompt-file", "two"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["runtime", "run", "worker", "--to", "terra", "--prompt", "Inspect"]).ok, false);
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "run",
      "worker",
      "--task",
      "task-1",
      "--mission",
      "api-review",
      "--prompt",
      "Inspect",
    ]),
    {
      ok: false,
      code: "invalid_field",
      nextAction: "--prompt is mutually exclusive with --mission.",
      json: false,
    },
  );
  assert.deepEqual(parseThinCommand(["runtime", "run", "worker", "--mission", "api-review"]), {
    ok: false,
    code: "invalid_field",
    nextAction: "--mission requires --task.",
    json: false,
  });
  assert.equal(parseThinCommand(["runtime", "status", "runtime-1", "--task", "task-1"]).ok, false);
  const taskWait = parseThinCommand(["runtime", "status", "--task", "task-1", "--wait", "--no-stream"]);
  assert.equal(taskWait.ok, true);
  if (taskWait.ok)
    assert.deepEqual(taskWait.command.action, {
      kind: "runtime-status",
      taskId: "task-1",
      wait: true,
      noStream: true,
    });
  assert.deepEqual(parseThinCommand(["runtime", "status", "--wait"]), {
    ok: false,
    code: "invalid_field",
    nextAction: "Use --wait with a runtime session id or --task <task-id>.",
    json: false,
  });
  const noStream = parseThinCommand(["runtime", "status", "runtime-1", "--no-stream"]);
  assert.equal(noStream.ok, true, JSON.stringify(noStream));
  if (noStream.ok)
    assert.deepEqual(noStream.command.action, {
      kind: "runtime-status",
      runtimeSessionId: "runtime-1",
      noStream: true,
    });
  const taskNoStream = parseThinCommand(["runtime", "status", "--task", "task-1", "--no-stream"]);
  assert.equal(taskNoStream.ok, true, JSON.stringify(taskNoStream));
  if (taskNoStream.ok)
    assert.deepEqual(taskNoStream.command.action, {
      kind: "runtime-status",
      taskId: "task-1",
      noStream: true,
    });
  assert.equal(parseThinCommand(["runtime", "wait", "runtime-1"]).ok, false);
});

test("runtime batch uses the same prompt, mission, and task input union as runtime run", () => {
  assert.deepEqual(parseRuntimeBatchEntry({ instance: "worker", task: "task-1" }, 0), {
    instance: "worker",
    task: "task-1",
  });
  assert.deepEqual(parseRuntimeBatchEntry({ instance: "worker", task: "task-1", mission: "api-review" }, 0), {
    instance: "worker",
    mission: "api-review",
    task: "task-1",
  });
  const fast = parseRuntimeBatchEntry({ instance: "codex-fast", prompt: "inspect", fast: true }, 0);
  assert.equal(fast.fast, true);
  assert.equal(runtimeBatchSpawnAction(fast).fast, true);
  assert.throws(
    () => parseRuntimeBatchEntry({ instance: "worker", prompt: "inspect", fast: "yes" }, 0),
    /field fast must be a boolean/u,
  );
  assert.throws(
    () => parseRuntimeBatchEntry({ instance: "worker", prompt: "one", mission: "two", task: "task-1" }, 0),
    /cannot combine prompt and mission/u,
  );
  assert.throws(() => parseRuntimeBatchEntry({ instance: "worker" }, 0), /requires prompt, mission, or task/u);
});

test("thin parser rejects retired caller-supplied gate receipts", () => {
  const parsed = parseThinCommand([
    "task",
    "complete",
    "task-1",
    "--execution-id",
    "exec-1",
    "--gate-receipt",
    "missing-separator",
  ]);
  assert.deepEqual(parsed, {
    ok: false,
    code: "unknown_field",
    nextAction: "Unknown option --gate-receipt. Run ha task complete --help.",
    json: false,
  });
});

test("task create rejects the retired legacy flag and still accepts a title", () => {
  assert.equal(parseThinCommand(["task", "create", "--from-legacy", "legacy-1"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "New task", "--from-legacy", "legacy-1"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "New task"]).ok, true);
});
