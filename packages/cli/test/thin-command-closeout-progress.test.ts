// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  firstCliCommand,
  firstCliCommandIndex,
  parseThinCommand,
} from "../src/cli/thin-command.ts";

test("lifecycle CLI maps explicit selectors and accepts every derivable execution or Review selector", () => {
  const submit = parseThinCommand([
      "task",
      "submit",
      "task-1",
      "--execution-id",
      "execution-1",
      "--from-file",
      "submission.json",
    ]),
    declare = parseThinCommand([
      "task",
      "declare-executor",
      "task-1",
      "--execution-id",
      "execution-1",
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
      "--consent-id",
      "consent-1",
      "--from-file",
      "consent.json",
    ]),
    reconcile = parseThinCommand([
      "task",
      "code-doc",
      "reconcile",
      "task-1",
      "--execution-id",
      "execution-1",
      "--commit-sha",
      "a".repeat(40),
      "--iteration",
      "0",
      "--path",
      "packages/kernel/src/domain/task.ts",
    ]),
    complete = parseThinCommand([
      "task",
      "complete",
      "task-1",
      "--execution-id",
      "execution-1",
      "--ci",
      "passed",
      "--path",
      "packages/kernel/src/domain/task.ts",
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
      fromFile: "submission.json",
    });
  if (declare.ok)
    assert.deepEqual(declare.command.action, {
      kind: "task-declare-executor",
      taskId: "task-1",
      executionId: "execution-1",
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
      consentId: "consent-1",
      fromFile: "consent.json",
    });
  const derivedConsent = parseThinCommand([
    "task",
    "review-consent",
    "task-1",
    "--execution-id",
    "execution-1",
    "--review-id",
    "review-1",
    "--consent-id",
    "consent-1",
  ]);
  assert.equal(derivedConsent.ok, true, JSON.stringify(derivedConsent));
  if (derivedConsent.ok)
    assert.deepEqual(derivedConsent.command.action, {
      kind: "task-review-consent",
      taskId: "task-1",
      executionId: "execution-1",
      reviewId: "review-1",
      commandType: "RecordReviewConsent",
      consentId: "consent-1",
    });
  if (reconcile.ok)
    assert.deepEqual(reconcile.command.action, {
      kind: "task-code-doc-reconcile",
      taskId: "task-1",
      executionId: "execution-1",
      commitSha: "a".repeat(40),
      iteration: 0,
      paths: ["packages/kernel/src/domain/task.ts"],
    });
  if (complete.ok)
    assert.deepEqual(complete.command.action, {
      kind: "task-complete",
      verb: "complete",
      commandType: "CompleteTask",
      taskId: "task-1",
      executionId: "execution-1",
      ci: "passed",
      paths: ["packages/kernel/src/domain/task.ts"],
    });
  const derivedDeclare = parseThinCommand([
      "task",
      "declare-executor",
      "task-1",
      "--reason",
      "Recover omitted executor attribution",
    ]),
    derivedSubmit = parseThinCommand([
      "task",
      "submit",
      "task-1",
      "--from-file",
      "submission.json",
    ]),
    derivedReview = parseThinCommand([
      "task",
      "review-execution",
      "task-1",
      "--review-id",
      "review-1",
      "--from-file",
      "review.json",
    ]),
    derivedPairConsent = parseThinCommand([
      "task",
      "review-consent",
      "task-1",
      "--consent-id",
      "consent-1",
    ]),
    derivedComplete = parseThinCommand([
      "task",
      "complete",
      "task-1",
      "--ci",
      "passed",
      "--path",
      "packages/kernel/src/domain/task.ts",
    ]);
  for (const parsed of [
    derivedDeclare,
    derivedSubmit,
    derivedReview,
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
      fromFile: "submission.json",
    });
  if (derivedReview.ok)
    assert.deepEqual(derivedReview.command.action, {
      kind: "task-review-execution",
      taskId: "task-1",
      reviewId: "review-1",
      commandType: "RecordReview",
      fromFile: "review.json",
    });
  if (derivedPairConsent.ok)
    assert.deepEqual(derivedPairConsent.command.action, {
      kind: "task-review-consent",
      taskId: "task-1",
      commandType: "RecordReviewConsent",
      consentId: "consent-1",
    });
  if (derivedComplete.ok)
    assert.deepEqual(derivedComplete.command.action, {
      kind: "task-complete",
      verb: "complete",
      commandType: "CompleteTask",
      taskId: "task-1",
      ci: "passed",
      paths: ["packages/kernel/src/domain/task.ts"],
    });
  assert.equal(
    parseThinCommand([
      "task",
      "submit",
      "task-1",
      "--execution-id",
      "execution-1",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "task",
      "declare-executor",
      "task-1",
      "--execution-id",
      "execution-1",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "task",
      "review-execution",
      "task-1",
      "--execution-id",
      "execution-1",
      "--review-id",
      "review-1",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "task",
      "review-consent",
      "task-1",
      "--execution-id",
      "execution-1",
      "--review-id",
      "review-1",
    ]).ok,
    false,
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
  assert.equal(
    parseThinCommand([
      "task",
      "complete",
      "task-1",
      "--execution-id",
      "execution-1",
      "--ci",
      "failed",
    ]).ok,
    false,
  );
  const pathOnlyComplete = parseThinCommand([
    "task",
    "complete",
    "task-1",
    "--execution-id",
    "execution-1",
    "--path",
    "packages/kernel/src/domain/task.ts",
  ]);
  assert.equal(pathOnlyComplete.ok, true);
  if (pathOnlyComplete.ok)
    assert.deepEqual(pathOnlyComplete.command.action, {
      kind: "task-complete",
      verb: "complete",
      commandType: "CompleteTask",
      taskId: "task-1",
      executionId: "execution-1",
      paths: ["packages/kernel/src/domain/task.ts"],
    });
  assert.equal(
    parseThinCommand([
      "task",
      "complete",
      "task-1",
      "--execution-id",
      "execution-1",
      "--commit-sha",
      "a".repeat(40),
    ]).ok,
    false,
  );
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
  assert.equal(
    parseThinCommand([
      "task",
      "progress",
      "append",
      "task-1",
      "--text",
      "x",
      "--evidence",
      "bad",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand(["task", "progress", "append", "task-1"]).ok,
    false,
  );
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

test("code-doc repoint requires an active record, full commit, and audit reason", () => {
  const parsed = parseThinCommand([
    "task",
    "code-doc",
    "repoint",
    "task-1",
    "--record",
    "code-doc-old",
    "--commit-sha",
    "a".repeat(40),
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
      commitSha: "a".repeat(40),
      paths: ["README.md"],
      reason: "Correct archive root",
    });
  for (const argv of [
    ["task", "code-doc", "repoint", "task-1", "--commit-sha", "a".repeat(40), "--reason", "why"],
    ["task", "code-doc", "repoint", "task-1", "--record", "code-doc-old", "--commit-sha", "abc", "--reason", "why"],
    ["task", "code-doc", "repoint", "task-1", "--record", "code-doc-old", "--commit-sha", "a".repeat(40)],
  ])
    assert.equal(parseThinCommand(argv).ok, false, JSON.stringify(argv));
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
    assert.equal(
      firstCliCommand(argv as readonly string[]),
      expected,
      JSON.stringify(argv),
    );
  assert.equal(firstCliCommandIndex(["--repo", "daemon", "task", "list"]), 2);
  assert.equal(firstCliCommandIndex(["--json"]), -1);
});

test("a flag value that spells a command still parses as its real command", () => {
  for (const value of ["daemon", "gui"]) {
    const parsed = parseThinCommand([
      "task",
      "create",
      "--title",
      "Wave",
      "--module",
      value,
    ]);
    assert.equal(parsed.ok, true, `--module ${value}`);
    if (parsed.ok) assert.equal(parsed.command.action.kind, "task-create");
  }
});
