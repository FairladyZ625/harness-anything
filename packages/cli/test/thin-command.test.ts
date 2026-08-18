// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { daemonProtocolCommands, thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { main, resolveCliVersion } from "../src/index.ts";
import { deriveCliCapabilities, firstCliCommand, firstCliCommandIndex, parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";

test("top-level help renders a derived domain directory and domain help filters commands", () => {
  const help = renderThinHelp();
  assert.equal(thinCliCommands.length, 90);
  for (const domain of [...new Set(daemonProtocolCommands.map((command) => command.path[0]))].filter((value): value is string => value !== undefined).sort()) assert.match(help, new RegExp(`^  ${domain} \\(`, "mu"));
  assert.doesNotMatch(help, /ha task start <task-id>/u);
  const taskHelp = renderThinHelp([], "task");
  for (const command of thinCliCommands.filter(({ usage }) => usage.split(" ")[1] === "task")) assert.match(taskHelp, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(taskHelp, /ha decision propose|ha preset list/u);
  for (const domain of ["decision", "distill"]) {
    const domainHelp = renderThinHelp([], domain);
    for (const command of thinCliCommands.filter(({ usage }) => usage.split(" ")[1] === domain)) assert.match(domainHelp, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(help, /capabilities \[--json\].*--version.*ha daemon start --service/su);
});

test("an unknown command domain reports unknown with the available set instead of an empty help page", async () => {
  const logs: string[] = [], errors: string[] = [], log = console.log, error = console.error;
  console.log = (value: unknown) => { logs.push(String(value)); }; console.error = (value: unknown) => { errors.push(String(value)); };
  const exits: number[] = [];
  try { exits.push(await main(["bananas", "--help"]), await main(["bananas"]), await main(["migrate", "--help"])); } finally { console.log = log; console.error = error; }
  assert.deepEqual(exits, [2, 2, 0]);
  assert.equal(errors.length, 2); assert.equal(errors[0], errors[1]);
  for (const line of errors) { assert.match(line, /code=unsupported_command/u); assert.match(line, /bananas is not a command domain/u); for (const domain of Object.keys(deriveCliCapabilities())) assert.match(line, new RegExp(`\\b${domain}\\b`, "u")); }
  assert.equal(logs.length, 1); assert.match(logs[0] ?? "", /Commands for migrate:\n {2}ha migrate import/u);
});

test("capabilities is an exact-set projection of the command contract", () => {
  assert.deepEqual(deriveCliCapabilities(), {
    daemon: ["daemon-fleet-center-start", "daemon-fleet-edge-sync", "daemon-repo-register", "daemon-repo-unregister", "daemon-start", "daemon-status", "daemon-stop"],
    decision: ["decision-accept", "decision-amend", "decision-claim-add", "decision-claim-fulfill", "decision-defer", "decision-list", "decision-propose", "decision-reckon", "decision-reject", "decision-relate", "decision-relation-replace", "decision-relation-retire", "decision-repin", "decision-retire", "decision-show", "decision-supersede", "decision-transition", "decision-validate", "decision-verify"],
    distill: ["distill-candidate", "distill-promote"],
    doc: ["doc-materialize", "doc-show", "doc-status", "doc-sync-dry-run", "doc-sync-submit"],
    fact: ["fact-record", "fact-search", "fact-show"],
    init: ["repo-bootstrap"],
    migrate: ["ledger-migrate", "migrate-import"],
    preset: ["preset-audit", "preset-check", "preset-inspect", "preset-install", "preset-list", "preset-seed", "preset-uninstall", "preset-upgrade", "preset-validate"],
    receipt: ["receipt-show"],
    relation: ["relation-list"],
    runtime: ["runtime-cancel", "runtime-instance-create", "runtime-instance-delete", "runtime-instance-list", "runtime-instance-login", "runtime-instance-logout", "runtime-instance-reauth", "runtime-instance-show", "runtime-instance-status", "runtime-run", "runtime-status", "runtime-wait"],
    script: ["preset-run-start", "script-inspect", "script-list", "script-run"],
    task: ["task-amend", "task-archive", "task-artifact-add", "task-code-doc-reconcile", "task-complete", "task-contract-migrate", "task-create", "task-delete", "task-list", "task-progress-append", "task-relate", "task-release", "task-reopen", "task-review", "task-review-consent", "task-review-execution", "task-show", "task-start", "task-submit", "task-supersede", "task-transition"],
    template: ["template-list", "template-render"],
    vertical: ["vertical-validate"]
  });
});

test("CLI version is read from the CLI package metadata", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(resolveCliVersion(), packageJson.version);
});

test("task-create help renders recommended presets only from effective catalog rows", () => {
  const help = renderThinHelp([{ id: "standard-task", title: "Standard Task", description: "General work.", validity: "valid" }, { id: "module", title: "Module", description: "Registered module work.", validity: "unavailable", errorCode: "missing_provider" }]);
  assert.match(help, /Recommended presets:.*standard-task — Standard Task — General work\..*module — Module — unavailable \(missing_provider\)/su);
  assert.doesNotMatch(help, /reference-task|long-running-task/u);
});

test("thin parser derives closed preset and task-create payloads from descriptors", () => {
  assert.equal(parseThinCommand(["doc", "sync"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "Bound", "--completion-gate", "G32"]).ok, false);
  const create = parseThinCommand(["task", "create", "--title", "Bound", "--preset", "create-milestone", "--task-class", "milestone", "--dry-run"]), inspect = parseThinCommand(["preset", "inspect", "standard-task", "--locale", "en-US"]), check = parseThinCommand(["preset", "check", "standard-task", "--snapshot-digest", `sha256:${"a".repeat(64)}`]), validate = parseThinCommand(["preset", "validate", "--source", "package"]), install = parseThinCommand(["preset", "install", "--source", "package", "--dry-run"]), seed = parseThinCommand(["preset", "seed", "--dry-run"]), audit = parseThinCommand(["preset", "audit", "--vertical", "software/coding"]), uninstall = parseThinCommand(["preset", "uninstall", "standard-task", "--dry-run"]), upgrade = parseThinCommand(["preset", "upgrade", "task-1"]);
  assert.equal([create, inspect, check, validate, install, seed, audit, uninstall, upgrade].every((result) => result.ok), true); if (create.ok) { assert.equal(create.command.method, "repo.task.create"); assert.deepEqual(create.command.action, { kind: "task-create", title: "Bound", presetId: "create-milestone", taskClass: "milestone", dryRun: true }); } if (inspect.ok) { assert.equal(inspect.command.method, "repo.preset.inspect"); assert.deepEqual(inspect.command.action, { kind: "preset-inspect", presetId: "standard-task", locale: "en-US" }); } if (check.ok) assert.equal(check.command.action.snapshotDigest, `sha256:${"a".repeat(64)}`); if (validate.ok) assert.deepEqual(validate.command.action, { kind: "preset-validate", packageSource: "package" }); if (install.ok) assert.deepEqual(install.command.action, { kind: "preset-install", packageSource: "package", dryRun: true }); if (seed.ok) assert.deepEqual(seed.command.action, { kind: "preset-seed", dryRun: true }); if (audit.ok) assert.deepEqual(audit.command.action, { kind: "preset-audit", verticalId: "software/coding" }); if (uninstall.ok) assert.deepEqual(uninstall.command.action, { kind: "preset-uninstall", presetId: "standard-task", dryRun: true }); if (upgrade.ok) assert.deepEqual(upgrade.command.action, { kind: "preset-upgrade", taskId: "task-1" });
});

test("task create preserves the complete contract and initial relations in one closed action", () => {
  const parsed = parseThinCommand(["task", "create", "--title", "Surface", "--id", "task_surface", "--migration", "--idempotency-key", "surface-once", "--parent", "task_parent", "--kind", "feat", "--risk-tier", "high", "--urgency", "medium", "--vertical", "software/coding", "--preset", "standard-task", "--profile", "default", "--module", "kernel", "--slug", "surface", "--surface", "ha task create", "--surface", "packages/kernel", "--relation", "depends-on:task/task_dependency:Dependency must land first", "--locale", "zh-CN", "--dry-run"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "task-create", title: "Surface", taskId: "task_surface", createMode: "migration", idempotencyKey: "surface-once", parentTaskId: "task_parent", workKind: "feat", riskTier: "high", urgency: "medium", verticalId: "software/coding", presetId: "standard-task", profileId: "default", moduleKey: "kernel", slug: "surface", surfaces: ["ha task create", "packages/kernel"], relations: [{ type: "depends-on", target: "task/task_dependency", rationale: "Dependency must land first" }], locale: "zh-CN", dryRun: true });
  assert.equal(parseThinCommand(["task", "create", "--title", "Bad id", "--id", "task_bad"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--task-id", "task_old", "--title", "Retired alias"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "Bad input", "--from-file", "task.json", "--json-input", "{}"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "Bad module", "--register-module", "kernel", "--module-title", "Kernel"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--json-input", '{"title":"Structured"}']).ok, true);
  assert.equal(parseThinCommand(["task", "create", "--from-legacy", "legacy-1"]).ok, true);
  assert.equal(parseThinCommand(["task", "create"]).ok, false);
});

test("long-running work arrives only as --task-class long_running; the retired boolean flag is unknown", () => {
  const resident = parseThinCommand(["task", "create", "--title", "Resident ledger", "--task-class", "long_running"]);
  assert.equal(resident.ok, true, JSON.stringify(resident));
  if (resident.ok) assert.deepEqual(resident.command.action, { kind: "task-create", title: "Resident ledger", taskClass: "long_running" });
  assert.deepEqual(parseThinCommand(["task", "create", "--title", "Resident ledger", "--long-running"]), { ok: false, code: "unknown_field", nextAction: "Unknown option --long-running.", json: false });
  assert.equal(parseThinCommand(["task", "create", "--title", "Resident ledger", "--task-class", "long-running"]).ok, false);
});

test("task lifecycle and read surfaces parse every F03 F04 F05 leaf into closed actions", () => {
  const cases = [
    [["task", "start", "task-1", "--execution-id", "exe-1", "--ttl-ms", "60000", "--dry-run"], { kind: "task-start", verb: "start", commandType: "StartExecution", taskId: "task-1", executionId: "exe-1", ttlMs: 60000, dryRun: true }],
    [["task", "release", "task-1"], { kind: "task-release", taskId: "task-1" }],
    [["task", "transition", "task-1", "cancelled", "--force", "--reason", "Invalid scope"], { kind: "task-transition", taskId: "task-1", status: "cancelled", force: true, reason: "Invalid scope" }],
    [["task", "transition", "task-1", "planned", "--reason", "Owner rolled back the batch cancellation"], { kind: "task-transition", taskId: "task-1", status: "planned", reason: "Owner rolled back the batch cancellation" }],
    [["task", "amend", "task-1", "--set", "title:New title", "--set", "riskTier:high"], { kind: "task-amend", taskId: "task-1", patches: [{ field: "title", value: "New title" }, { field: "riskTier", value: "high" }] }],
    [["task", "archive", "task-1", "--reason", "Delivered", "--archived-by", "owner"], { kind: "task-archive", taskId: "task-1", reason: "Delivered", archivedBy: "owner" }],
    [["task", "supersede", "task-1", "--by", "task-2", "--confirm", "task-1", "--reason", "Scope changed"], { kind: "task-supersede", oldTaskId: "task-1", byTaskId: "task-2", confirm: "task-1", reason: "Scope changed", allowOpenFindings: false }],
    [["task", "delete", "--soft", "task-1", "--reason", "Duplicate"], { kind: "task-delete", taskId: "task-1", mode: "soft", reason: "Duplicate" }],
    [["task", "reopen", "task-1", "--reason", "Needed again"], { kind: "task-reopen", taskId: "task-1", reason: "Needed again" }],
    [["task", "contract", "migrate", "--dry-run", "--task", "task-1"], { kind: "task-contract-migrate", mode: "dry-run", taskId: "task-1" }],
    [["task", "review", "task-1", "--reviewer", "reviewer-1"], { kind: "task-review", taskId: "task-1", reviewerId: "reviewer-1" }],
    [["task", "list", "--status", "blocked", "--module", "kernel", "--search", "surface"], { kind: "task-list", status: "blocked", module: "kernel", search: "surface" }],
    [["relation", "list", "--entity", "task/task-1", "--type", "depends-on", "--state", "active"], { kind: "relation-list", entity: "task/task-1", relationType: "depends-on", state: "active" }],
    [["task", "relate", "task-1", "depends-on", "task-2", "--rationale", "Must land first", "--dry-run"], { kind: "task-relate", taskId: "task-1", target: "task/task-2", relationType: "depends-on", rationale: "Must land first", dryRun: true }]
  ] as const;
  for (const [argv, expected] of cases) { const parsed = parseThinCommand(argv); assert.equal(parsed.ok, true, `${argv.join(" ")}: ${JSON.stringify(parsed)}`); if (parsed.ok) assert.deepEqual(parsed.command.action, expected); }
  assert.equal(parseThinCommand(["task", "transition", "task-1", "done"]).ok, false);
  const bareReinstate = parseThinCommand(["task", "transition", "task-1", "planned"]);
  assert.equal(bareReinstate.ok, false);
  if (!bareReinstate.ok) { assert.equal(bareReinstate.code, "missing_field"); assert.match(bareReinstate.nextAction, /--reason/u); }
  // G-cancel-hint: each missing piece of an audited cancellation is named on its own, never told to add a flag already present.
  const cancelReasonOnly = parseThinCommand(["task", "transition", "task-1", "cancelled", "--reason", "Superseded"]);
  assert.equal(cancelReasonOnly.ok, false);
  if (!cancelReasonOnly.ok) { assert.match(cancelReasonOnly.nextAction, /--force/u); assert.doesNotMatch(cancelReasonOnly.nextAction, /add --reason/u); }
  const cancelForceOnly = parseThinCommand(["task", "transition", "task-1", "cancelled", "--force"]);
  assert.equal(cancelForceOnly.ok, false);
  if (!cancelForceOnly.ok) { assert.equal(cancelForceOnly.code, "missing_field"); assert.match(cancelForceOnly.nextAction, /--reason/u); }
  const cancelBare = parseThinCommand(["task", "transition", "task-1", "cancelled"]);
  assert.equal(cancelBare.ok, false);
  if (!cancelBare.ok) assert.match(cancelBare.nextAction, /--force/u);
  const forceOutsideCancel = parseThinCommand(["task", "transition", "task-1", "active", "--force"]);
  assert.equal(forceOutsideCancel.ok, false);
  if (!forceOutsideCancel.ok) assert.doesNotMatch(forceOutsideCancel.nextAction, /add --reason/u);
  assert.equal(parseThinCommand(["task", "delete", "--hard", "task-1", "--confirm", "task-1"]).ok, true);
  assert.equal(parseThinCommand(["task", "contract", "migrate", "--apply", "--dry-run"]).ok, false);
  assert.equal(parseThinCommand(["task", "supersede", "task-1", "--by", "task-2"]).ok, false);
  assert.equal(parseThinCommand(["task", "supersede", "task-1", "--by", "task-2", "--confirm", "task-1"]).ok, true);
});

test("thin parser derives builtin vertical, template, and script discovery actions", () => {
  const vertical = parseThinCommand(["vertical", "validate", "--source", "software/coding"]), templates = parseThinCommand(["template", "list"]), render = parseThinCommand(["template", "render", "template://repository/adr-template@1", "--locale", "zh-CN"]), scripts = parseThinCommand(["script", "list"]), inspect = parseThinCommand(["script", "inspect", "vertical:software-coding:architecture-check"]);
  assert.equal([vertical, templates, render, scripts, inspect].every((result) => result.ok), true); if (vertical.ok) assert.deepEqual(vertical.command.action, { kind: "vertical-validate", verticalSource: "software/coding" }); if (templates.ok) assert.deepEqual(templates.command.action, { kind: "template-list" }); if (render.ok) assert.deepEqual(render.command.action, { kind: "template-render", templateRef: "template://repository/adr-template@1", locale: "zh-CN" }); if (scripts.ok) assert.deepEqual(scripts.command.action, { kind: "script-list" }); if (inspect.ok) assert.deepEqual(inspect.command.action, { kind: "script-inspect", scriptId: "vertical:software-coding:architecture-check" });
  const run = parseThinCommand(["script", "run", "vertical:software-coding:architecture-check", "--task-id", "task-1", "--inputs", '{"locale":"en-US"}', "--dry-run"]); assert.equal(run.ok, true); if (run.ok) assert.deepEqual(run.command, { rootDir: run.command.rootDir, json: false, method: "repo.script.run", action: { schema: "vertical-script-action/v1", kind: "script-run", scriptId: "vertical:software-coding:architecture-check", taskId: "task-1", inputs: { locale: "en-US" }, dryRun: true } });
  assert.equal(parseThinCommand(["script", "run", "user-canary/check"]).ok, false);
  assert.equal(parseThinCommand(["preset", "run", "standard-task"]).ok, false);
  assert.equal(parseThinCommand(["preset", "action", "standard-task"]).ok, false);
});

test("Fact CLI exposes only record/search/show and covers all five local parse errors", () => {
  const record = parseThinCommand(["fact", "record", "--task", "task-1", "--statement", "Observed", "--source", "test", "--confidence", "high", "--memory-class", "semantic", "--memory-tag", "pattern"]);
  const search = parseThinCommand(["fact", "search", "Observed", "--task", "task-1"]), show = parseThinCommand(["fact", "show", "--task", "task-1", "--id", "F-ABCDEFGH"]);
  assert.equal(record.ok, true); assert.equal(search.ok, true); assert.equal(show.ok, true);
  if (record.ok) assert.deepEqual(record.command.action, { kind: "fact-record", taskId: "task-1", statement: "Observed", evidenceSource: "test", confidence: "high", memoryClass: "semantic", memoryTags: ["pattern"] });
  const failures = [
    parseThinCommand(["fact", "record", "--task", "a", "--task", "b", "--statement", "x", "--source", "s"]),
    parseThinCommand(["fact", "show", "--task", "a", "--id", "bad"]),
    parseThinCommand(["fact", "record", "--task", "a"]),
    parseThinCommand(["fact", "search", "--wat", "x"]),
    parseThinCommand(["fact", "list"])
  ];
  assert.deepEqual(failures.map((result) => result.ok ? "ok" : result.code), ["duplicate_field", "invalid_field", "missing_field", "unknown_field", "unsupported_command"]);
  const excessiveRationale = parseThinCommand(["fact", "record", "--task", "task-1", "--statement", "Observed", "--source", "test",
    "--supersedes", "fact/task-1/F-ABCDEFGH", "--rationale", "x".repeat(200)]);
  assert.equal(excessiveRationale.ok ? "ok" : excessiveRationale.code, "invalid_field");
});

test("Decision CLI maps every canonical command and keeps the five local error codes closed", () => {
  const packet = JSON.stringify({ title: "Canonical", question: "Should events own this Decision?", riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["kernel"], productLines: [] }, chosen: [{ id: "CH1", text: "Use events" }], rejected: [{ id: "RJ1", text: "Use files", whyNot: "Not canonical" }], claims: [], fulfillments: [], relations: [] }),
    propose = parseThinCommand(["decision", "propose", "--json-input", packet, "--body", "# Canonical\n\nInitial prose.\n"]),
    accept = parseThinCommand(["decision", "accept", "dec_1", "--rationale", "Independent approval", "--judgment-only", "CEO judgment without evidence"]),
    claim = parseThinCommand(["decision", "claim", "add", "dec_1", "--id", "C1", "--text", "Coverage is replayable"]),
    fulfill = parseThinCommand(["decision", "claim", "fulfill", "dec_1", "--id", "C1", "--mode", "evidenced"]),
    relate = parseThinCommand(["decision", "relate", "dec_1", "--anchor", "C1", "--type", "evidenced-by", "--target", "fact/task-1/F-ABCDEFGH", "--rationale", "Observed"]),
    retireRelation = parseThinCommand(["decision", "relation", "retire", "dec_1", "--relation", "rel_0123456789abcdef", "--reason", "Stale"]),
    reckon = parseThinCommand(["decision", "reckon", "dec_1", "--task", "task-1"]), list = parseThinCommand(["decision", "list", "--search", "Canonical", "--state", "in_effect", "--legacy-id", "E12", "--legacy-range", "E1-E20", "--module", "kernel", "--product-line", "platform"]), show = parseThinCommand(["decision", "show", "E12", "--include-body"]);
  assert.equal([propose, accept, claim, fulfill, relate, retireRelation, reckon, list, show].every((result) => result.ok), true);
  if (propose.ok) assert.deepEqual(propose.command.action, { kind: "decision-propose", jsonInput: packet, body: "# Canonical\n\nInitial prose.\n" });
  if (accept.ok) assert.deepEqual(accept.command.action, { kind: "decision-accept", decisionId: "dec_1", rationale: "Independent approval", judgmentOnlyRationale: "CEO judgment without evidence" });
  if (list.ok) assert.deepEqual(list.command.action, { kind: "decision-list", search: "Canonical", state: "in_effect", legacyId: "E12", legacyRange: { start: 1, end: 20 }, module: "kernel", productLine: "platform" });
  if (show.ok) assert.deepEqual(show.command.action, { kind: "decision-show", decisionId: "E12", includeBody: true });
  const failures = [
    parseThinCommand(["decision", "accept", "dec_1", "--rationale", "a", "--rationale", "b"]),
    parseThinCommand(["decision", "accept", "dec_1", "--rationale", "valid", "--judgment-only", "x".repeat(200)]),
    parseThinCommand(["decision", "accept"]),
    parseThinCommand(["decision", "show", "dec_1", "--body"]),
    parseThinCommand(["decision", "search"])
  ];
  assert.deepEqual(failures.map((result) => result.ok ? "ok" : result.code), ["duplicate_field", "invalid_field", "missing_field", "unknown_field", "unsupported_command"]);
  assert.equal(parseThinCommand(["decision", "propose", "--from-file", "proposal.json", "--json-input", packet]).ok, false);
  assert.equal(parseThinCommand(["decision", "propose", "--json-input", packet, "--body", "inline", "--body-file", "body.md"]).ok, false);
  assert.equal(parseThinCommand(["decision", "propose", "--title", "retired flags-only proposal"]).ok, false);
  assert.equal(parseThinCommand(["decision", "relate", "dec_1", "--type", "relates", "--target", "task/task-1", "--rationale", "Missing anchor"]).ok, false);
  assert.equal(parseThinCommand(["decision", "list", "--legacy-range", "E20-E1"]).ok, false);
});

test("Decision F06 and distill leaf commands preserve their complete structured payloads", () => {
  const validate = parseThinCommand(["decision", "validate", "dec_1"]), verifyAll = parseThinCommand(["decision", "verify", "--all"]), repin = parseThinCommand(["decision", "repin", "--all", "--migration-evidence", "task/task-1/audit-2026"]), active = parseThinCommand(["decision", "transition", "in_effect", "dec_1", "--decided-at", "2026-08-15T00:00:00.000Z", "--judgment-only", "Reviewed independently", "--fulfillment", "C1:delivered"]), superseded = parseThinCommand(["decision", "transition", "superseded", "dec_1"]), alias = parseThinCommand(["decision", "supersede", "dec_1", "--reason", "Replaced by a newer Decision"]), amend = parseThinCommand(["decision", "amend", "dec_1", "--title", "Corrected", "--non-load-bearing", "C1", "--append", 'claims:{"id":"C2","text":"Stable","loadBearing":false}', "--body-file", "body.md"]), replace = parseThinCommand(["decision", "relation", "replace", "dec_1", "--relation", "rel_0123456789abcdef", "--anchor", "C1", "--type", "relates", "--target", "task/task-1", "--rationale", "Corrected edge"]), candidate = parseThinCommand(["distill", "candidate", "--task", "task-1", "--input", "notes.md"]), promote = parseThinCommand(["distill", "promote", "--task", "task-1", "--candidate", ".harness/distill/task-1/candidate.json", "--claim", "Stable fact", "--id", "F-ABCDEFGH", "--memory-tag", "pattern"]);
  assert.equal([validate, verifyAll, repin, active, superseded, alias, amend, replace, candidate, promote].every((result) => result.ok), true);
  if (validate.ok) assert.deepEqual(validate.command.action, { kind: "decision-validate", decisionId: "dec_1" });
  if (verifyAll.ok) assert.deepEqual(verifyAll.command.action, { kind: "decision-validate", all: true });
  if (repin.ok) assert.deepEqual(repin.command.action, { kind: "decision-repin", all: true, migrationEvidence: "task/task-1/audit-2026" });
  if (active.ok) assert.deepEqual(active.command.action, { kind: "decision-transition", decisionId: "dec_1", targetState: "in_effect", decidedAt: "2026-08-15T00:00:00.000Z", judgmentOnlyRationale: "Reviewed independently", standingPolicy: false, fulfillments: [{ claimId: "C1", mode: "delivered" }], dryRun: false });
  if (amend.ok) assert.deepEqual(amend.command.action, { kind: "decision-amend", decisionId: "dec_1", title: "Corrected", standingPolicy: false, fulfillments: [], loadBearing: { claimId: "C1", value: false }, sets: [], appends: ['claims:{"id":"C2","text":"Stable","loadBearing":false}'], bodyFile: "body.md", dryRun: false });
  if (replace.ok) assert.deepEqual(replace.command.action, { kind: "decision-relation-replace", decisionId: "dec_1", relationId: "rel_0123456789abcdef", body: null, dryRun: false, anchor: "C1", relationType: "relates", target: "task/task-1", rationale: "Corrected edge" });
  const preview = parseThinCommand(["decision", "amend", "dec_1", "--title", "Preview", "--dry-run"]); assert.equal(preview.ok, true); if (preview.ok) assert.equal(preview.command.action.dryRun, true);
  if (candidate.ok) assert.deepEqual(candidate.command.action, { kind: "distill-candidate", taskId: "task-1", inputPath: "notes.md" });
  if (promote.ok) assert.deepEqual(promote.command.action, { kind: "distill-promote", taskId: "task-1", candidatePath: ".harness/distill/task-1/candidate.json", statement: "Stable fact", factId: "F-ABCDEFGH", confidence: "medium", memoryClass: "semantic", memoryTags: ["pattern"] });
  assert.equal(parseThinCommand(["distill", "commit"]).ok, false);
  assert.equal(parseThinCommand(["decision", "validate", "dec_1", "--all"]).ok, false);
  assert.equal(parseThinCommand(["decision", "transition", "retired", "dec_1", "--standing-policy"]).ok, false);
  assert.equal(parseThinCommand(["decision", "amend", "dec_1"]).ok, false);
});

test("thin parser converts the sole preset script target into closed typed start params", () => {
  const parsed = parseThinCommand(["script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--task-id", "task-1", "--inputs", '{"title":"Canary"}']);
  assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command, { rootDir: parsed.command.rootDir, json: false, method: "repo.preset.run.start", action: { kind: "preset-run-start", presetId: "user-canary", entrypoint: "check", idempotencyKey: "once", taskId: "task-1", inputs: { title: "Canary" } } });
  assert.equal(parseThinCommand(["script", "run", "user-canary/check", "--idempotency-key", "once"]).ok, false);
  assert.equal(parseThinCommand(["script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--inputs", "not-json"]).ok, false);
});

test("thin doc commands derive descriptor-only actions from the protocol directory", () => {
  const status = parseThinCommand(["doc", "status"]), selectedStatus = parseThinCommand(["doc", "status", "--path", "context/a.md", "--path", "context/b.md"]), dryRun = parseThinCommand(["doc", "sync", "--dry-run", "--path", "context/a.md", "--path", "context/b.md"]), materialize = parseThinCommand(["doc", "materialize"]),
    show = parseThinCommand(["doc", "show", "--path", "tasks/task-1/INDEX.md"]),
    submit = parseThinCommand(["doc", "sync", "--submit", "--execution-id", "exec-1", "--path", "context/a.md", "--path", "context/b.md"]);
  assert.equal(status.ok, true); assert.equal(selectedStatus.ok, true); assert.equal(dryRun.ok, true); assert.equal(materialize.ok, true); assert.equal(show.ok, true); assert.equal(submit.ok, true);
  if (status.ok) assert.deepEqual(status.command.action, { kind: "doc-status", paths: [] });
  if (selectedStatus.ok) assert.deepEqual(selectedStatus.command.action, { kind: "doc-status", paths: ["context/a.md", "context/b.md"] });
  if (dryRun.ok) assert.deepEqual(dryRun.command.action, { kind: "doc-dry-run", paths: ["context/a.md", "context/b.md"] });
  if (materialize.ok) assert.deepEqual(materialize.command.action, { kind: "doc-materialize" });
  if (show.ok) assert.deepEqual(show.command.action, { kind: "doc-show", path: "tasks/task-1/INDEX.md" });
  if (submit.ok) {
    assert.deepEqual(submit.command.action, { kind: "doc-submit", executionId: "exec-1", paths: ["context/a.md", "context/b.md"] });
    assert.deepEqual(Object.keys(submit.command.action).sort(), ["executionId", "kind", "paths"]);
  }
  assert.equal(parseThinCommand(["doc", "show", "--path", "INDEX.md", "--body", "inline"]).ok, false);
});

test("doc CLI and GUI delivery surfaces do not import store, Git, or semantic compiler code", () => {
  const sources = ["../src/cli/thin-command.ts", "../../gui/src/api/api-contract-registry.ts", "../../gui/src/api/service-bridge.ts", "../../gui/src/main/local-composition-root.ts"];
  for (const source of sources) assert.doesNotMatch(readFileSync(new URL(source, import.meta.url), "utf8"), /kernel\/src\/(?:store|domain)|local-version-control|simple-git|semantic-compiler|node:(?:child_process|fs)/u, source);
});

test("thin parser exposes daemon-backed workspace bootstrap", () => {
  const parsed = parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--name", "Alpha Project", "--add-npm-scripts"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, {
    kind: "repo-bootstrap", repoId: "alpha", personId: "owner", displayName: "Owner", name: "Alpha Project", addNpmScripts: true
  });
  assert.equal(parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner"]).ok, false);
  const configureOnly = parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner", "--configure-only"]);
  assert.equal(configureOnly.ok, true);
  if (configureOnly.ok) assert.deepEqual(configureOnly.command.action, { kind: "repo-bootstrap", repoId: "alpha", personId: "owner", displayName: "Owner", configureOnly: true });
});

test("runtime work commands parse into closed daemon facade actions", () => {
  const run = parseThinCommand(["runtime", "run", "worker", "--prompt", "Inspect", "--cwd", "packages/cli", "--task", "task-1", "--resume", "provider-1", "--idempotency-key", "once", "--no-stream"]), file = parseThinCommand(["runtime", "run", "worker", "--prompt-file", "prompt.txt"]), list = parseThinCommand(["runtime", "status", "--task", "task-1"]), show = parseThinCommand(["runtime", "status", "runtime-1"]), wait = parseThinCommand(["runtime", "wait", "runtime-1", "--no-stream"]), cancel = parseThinCommand(["runtime", "cancel", "runtime-1"]);
  for (const parsed of [run, file, list, show, wait, cancel]) assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (run.ok) assert.deepEqual(run.command.action, { kind: "runtime-run", runtimeInstanceId: "worker", prompt: "Inspect", cwd: { scope: "repo-relative", path: "packages/cli" }, taskId: "task-1", providerSessionId: "provider-1", idempotencyKey: "once", noStream: true });
  if (file.ok) assert.deepEqual(file.command.action, { kind: "runtime-run", runtimeInstanceId: "worker", promptFile: "prompt.txt", cwd: { scope: "repo-root" }, taskId: null });
  if (list.ok) assert.deepEqual({ method: list.command.method, action: list.command.action }, { method: "repo.agentRuntime.overview", action: { kind: "runtime-status", taskId: "task-1" } });
  if (show.ok) assert.deepEqual({ method: show.command.method, action: show.command.action }, { method: "repo.agentRuntime.sessions.read", action: { kind: "runtime-status", runtimeSessionId: "runtime-1" } });
  if (wait.ok) assert.deepEqual(wait.command.action, { kind: "runtime-wait", runtimeSessionId: "runtime-1", noStream: true });
  if (cancel.ok) assert.deepEqual(cancel.command.action, { kind: "runtime-cancel", runtimeSessionId: "runtime-1" });
  assert.equal(parseThinCommand(["runtime", "run", "worker"]).ok, false); assert.equal(parseThinCommand(["runtime", "run", "worker", "--prompt", "one", "--prompt-file", "two"]).ok, false); assert.equal(parseThinCommand(["runtime", "status", "runtime-1", "--task", "task-1"]).ok, false);
});

test("runtime instance auth commands parse into repo-scoped interactive sign-in actions", () => {
  const login = parseThinCommand(["runtime", "instance", "login", "worker", "--repo", "alpha", "--idempotency-key", "sign-in-once"]), reauth = parseThinCommand(["runtime", "instance", "reauth", "worker"]), logout = parseThinCommand(["runtime", "instance", "logout", "worker"]);
  for (const parsed of [login, reauth, logout]) assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (login.ok) assert.deepEqual({ repoId: login.command.repoId, method: login.command.method, action: login.command.action }, { repoId: "alpha", method: "repo.runtimeInstance.auth.login", action: { kind: "runtime-instance-login", instanceId: "worker", idempotencyKey: "sign-in-once" } });
  if (reauth.ok) assert.deepEqual({ repoId: reauth.command.repoId, method: reauth.command.method, action: reauth.command.action }, { repoId: undefined, method: "repo.runtimeInstance.auth.reauth", action: { kind: "runtime-instance-reauth", instanceId: "worker" } });
  if (logout.ok) assert.deepEqual({ method: logout.command.method, action: logout.command.action }, { method: "repo.runtimeInstance.auth.logout", action: { kind: "runtime-instance-logout", instanceId: "worker" } });
  assert.equal(parseThinCommand(["runtime", "instance", "login"]).ok, false); assert.equal(parseThinCommand(["runtime", "instance", "login", "worker", "--prompt", "x"]).ok, false); const shown = parseThinCommand(["runtime", "instance", "show", "worker", "--repo", "alpha"]); assert.equal(shown.ok === true && shown.command.repoId, undefined);
});

test("migration import parser accepts repeated explicit conflict resolutions", () => {
  const parsed = parseThinCommand(["migrate", "import", "--source", "../legacy", "--resolve", "harness/people.yaml=source", "--resolve", "harness/AGENTS.md=destination", "--dry-run", "--json"]);
  assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "migrate-import", sourceRoot: "../legacy", resolutions: ["harness/people.yaml=source", "harness/AGENTS.md=destination"], dryRun: true });
  assert.equal(parseThinCommand(["migrate", "import"]).ok, false);
  assert.equal(parseThinCommand(["migrate", "import", "--source", "a", "--resolve", "harness/people.yaml=automatic"]).ok, false);
  assert.equal(parseThinCommand(["migrate", "import", "--source", "a", "--force"]).ok, false);
});

test("migrate ledger is one closed no-option command", () => {
  const parsed = parseThinCommand(["migrate", "ledger"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "ledger-migrate" });
  assert.equal(parseThinCommand(["migrate", "ledger", "--dry-run"]).ok, false);
});

test("thin parser rejects retired caller-supplied gate receipts", () => {
  const parsed = parseThinCommand(["task", "complete", "task-1", "--execution-id", "exec-1", "--gate-receipt", "missing-separator"]);
  assert.deepEqual(parsed, { ok: false, code: "unknown_field", nextAction: "Unknown option --gate-receipt.", json: false });
});

test("lifecycle CLI maps submit, Review, consent, reconcile, and completion facade through closed typed inputs", () => {
  const submit = parseThinCommand(["task", "submit", "task-1", "--execution-id", "execution-1", "--from-file", "submission.json"]), review = parseThinCommand(["task", "review-execution", "task-1", "--execution-id", "execution-1", "--review-id", "review-1", "--from-file", "review.json"]), consent = parseThinCommand(["task", "review-consent", "task-1", "--execution-id", "execution-1", "--review-id", "review-1", "--consent-id", "consent-1", "--from-file", "consent.json"]), reconcile = parseThinCommand(["task", "code-doc", "reconcile", "task-1", "--execution-id", "execution-1", "--commit-sha", "a".repeat(40), "--iteration", "0", "--path", "packages/kernel/src/domain/task.ts"]), complete = parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--ci", "passed", "--commit-sha", "a".repeat(40), "--iteration", "0", "--path", "packages/kernel/src/domain/task.ts"]);
  for (const parsed of [submit, review, consent, reconcile, complete]) assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (submit.ok) assert.deepEqual(submit.command.action, { kind: "task-submit", verb: "submit", commandType: "SubmitExecution", taskId: "task-1", executionId: "execution-1", fromFile: "submission.json" });
  if (review.ok) assert.deepEqual(review.command.action, { kind: "task-review-execution", taskId: "task-1", executionId: "execution-1", reviewId: "review-1", commandType: "RecordReview", fromFile: "review.json" });
  if (consent.ok) assert.deepEqual(consent.command.action, { kind: "task-review-consent", taskId: "task-1", executionId: "execution-1", reviewId: "review-1", commandType: "RecordReviewConsent", consentId: "consent-1", fromFile: "consent.json" });
  const derivedConsent = parseThinCommand(["task", "review-consent", "task-1", "--execution-id", "execution-1", "--review-id", "review-1", "--consent-id", "consent-1"]);
  assert.equal(derivedConsent.ok, true, JSON.stringify(derivedConsent));
  if (derivedConsent.ok) assert.deepEqual(derivedConsent.command.action, { kind: "task-review-consent", taskId: "task-1", executionId: "execution-1", reviewId: "review-1", commandType: "RecordReviewConsent", consentId: "consent-1" });
  if (reconcile.ok) assert.deepEqual(reconcile.command.action, { kind: "task-code-doc-reconcile", taskId: "task-1", executionId: "execution-1", commitSha: "a".repeat(40), iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] });
  if (complete.ok) assert.deepEqual(complete.command.action, { kind: "task-complete", verb: "complete", commandType: "CompleteTask", taskId: "task-1", executionId: "execution-1", ci: "passed", commitSha: "a".repeat(40), iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] });
  assert.equal(parseThinCommand(["task", "submit", "task-1", "--execution-id", "execution-1"]).ok, false); assert.equal(parseThinCommand(["task", "review-execution", "task-1", "--execution-id", "execution-1", "--review-id", "review-1"]).ok, false); assert.equal(parseThinCommand(["task", "review-consent", "task-1", "--execution-id", "execution-1", "--review-id", "review-1"]).ok, false); assert.equal(parseThinCommand(["task", "code-doc", "reconcile", "task-1", "--execution-id", "execution-1", "--commit-sha", "short", "--iteration", "2", "--path", "a.ts"]).ok, false); assert.equal(parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--ci", "failed"]).ok, false); assert.equal(parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--commit-sha", "a".repeat(40)]).ok, false);
});

test("progress append preserves ordered duplicate evidence in its closed daemon action", () => { const parsed = parseThinCommand(["task", "progress", "append", "task-1", "--text", "Exact progress", "--evidence", "test:reports/result.txt:same", "--evidence", "test:reports/result.txt:same"]); assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "task-progress-append", taskId: "task-1", text: "Exact progress", evidence: [{ type: "test", path: "reports/result.txt", summary: "same" }, { type: "test", path: "reports/result.txt", summary: "same" }] }); assert.equal(parseThinCommand(["task", "progress", "append", "task-1", "--text", "x", "--evidence", "bad"]).ok, false); assert.equal(parseThinCommand(["task", "progress", "append", "task-1"]).ok, false); });
test("artifact add emits only a source-to-destination descriptor", () => { const parsed = parseThinCommand(["task", "artifact", "add", "task-1", "--source", "tmp/result.md", "--destination", "reports/result.md"]); assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "task-artifact-add", taskId: "task-1", source: "tmp/result.md", destination: "reports/result.md" }); });

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
    [["--json"], undefined]
  ] as const) assert.equal(firstCliCommand(argv as readonly string[]), expected, JSON.stringify(argv));
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
