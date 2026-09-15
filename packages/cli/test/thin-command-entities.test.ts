// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { daemonProtocolCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { packetJson } from "../../daemon/src/repo-cell-packets.ts";
import { readWorkspaceText } from "../../daemon/src/workspace-text-port.ts";
import { workspacePathFormat, workspacePathResolutionRule } from "../../preset/src/preset-command-contract.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { materializePacketStdin, rawTemplateBody } from "../src/index.ts";

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
    show = parseThinCommand(["fact", "show", "--id", "F-ABCDEFGH"]),
    showPositional = parseThinCommand(["fact", "show", "F-ABCDEFGH"]);
  assert.equal(record.ok, true);
  assert.equal(search.ok, true);
  assert.equal(facetedSearch.ok, true);
  assert.equal(show.ok, true);
  assert.equal(showPositional.ok, true, JSON.stringify(showPositional));
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
  // fact show accepts the id positionally or as --id; both spellings produce the same Action.
  if (show.ok && showPositional.ok) {
    assert.deepEqual(showPositional.command.action, { kind: "fact-show", factId: "F-ABCDEFGH" });
    assert.deepEqual(showPositional.command.action, show.command.action);
  }
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
    parseThinCommand(["fact", "show", "F-ABCDEFGH", "--id", "F-ABCDEFGH"]),
    parseThinCommand(["fact", "show"]),
    parseThinCommand(["fact", "show", "F-ABCDEFGH", "--wat", "x"]),
  ];
  assert.deepEqual(
    failures.map((result) => (result.ok ? "ok" : result.code)),
    [
      "duplicate_field",
      "invalid_field",
      "missing_field",
      "unknown_field",
      "unsupported_command",
      "duplicate_field",
      "missing_field",
      "unknown_field",
    ],
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
  const rationaleOnly = parseThinCommand([
    "fact",
    "record",
    "--task",
    "task-1",
    "--statement",
    "Observed",
    "--source",
    "test",
    "--rationale",
    "why",
  ]);
  assert.deepEqual(rationaleOnly, {
    ok: false,
    code: "invalid_field",
    nextAction: "--rationale requires --supersedes.",
    json: false,
  });
  const supersedesOnly = parseThinCommand([
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
  ]);
  assert.deepEqual(supersedesOnly, {
    ok: false,
    code: "invalid_field",
    nextAction: "--supersedes requires --rationale.",
    json: false,
  });
  const superseding = parseThinCommand([
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
    "Corrects the target observation.",
  ]);
  assert.equal(superseding.ok, true, JSON.stringify(superseding));
  if (superseding.ok)
    assert.deepEqual(superseding.command.action, {
      kind: "fact-record",
      taskId: "task-1",
      statement: "Observed",
      evidenceSource: "test",
      confidence: "medium",
      memoryClass: "episodic",
      memoryTags: [],
      supersedes: { factRef: "fact/F-ABCDEFGH", rationale: "Corrects the target observation." },
    });
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
});

test("fact record help declares the supersedes/rationale pairing the rejection enforces", () => {
  const command = daemonProtocolCommands.find(({ id }) => id === "fact-record");
  assert.ok(command);
  for (const name of ["--supersedes", "--rationale"]) {
    const input = command.inputs.find((candidate) => candidate.name === name);
    assert.ok(input, name);
    const partner = name === "--supersedes" ? "--rationale" : "--supersedes";
    assert.deepEqual(input.requires, [partner], name);
    assert.match(command.help, new RegExp(`${name} — [^\\n]*requires: ${partner}`, "u"), name);
    const parsed = parseThinCommand([
      "fact",
      "record",
      "--statement",
      "Observed",
      "--source",
      "test",
      name,
      name === "--supersedes" ? "fact/F-ABCDEFGH" : "why",
    ]);
    assert.equal(parsed.ok, false, name);
    if (!parsed.ok) assert.equal(parsed.nextAction, `${name} requires ${partner}.`, name);
  }
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
      "--limit",
      "25",
      "--cursor",
      "WyJkZWNfTEVER0VSX0UxIl0",
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
      limit: 25,
      cursor: "WyJkZWNfTEVER0VSX0UxIl0",
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
      "accept",
      "dec_1",
      "--rationale",
      "Reviewed independently",
      "--judgment-only",
      "Reviewed independently",
    ]),
    superseded = parseThinCommand([
      "decision",
      "transition",
      "superseded",
      "dec_1",
      "--decided-at",
      "2026-08-15T00:00:00.000Z",
    ]),
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
      kind: "decision-accept",
      decisionId: "dec_1",
      rationale: "Reviewed independently",
      judgmentOnlyRationale: "Reviewed independently",
    });
  if (superseded.ok)
    assert.deepEqual(superseded.command.action, {
      kind: "decision-transition",
      decisionId: "dec_1",
      targetState: "superseded",
      decidedAt: "2026-08-15T00:00:00.000Z",
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
  assert.equal(parseThinCommand(["decision", "transition", "superseded", "dec_1", "--standing-policy"]).ok, false);
  for (const targetState of ["in_effect", "rejected", "deferred"])
    assert.equal(parseThinCommand(["decision", "transition", targetState, "dec_1"]).ok, false, targetState);
  assert.equal(parseThinCommand(["decision", "transition", "superseded", "dec_1", "--consent-by", "p1"]).ok, false);
  assert.equal(parseThinCommand(["decision", "amend", "dec_1"]).ok, false);
});

test("Decision file-flag help and the workspace read rejection state one shared path rule", () => {
  const fileFlagHelpLine = (commandId: string, flag: string) =>
    daemonProtocolCommands
      .find((command) => command.id === commandId)
      ?.help.split("\n")
      .find((line) => line.trim().startsWith(`${flag} —`));
  for (const [commandId, flag] of [
    ["decision-propose", "--from-file"],
    ["decision-propose", "--body-file"],
    ["decision-amend", "--body-file"],
  ] as const) {
    const line = fileFlagHelpLine(commandId, flag);
    assert.ok(line, `${commandId}: ${flag} help line`);
    assert.ok(line?.includes(`format: ${workspacePathFormat}`), line);
  }
  const root = mkdtempSync(path.join(tmpdir(), "ha-path-rule-"));
  try {
    assert.throws(
      () => readWorkspaceText(root, "missing-relative-probe.json", "fromFile"),
      (error: Error) => {
        assert.ok(error.message.includes("fromFile"), error.message);
        assert.ok(error.message.includes(workspacePathResolutionRule), error.message);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Decision human consent defaults absent consent-at and consent-channel at the CLI plane", () => {
  const base = ["decision", "accept", "dec_TEST", "--rationale", "approved"],
    consentOf = (args: readonly string[]) => {
      const parsed = parseThinCommand(args);
      assert.equal(parsed.ok, true, JSON.stringify(args));
      if (!parsed.ok) throw new Error("parse failed");
      return {
        consentBy: parsed.command.action.consentBy,
        consentAt: parsed.command.action.consentAt,
        consentChannel: parsed.command.action.consentChannel,
      };
    };
  assert.deepEqual(
    consentOf([
      ...base,
      "--consent-by",
      "person-test",
      "--consent-at",
      "2026-09-12T01:02:03Z",
      "--consent-channel",
      "chat",
    ]),
    { consentBy: "person-test", consentAt: "2026-09-12T01:02:03Z", consentChannel: "chat" },
  );
  assert.deepEqual(consentOf([...base, "--consent-by", "person-test", "--consent-at", "2026-09-12T01:02:03Z"]), {
    consentBy: "person-test",
    consentAt: "2026-09-12T01:02:03Z",
    consentChannel: "cli",
  });
  const before = Date.now(),
    defaulted = consentOf([...base, "--consent-by", "person-test"]),
    channelOnly = consentOf([...base, "--consent-by", "person-test", "--consent-channel", "chat"]),
    after = Date.now();
  for (const consent of [defaulted, channelOnly]) {
    assert.equal(consent.consentBy, "person-test");
    assert.equal(consent.consentChannel, consent === channelOnly ? "chat" : "cli");
    assert.match(String(consent.consentAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u);
    const at = Date.parse(String(consent.consentAt));
    assert.ok(at >= before && at <= after, `consentAt ${String(consent.consentAt)} outside [${before}, ${after}]`);
  }
  for (const args of [
    [...base, "--consent-at", "2026-09-12T01:02:03Z"],
    [...base, "--consent-by", "person-test", "--consent-channel", "email"],
    [...base, "--consent-by", "person-test", "--consent-at"],
    ["decision", "defer", "dec_TEST", "--rationale", "r", "--consent-by", "person-test"],
    ["decision", "transition", "superseded", "dec_TEST", "--consent-by", "person-test"],
  ])
    assert.equal(parseThinCommand(args).ok, false, JSON.stringify(args));
});

test("thin parser derives builtin vertical, template, and script discovery actions", () => {
  const vertical = parseThinCommand(["vertical", "validate", "--source", "software/coding"]),
    templates = parseThinCommand(["template", "list"]),
    render = parseThinCommand([
      "template",
      "render",
      "template://repository/adr-template@1",
      "--locale",
      "zh-CN",
      "--raw",
    ]),
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
      raw: true,
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

test("raw template rendering extracts only markdown body", () => {
  assert.equal(rawTemplateBody({ ok: true, evidence: JSON.stringify({ body: "# Agent\n" }) }), "# Agent\n");
  assert.throws(() => rawTemplateBody({ ok: true, evidence: JSON.stringify({}) }), /missing its rendered body/u);
});

test("structured packets name missing required fields", () => {
  assert.throws(
    () => packetJson(JSON.stringify({ completionClaim: "done" }), ["completionClaim", "commitSha"]),
    (error: unknown) =>
      (error as { code?: string; message?: string }).code === "missing_field" &&
      /commitSha/u.test((error as Error).message),
  );
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
    suspect = parseThinCommand(["relation", "list", "--freshness", "suspect"]),
    listed = parseThinCommand(["relation", "list", "--source", "task/task-a", "--target", "task/task-b"]),
    listedRefs = parseThinCommand(["relation", "list", "--source-ref", "task/task-a", "--target-ref", "task/task-b"]),
    triples = parseThinCommand(["relation", "triples", "--source-kind", "decision", "--target-kind", "fact"]);
  assert.equal(relate.ok, true);
  assert.equal(unrelate.ok, true);
  assert.equal(reconfirm.ok, true);
  assert.equal(suspect.ok, true);
  assert.equal(listed.ok, true);
  assert.equal(listedRefs.ok, true);
  assert.equal(triples.ok, true);
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
  // relation list takes the relate spellings --source-ref/--target-ref for the same query fields.
  if (listed.ok)
    assert.deepEqual(listed.command.action, {
      kind: "relation-list",
      source: "task/task-a",
      target: "task/task-b",
    });
  if (listedRefs.ok && listed.ok) assert.deepEqual(listedRefs.command.action, listed.command.action);
  if (triples.ok)
    assert.deepEqual(triples.command.action, {
      kind: "relation-triples",
      sourceKind: "decision",
      targetKind: "fact",
    });
  assert.equal(parseThinCommand(["relation", "list", "--freshness", "unknown"]).ok, false);
  const mixedSpellings = parseThinCommand([
    "relation",
    "list",
    "--source",
    "task/task-a",
    "--source-ref",
    "task/task-b",
  ]);
  assert.equal(mixedSpellings.ok, false);
  if (!mixedSpellings.ok) assert.equal(mixedSpellings.code, "invalid_field");
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

test("Relation relate names missing concurrency and rationale fields with executable hints", () => {
  const base = [
      "relation",
      "relate",
      "--source-ref",
      "decision/dec_a",
      "--target-ref",
      "task/task_a",
      "--type",
      "derives",
    ],
    missingVersion = parseThinCommand([...base, "--rationale", "Decision derives task."]),
    missingRationale = parseThinCommand([...base, "--expected-version", "0"]);
  assert.deepEqual(missingVersion, {
    ok: false,
    code: "missing_field",
    nextAction: "Add --expected-version 0 when creating a new Relation, then rerun the command.",
    json: false,
  });
  assert.deepEqual(missingRationale, {
    ok: false,
    code: "missing_field",
    nextAction: "Add --rationale <why>, then rerun the command.",
    json: false,
  });
});

test("Agent and Squad package sources resolve against caller cwd independently of repository selection", () => {
  const caller = path.resolve("caller"),
    repository = path.resolve("repository");
  for (const kind of ["agent", "squad"]) {
    for (const action of ["validate", "install"]) {
      for (const source of ["./declaration", "../declaration", path.resolve("absolute-declaration")]) {
        for (const selection of [[], ["--root", repository], ["--repo", "selected-repository"]]) {
          const parsed = parseThinCommand([kind, action, "--source", source, ...selection], caller);
          assert.equal(parsed.ok, true);
          if (!parsed.ok) continue;
          assert.equal(parsed.command.action.packageSource, path.resolve(caller, source));
          assert.equal(parsed.command.rootDir, selection[0] === "--root" ? repository : caller);
        }
      }
    }
  }
});

test("squad run derives its mission from task unless prompt overrides it", () => {
  const promptFile = parseThinCommand([
      "squad",
      "run",
      "core-squad",
      "--instance",
      "worker",
      "--prompt-file",
      "mission.md",
      "--cwd",
      "work",
      "--task",
      "task-1",
    ]),
    prompt = parseThinCommand([
      "squad",
      "run",
      "core-squad",
      "--instance",
      "worker",
      "--prompt",
      "mission",
      "--cwd",
      "work",
      "--task",
      "task-1",
      "--permission-mode",
      "workspace-write",
    ]),
    both = parseThinCommand([
      "squad",
      "run",
      "core-squad",
      "--instance",
      "worker",
      "--prompt",
      "mission",
      "--prompt-file",
      "mission.md",
      "--cwd",
      "work",
      "--task",
      "task-1",
    ]),
    taskOnly = parseThinCommand(["squad", "run", "core-squad", "--instance", "worker", "--task", "task-1"]);
  assert.equal(promptFile.ok, false);
  assert.equal(prompt.ok, true);
  if (prompt.ok) {
    assert.equal(prompt.command.action.prompt, "mission");
    assert.equal(prompt.command.action.permissionMode, "workspace-write");
  }
  assert.equal(both.ok, false);
  assert.equal(taskOnly.ok, true);
  if (taskOnly.ok) assert.deepEqual(taskOnly.command.action.cwd, { scope: "repo-root" });
});

test("Agent and Squad declaration commands route reads directly and writes through the daemon entity lifecycle", () => {
  const cases: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [["agent", "list"], "agent-list", "repo.task.read"],
    [["agent", "inspect", "terra"], "agent-inspect", "repo.task.read"],
    [["agent", "validate", "--source", "terra"], "agent-validate", "repo.task.read"],
    [["agent", "install", "--source", "terra", "--dry-run"], "agent-install", "repo.task.run"],
    [["squad", "list"], "squad-list", "repo.task.read"],
    [["squad", "inspect", "core-squad"], "squad-inspect", "repo.task.read"],
    [["squad", "status", "squad_0123456789abcdef01234567"], "squad-status", "repo.task.read"],
    [["squad", "validate", "--source", "core-squad"], "squad-validate", "repo.task.read"],
    [["squad", "install", "--source", "core-squad"], "squad-install", "repo.task.run"],
  ];
  for (const [argv, kind, method] of cases) {
    const parsed = parseThinCommand([...argv]);
    assert.equal(parsed.ok, true, JSON.stringify(argv));
    if (parsed.ok) {
      assert.equal(parsed.command.method, method);
      assert.equal(parsed.command.action.kind, kind);
    }
  }
  assert.equal(parseThinCommand(["squad", "status"]).ok, false);
  const create = parseThinCommand([
    "agent",
    "create",
    "codex-sidecar",
    "--agent",
    "meta",
    "--prompt",
    "Design a worker",
    "--task",
    "task-1",
  ]);
  assert.equal(create.ok, true, JSON.stringify(create));
  if (create.ok)
    assert.deepEqual(
      { method: create.command.method, action: create.command.action },
      {
        method: "repo.agentRuntime.spawn",
        action: {
          kind: "agent-create",
          runtimeInstanceId: "codex-sidecar",
          agentId: "meta",
          prompt: "Design a worker",
          taskId: "task-1",
          cwd: { scope: "repo-root" },
        },
      },
    );
});
test("runtime instance create leaves installation discovery to the daemon when omitted", () => {
  const parsed = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "codex-auto",
    "--name",
    "Codex Auto",
    "--kind",
    "codex",
    "--provider",
    "openai",
    "--model",
    "gpt-5.6-sol",
    "--auth",
    "subscription",
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) assert.equal("installationId" in parsed.command.action, false);
  const multi = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "claude-multi",
    "--name",
    "Claude Multi",
    "--kind",
    "claude",
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5",
    "--model",
    "claude-opus",
    "--default-model",
    "claude-opus",
    "--permission-mode",
    "workspace-write",
    "--isolation",
    "enforced",
    "--auth",
    "subscription",
  ]);
  assert.equal(multi.ok, true, JSON.stringify(multi));
  if (multi.ok)
    assert.deepEqual(multi.command.action, {
      kind: "runtime-instance-create",
      instanceId: "claude-multi",
      name: "Claude Multi",
      kindId: "claude",
      providerId: "anthropic",
      models: ["claude-fable-5", "claude-opus"],
      defaultModel: "claude-opus",
      permissionMode: "workspace-write",
      isolationState: "enforced",
      claude: {},
      authMode: "subscription",
    });
  const agy = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "agy-open",
    "--name",
    "AGY Open",
    "--kind",
    "agy",
    "--provider",
    "google",
    "--model",
    "gemini-3.1-pro-low",
    "--permission-mode",
    "bypass",
    "--auth",
    "subscription",
  ]);
  assert.equal(agy.ok, true, JSON.stringify(agy));
  if (agy.ok) assert.equal(agy.command.action.permissionMode, "bypass");
  assert.equal(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--permission-mode",
      "turbo",
      "--model",
      "gpt",
      "--auth",
      "subscription",
    ]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--provider",
      "openai",
      "--auth",
      "subscription",
    ]).ok,
    false,
  );
});

test("runtime instance auth commands parse into repo-scoped interactive sign-in actions", () => {
  const login = parseThinCommand([
      "runtime",
      "instance",
      "login",
      "worker",
      "--repo",
      "alpha",
      "--idempotency-key",
      "sign-in-once",
    ]),
    logout = parseThinCommand(["runtime", "instance", "logout", "worker"]);
  for (const parsed of [login, logout]) assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (login.ok)
    assert.deepEqual(
      {
        repoId: login.command.repoId,
        method: login.command.method,
        action: login.command.action,
      },
      {
        repoId: "alpha",
        method: "repo.runtimeInstance.auth.login",
        action: {
          kind: "runtime-instance-login",
          instanceId: "worker",
          idempotencyKey: "sign-in-once",
        },
      },
    );
  if (logout.ok)
    assert.deepEqual(
      { method: logout.command.method, action: logout.command.action },
      {
        method: "repo.runtimeInstance.auth.logout",
        action: { kind: "runtime-instance-logout", instanceId: "worker" },
      },
    );
  assert.equal(parseThinCommand(["runtime", "instance", "login"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "instance", "login", "worker", "--prompt", "x"]).ok, false);
  assert.equal(parseThinCommand(["runtime", "instance", "reauth", "worker"]).ok, false);
  const shown = parseThinCommand(["runtime", "instance", "show", "worker", "--repo", "alpha", "--probe"]);
  assert.equal(shown.ok === true && shown.command.repoId, undefined);
  if (shown.ok) assert.equal(shown.command.action.probe, true);
});

test("migration import parser accepts ordered sources and repeated explicit conflict resolutions", () => {
  const parsed = parseThinCommand([
    "migrate",
    "import",
    "--source",
    "../alice",
    "--source",
    "../bob",
    "--resolve",
    "harness/people.yaml=source",
    "--resolve",
    "harness/AGENTS.md=destination",
    "--dry-run",
    "--json",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "migrate-import",
      sourceRoots: ["../alice", "../bob"],
      resolutions: ["harness/people.yaml=source", "harness/AGENTS.md=destination"],
      dryRun: true,
    });
  assert.equal(parseThinCommand(["migrate", "import"]).ok, false);
  assert.equal(
    parseThinCommand(["migrate", "import", "--source", "a", "--resolve", "harness/people.yaml=automatic"]).ok,
    false,
  );
  assert.equal(parseThinCommand(["migrate", "import", "--source", "a", "--force"]).ok, false);
});

test("retired in-place ledger migration is rejected while generation reconciliation remains readable", () => {
  for (const argv of [
    ["migrate", "ledger"],
    ["migrate", "ledger", "--generation", "1"],
    ["migrate", "ledger", "--dry-run"],
  ])
    assert.equal(parseThinCommand(argv).ok, false, argv.join(" "));
});

test("ledger reconcile requires the declared SQLite generation", () => {
  const parsed = parseThinCommand(["ledger", "reconcile", "--generation", "1", "--json"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.command.action, { kind: "ledger-reconcile", generation: 1 });
    assert.equal(parsed.command.method, "repo.task.read");
    assert.equal(parsed.command.json, true);
  }
  assert.equal(parseThinCommand(["ledger", "reconcile"]).ok, false);
  assert.equal(parseThinCommand(["ledger", "reconcile", "--generation", "2"]).ok, false);
});
