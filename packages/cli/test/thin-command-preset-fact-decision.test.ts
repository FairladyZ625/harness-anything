// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("thin parser derives builtin vertical, template, and script discovery actions", () => {
  const vertical = parseThinCommand(["vertical", "validate", "--source", "software/coding"]),
    templates = parseThinCommand(["template", "list"]),
    render = parseThinCommand(["template", "render", "template://repository/adr-template@1", "--locale", "zh-CN"]),
    scripts = parseThinCommand(["script", "list"]),
    inspect = parseThinCommand(["script", "inspect", "vertical:software-coding:architecture-check"]);
  assert.equal(
    [vertical, templates, render, scripts, inspect].every((result) => result.ok),
    true,
  );
  if (vertical.ok)
    assert.deepEqual(vertical.command.action, {
      kind: "vertical-validate",
      verticalSource: "software/coding",
    });
  if (templates.ok) assert.deepEqual(templates.command.action, { kind: "template-list" });
  if (render.ok)
    assert.deepEqual(render.command.action, {
      kind: "template-render",
      templateRef: "template://repository/adr-template@1",
      locale: "zh-CN",
    });
  if (scripts.ok) assert.deepEqual(scripts.command.action, { kind: "script-list" });
  if (inspect.ok)
    assert.deepEqual(inspect.command.action, {
      kind: "script-inspect",
      scriptId: "vertical:software-coding:architecture-check",
    });
  const run = parseThinCommand([
    "script",
    "run",
    "vertical:software-coding:architecture-check",
    "--task-id",
    "task-1",
    "--inputs",
    '{"locale":"en-US"}',
    "--dry-run",
  ]);
  assert.equal(run.ok, true);
  if (run.ok)
    assert.deepEqual(run.command, {
      rootDir: run.command.rootDir,
      json: false,
      method: "repo.script.run",
      action: {
        schema: "vertical-script-action/v1",
        kind: "script-run",
        scriptId: "vertical:software-coding:architecture-check",
        taskId: "task-1",
        inputs: { locale: "en-US" },
        dryRun: true,
      },
    });
  assert.equal(parseThinCommand(["script", "run", "user-canary/check"]).ok, false);
  assert.equal(parseThinCommand(["preset", "run", "standard-task"]).ok, false);
  assert.equal(parseThinCommand(["preset", "action", "standard-task"]).ok, false);
});

test("Fact CLI exposes only record/search/show and covers all five local parse errors", () => {
  const record = parseThinCommand([
    "fact",
    "record",
    "--task",
    "task-1",
    "--statement",
    "Observed",
    "--source",
    "test",
    "--confidence",
    "high",
    "--memory-class",
    "semantic",
    "--memory-tag",
    "pattern",
  ]);
  const search = parseThinCommand(["fact", "search", "Observed", "--task", "task-1"]),
    show = parseThinCommand(["fact", "show", "--id", "F-ABCDEFGH"]);
  assert.equal(record.ok, true);
  assert.equal(search.ok, true);
  assert.equal(show.ok, true);
  if (record.ok)
    assert.deepEqual(record.command.action, {
      kind: "fact-record",
      taskId: "task-1",
      statement: "Observed",
      evidenceSource: "test",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: ["pattern"],
    });
  const failures = [
    parseThinCommand(["fact", "record", "--task", "a", "--task", "b", "--statement", "x", "--source", "s"]),
    parseThinCommand(["fact", "show", "--id", "bad"]),
    parseThinCommand(["fact", "record", "--task", "a"]),
    parseThinCommand(["fact", "search", "--wat", "x"]),
    parseThinCommand(["fact", "list"]),
  ];
  assert.deepEqual(
    failures.map((result) => (result.ok ? "ok" : result.code)),
    ["duplicate_field", "invalid_field", "missing_field", "unknown_field", "unsupported_command"],
  );
  const excessiveRationale = parseThinCommand([
    "fact",
    "record",
    "--task",
    "task-1",
    "--statement",
    "Observed",
    "--source",
    "test",
    "--supersedes",
    "fact/F-ABCDEFGH",
    "--rationale",
    "x".repeat(200),
  ]);
  assert.equal(excessiveRationale.ok ? "ok" : excessiveRationale.code, "invalid_field");
});

test("Fact search CLI forwards observed-time windows and keyset pagination", () => {
  const parsed = parseThinCommand([
    "fact",
    "search",
    "observation",
    "--task",
    "task-1",
    "--observed-after",
    "2026-08-01T00:00:00.000Z",
    "--observed-before",
    "2026-08-31T00:00:00.000Z",
    "--limit",
    "25",
    "--cursor",
    "cursor-a",
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "fact-search",
      query: "observation",
      taskId: "task-1",
      observedAfter: "2026-08-01T00:00:00.000Z",
      observedBefore: "2026-08-31T00:00:00.000Z",
      limit: 25,
      cursor: "cursor-a",
    });
});

test("Decision CLI maps every canonical command and keeps the five local error codes closed", () => {
  const packet = JSON.stringify({
      title: "Canonical",
      question: "Should events own this Decision?",
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
    propose = parseThinCommand([
      "decision",
      "propose",
      "--json-input",
      packet,
      "--body",
      "# Canonical\n\nInitial prose.\n",
    ]),
    accept = parseThinCommand([
      "decision",
      "accept",
      "dec_1",
      "--rationale",
      "Independent approval",
      "--judgment-only",
      "CEO judgment without evidence",
    ]),
    claim = parseThinCommand(["decision", "claim", "add", "dec_1", "--id", "C1", "--text", "Coverage is replayable"]),
    fulfill = parseThinCommand(["decision", "claim", "fulfill", "dec_1", "--id", "C1", "--mode", "evidenced"]),
    relate = parseThinCommand([
      "decision",
      "relate",
      "dec_1",
      "--anchor",
      "C1",
      "--type",
      "evidenced-by",
      "--target",
      "fact/F-ABCDEFGH",
      "--rationale",
      "Observed",
    ]),
    retireRelation = parseThinCommand([
      "decision",
      "relation",
      "retire",
      "dec_1",
      "--relation",
      "rel_0123456789abcdef",
      "--reason",
      "Stale",
    ]),
    reckon = parseThinCommand(["decision", "reckon", "dec_1", "--task", "task-1"]),
    list = parseThinCommand([
      "decision",
      "list",
      "--search",
      "Canonical",
      "--state",
      "in_effect",
      "--legacy-id",
      "E12",
      "--legacy-range",
      "E1-E20",
      "--module",
      "kernel",
      "--product-line",
      "platform",
    ]),
    show = parseThinCommand(["decision", "show", "E12", "--include-body"]);
  assert.equal(
    [propose, accept, claim, fulfill, relate, retireRelation, reckon, list, show].every((result) => result.ok),
    true,
  );
  if (propose.ok)
    assert.deepEqual(propose.command.action, {
      kind: "decision-propose",
      jsonInput: packet,
      body: "# Canonical\n\nInitial prose.\n",
    });
  if (accept.ok)
    assert.deepEqual(accept.command.action, {
      kind: "decision-accept",
      decisionId: "dec_1",
      rationale: "Independent approval",
      judgmentOnlyRationale: "CEO judgment without evidence",
    });
  if (list.ok)
    assert.deepEqual(list.command.action, {
      kind: "decision-list",
      search: "Canonical",
      state: "in_effect",
      legacyId: "E12",
      legacyRange: { start: 1, end: 20 },
      module: "kernel",
      productLine: "platform",
    });
  if (show.ok)
    assert.deepEqual(show.command.action, {
      kind: "decision-show",
      decisionId: "E12",
      includeBody: true,
    });
  const failures = [
    parseThinCommand(["decision", "accept", "dec_1", "--rationale", "a", "--rationale", "b"]),
    parseThinCommand(["decision", "accept", "dec_1", "--rationale", "valid", "--judgment-only", "x".repeat(200)]),
    parseThinCommand(["decision", "accept"]),
    parseThinCommand(["decision", "show", "dec_1", "--body"]),
    parseThinCommand(["decision", "search"]),
  ];
  assert.deepEqual(
    failures.map((result) => (result.ok ? "ok" : result.code)),
    ["duplicate_field", "invalid_field", "missing_field", "unknown_field", "unsupported_command"],
  );
  assert.equal(
    parseThinCommand(["decision", "propose", "--from-file", "proposal.json", "--json-input", packet]).ok,
    false,
  );
  assert.equal(
    parseThinCommand(["decision", "propose", "--json-input", packet, "--body", "inline", "--body-file", "body.md"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["decision", "propose", "--title", "retired flags-only proposal"]).ok, false);
  assert.equal(
    parseThinCommand([
      "decision",
      "relate",
      "dec_1",
      "--type",
      "relates",
      "--target",
      "task/task-1",
      "--rationale",
      "Missing anchor",
    ]).ok,
    false,
  );
  assert.equal(parseThinCommand(["decision", "list", "--legacy-range", "E20-E1"]).ok, false);
});

test("Decision F06 and distill leaf commands preserve their complete structured payloads", () => {
  const validate = parseThinCommand(["decision", "validate", "dec_1"]),
    verifyAll = parseThinCommand(["decision", "verify", "--all"]),
    repin = parseThinCommand(["decision", "repin", "--all", "--migration-evidence", "task/task-1/audit-2026"]),
    active = parseThinCommand([
      "decision",
      "transition",
      "in_effect",
      "dec_1",
      "--decided-at",
      "2026-08-15T00:00:00.000Z",
      "--judgment-only",
      "Reviewed independently",
      "--fulfillment",
      "C1:delivered",
    ]),
    superseded = parseThinCommand(["decision", "transition", "superseded", "dec_1"]),
    alias = parseThinCommand(["decision", "supersede", "dec_1", "--reason", "Replaced by a newer Decision"]),
    amend = parseThinCommand([
      "decision",
      "amend",
      "dec_1",
      "--title",
      "Corrected",
      "--non-load-bearing",
      "C1",
      "--append",
      'claims:{"id":"C2","text":"Stable","loadBearing":false}',
      "--body-file",
      "body.md",
    ]),
    replace = parseThinCommand([
      "decision",
      "relation",
      "replace",
      "dec_1",
      "--relation",
      "rel_0123456789abcdef",
      "--anchor",
      "C1",
      "--type",
      "relates",
      "--target",
      "task/task-1",
      "--rationale",
      "Corrected edge",
    ]),
    candidate = parseThinCommand(["distill", "candidate", "--task", "task-1", "--input", "notes.md"]),
    promote = parseThinCommand([
      "distill",
      "promote",
      "--task",
      "task-1",
      "--candidate",
      ".harness/distill/task-1/candidate.json",
      "--claim",
      "Stable fact",
      "--id",
      "F-ABCDEFGH",
      "--memory-tag",
      "pattern",
    ]);
  assert.equal(
    [validate, verifyAll, repin, active, superseded, alias, amend, replace, candidate, promote].every(
      (result) => result.ok,
    ),
    true,
  );
  if (validate.ok)
    assert.deepEqual(validate.command.action, {
      kind: "decision-validate",
      decisionId: "dec_1",
    });
  if (verifyAll.ok)
    assert.deepEqual(verifyAll.command.action, {
      kind: "decision-validate",
      all: true,
    });
  if (repin.ok)
    assert.deepEqual(repin.command.action, {
      kind: "decision-repin",
      all: true,
      migrationEvidence: "task/task-1/audit-2026",
    });
  if (active.ok)
    assert.deepEqual(active.command.action, {
      kind: "decision-transition",
      decisionId: "dec_1",
      targetState: "in_effect",
      decidedAt: "2026-08-15T00:00:00.000Z",
      judgmentOnlyRationale: "Reviewed independently",
      standingPolicy: false,
      fulfillments: [{ claimId: "C1", mode: "delivered" }],
      dryRun: false,
    });
  if (amend.ok)
    assert.deepEqual(amend.command.action, {
      kind: "decision-amend",
      decisionId: "dec_1",
      title: "Corrected",
      standingPolicy: false,
      fulfillments: [],
      loadBearing: { claimId: "C1", value: false },
      sets: [],
      appends: ['claims:{"id":"C2","text":"Stable","loadBearing":false}'],
      bodyFile: "body.md",
      dryRun: false,
    });
  if (replace.ok)
    assert.deepEqual(replace.command.action, {
      kind: "decision-relation-replace",
      decisionId: "dec_1",
      relationId: "rel_0123456789abcdef",
      body: null,
      dryRun: false,
      anchor: "C1",
      relationType: "relates",
      target: "task/task-1",
      rationale: "Corrected edge",
    });
  const preview = parseThinCommand(["decision", "amend", "dec_1", "--title", "Preview", "--dry-run"]);
  assert.equal(preview.ok, true);
  if (preview.ok) assert.equal(preview.command.action.dryRun, true);
  if (candidate.ok)
    assert.deepEqual(candidate.command.action, {
      kind: "distill-candidate",
      taskId: "task-1",
      inputPath: "notes.md",
    });
  if (promote.ok)
    assert.deepEqual(promote.command.action, {
      kind: "distill-promote",
      taskId: "task-1",
      candidatePath: ".harness/distill/task-1/candidate.json",
      statement: "Stable fact",
      factId: "F-ABCDEFGH",
      confidence: "medium",
      memoryClass: "semantic",
      memoryTags: ["pattern"],
    });
  assert.equal(parseThinCommand(["distill", "commit"]).ok, false);
  assert.equal(parseThinCommand(["decision", "validate", "dec_1", "--all"]).ok, false);
  assert.equal(parseThinCommand(["decision", "transition", "retired", "dec_1", "--standing-policy"]).ok, false);
  assert.equal(parseThinCommand(["decision", "amend", "dec_1"]).ok, false);
});
