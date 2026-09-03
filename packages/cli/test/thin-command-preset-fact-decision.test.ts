// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { materializePacketStdin } from "../src/index.ts";

test("thin parser derives builtin vertical, template, and script discovery actions", () => {
  const vertical = parseThinCommand(["vertical", "validate", "--source", "software/coding"]),
    templates = parseThinCommand(["template", "list"]),
    render = parseThinCommand(["template", "render", "template://repository/adr-template@1", "--locale", "zh-CN"]),
    scripts = parseThinCommand(["script", "list"]),
    inspect = parseThinCommand(["script", "inspect", "vertical:software-coding:repository-audit"]);
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
      scriptId: "vertical:software-coding:repository-audit",
    });
  const run = parseThinCommand([
    "script",
    "run",
    "vertical:software-coding:repository-audit",
    "--task",
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
        scriptId: "vertical:software-coding:repository-audit",
        taskId: "task-1",
        inputs: { locale: "en-US" },
        dryRun: true,
      },
    });
  assert.equal(parseThinCommand(["script", "run", "user-canary/check"]).ok, false);
  assert.equal(
    parseThinCommand(["script", "run", "vertical:software-coding:repository-audit", "--task-id", "task-1"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["preset", "run", "standard-task"]).ok, false);
  assert.equal(parseThinCommand(["preset", "action", "standard-task"]).ok, false);
});

test("Relation commands replace hosted Task and Decision relation ingress", () => {
  const relate = parseThinCommand([
      "relation",
      "relate",
      "--source-ref",
      "task/task-a",
      "--target-ref",
      "task/task-b",
      "--type",
      "depends-on",
      "--rationale",
      "A waits for B.",
      "--expected-version",
      "0",
    ]),
    unrelate = parseThinCommand([
      "relation",
      "unrelate",
      "rel_0123456789abcdef",
      "--reason",
      "No longer required.",
      "--expected-version",
      "17",
    ]),
    reconfirm = parseThinCommand([
      "relation",
      "reconfirm",
      "rel_0123456789abcdef",
      "--expected-version",
      "18",
      "--rationale",
      "Reviewed the new target version.",
    ]),
    suspect = parseThinCommand(["relation", "list", "--freshness", "suspect"]);
  assert.equal(relate.ok, true);
  assert.equal(unrelate.ok, true);
  assert.equal(reconfirm.ok, true);
  assert.equal(suspect.ok, true);
  if (relate.ok)
    assert.deepEqual(relate.command.action, {
      kind: "relation-relate",
      sourceRef: "task/task-a",
      targetRef: "task/task-b",
      relationType: "depends-on",
      direction: "directed",
      origin: "declared",
      rationale: "A waits for B.",
      expectedVersion: 0,
    });
  if (unrelate.ok)
    assert.deepEqual(unrelate.command.action, {
      kind: "relation-unrelate",
      relationId: "rel_0123456789abcdef",
      reason: "No longer required.",
      expectedVersion: 17,
    });
  if (reconfirm.ok)
    assert.deepEqual(reconfirm.command.action, {
      kind: "relation-reconfirm",
      relationId: "rel_0123456789abcdef",
      expectedVersion: 18,
      rationale: "Reviewed the new target version.",
    });
  if (suspect.ok) assert.deepEqual(suspect.command.action, { kind: "relation-list", freshness: "suspect" });
  assert.equal(parseThinCommand(["relation", "list", "--freshness", "unknown"]).ok, false);
  assert.equal(
    parseThinCommand([
      "relation",
      "relate",
      "--source-ref",
      "task/task-a",
      "--target-ref",
      "task/task-b",
      "--type",
      "relates",
      "--strength",
      "strong",
      "--rationale",
      "Caller must not choose strength.",
      "--expected-version",
      "0",
    ]).ok,
    false,
  );
  assert.equal(parseThinCommand(["task", "relate", "task-a", "depends-on", "task-b"]).ok, false);
  assert.equal(parseThinCommand(["decision", "relate", "dec_a"]).ok, false);
});

test("Fact CLI exposes record, controlled types, search, and show while keeping local errors closed", () => {
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
    "--type",
    "architecture",
    "--memory-class",
    "semantic",
    "--memory-tag",
    "pattern",
    "--wait-projection",
    "2500",
  ]);
  const search = parseThinCommand(["fact", "search", "Observed", "--task", "task-1"]),
    facetedSearch = parseThinCommand(["fact", "search", "--type", "architecture"]),
    registration = parseThinCommand(["fact", "type", "register", "architecture", "--source", "decision/CH1"]),
    vocabulary = parseThinCommand(["fact", "type", "list"]),
    reclassification = parseThinCommand([
      "fact",
      "reclassify",
      "F-ABCDEFGH",
      "--type",
      "architecture",
      "--type",
      "bug",
      "--rationale",
      "Dual-purpose observation",
    ]),
    show = parseThinCommand(["fact", "show", "--id", "F-ABCDEFGH"]);
  assert.equal(record.ok, true);
  assert.equal(search.ok, true);
  assert.equal(facetedSearch.ok, true);
  assert.equal(show.ok, true);
  assert.equal(registration.ok, true);
  assert.equal(vocabulary.ok, true);
  assert.equal(reclassification.ok, true);
  if (record.ok)
    assert.deepEqual(record.command.action, {
      kind: "fact-record",
      taskId: "task-1",
      statement: "Observed",
      evidenceSource: "test",
      confidence: "high",
      domainTypes: ["architecture"],
      memoryClass: "semantic",
      memoryTags: ["pattern"],
      waitProjectionMs: 2500,
    });
  if (facetedSearch.ok)
    assert.deepEqual(facetedSearch.command.action, { kind: "fact-search", domainType: "architecture" });
  if (registration.ok)
    assert.deepEqual(registration.command.action, {
      kind: "fact-type-register",
      statement: "Registered Fact domain type: architecture",
      evidenceSource: "decision/CH1",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      registersDomainType: "architecture",
    });
  if (vocabulary.ok) assert.deepEqual(vocabulary.command.action, { kind: "fact-type-list" });
  if (reclassification.ok)
    assert.deepEqual(reclassification.command.action, {
      kind: "fact-reclassify",
      factId: "F-ABCDEFGH",
      domainTypes: ["architecture", "bug"],
      rationale: "Dual-purpose observation",
    });
  const migrated = parseThinCommand([
    "fact",
    "record",
    "task-2",
    "--text",
    "Observed through the migrated shape",
    "--source",
    "test:migrated",
  ]);
  assert.equal(migrated.ok, true, JSON.stringify(migrated));
  if (migrated.ok)
    assert.deepEqual(migrated.command.action, {
      kind: "fact-record",
      taskId: "task-2",
      statement: "Observed through the migrated shape",
      evidenceSource: "test:migrated",
      confidence: "medium",
      memoryClass: "episodic",
      memoryTags: [],
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
  for (const retired of ["--kind", "--summary", "--detail"]) {
    const rejected = parseThinCommand(["fact", "record", "task-1", retired, "legacy"]);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.code, "unknown_field");
      assert.equal(
        rejected.nextAction,
        `${retired} was removed. Use ha fact record <task-id> --statement <observation> --source <source>.`,
      );
    }
  }
  assert.equal(
    parseThinCommand(["fact", "record", "task-1", "--task", "task-2", "--statement", "x", "--source", "s"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["fact", "record", "--statement", "x", "--text", "y", "--source", "s"]).ok, false);
  assert.equal(
    parseThinCommand(["fact", "record", "--statement", "x", "--source", "s", "--wait-projection", "-1"]).ok,
    false,
  );
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
    }),
    propose = parseThinCommand([
      "decision",
      "propose",
      "--json-input",
      packet,
      "--body",
      "# Canonical\n\nInitial prose.\n",
    ]),
    stdin = parseThinCommand(["decision", "propose", "--json-input", "@-"]),
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
    [propose, stdin, accept, claim, fulfill, reckon, list, show].every((result) => result.ok),
    true,
  );
  if (propose.ok)
    assert.deepEqual(propose.command.action, {
      kind: "decision-propose",
      jsonInput: packet,
      body: "# Canonical\n\nInitial prose.\n",
    });
  if (stdin.ok)
    assert.deepEqual(materializePacketStdin(stdin.command, () => packet).action, {
      kind: "decision-propose",
      jsonInput: packet,
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
    candidate = parseThinCommand(["distill", "candidate", "--task", "task-1", "--input", "notes.md"]),
    entityCandidate = parseThinCommand([
      "distill",
      "candidate",
      "--task",
      "task-1",
      "--entity",
      "software/coding/architecture-decision-record@1/ADR-f425d2bc85636f41",
    ]),
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
    [validate, verifyAll, repin, active, superseded, alias, amend, candidate, entityCandidate, promote].every(
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
  const preview = parseThinCommand(["decision", "amend", "dec_1", "--title", "Preview", "--dry-run"]);
  assert.equal(preview.ok, true);
  if (preview.ok) assert.equal(preview.command.action.dryRun, true);
  if (candidate.ok)
    assert.deepEqual(candidate.command.action, {
      kind: "distill-candidate",
      taskId: "task-1",
      inputPath: "notes.md",
    });
  if (entityCandidate.ok)
    assert.deepEqual(entityCandidate.command.action, {
      kind: "distill-candidate",
      taskId: "task-1",
      entityRef: "software/coding/architecture-decision-record@1/ADR-f425d2bc85636f41",
    });
  assert.equal(
    parseThinCommand([
      "distill",
      "candidate",
      "--task",
      "task-1",
      "--input",
      "notes.md",
      "--entity",
      "software/coding/architecture-decision-record@1/ADR-f425d2bc85636f41",
    ]).ok,
    false,
  );
  assert.equal(parseThinCommand(["distill", "candidate", "--task", "task-1"]).ok, false);
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
