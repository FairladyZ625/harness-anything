// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";

test("thin command directory renders every supported user command", () => {
  const help = renderThinHelp();
  assert.equal(thinCliCommands.length, 54);
  for (const command of thinCliCommands) assert.match(help, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(help, /daemon serve|fact list|fact invalidate|record fact|decision search|decision transition|decision verify|decision repin|decision amend|decision relation replace/u);
  assert.match(help, /ha task artifact add.*ha fact record.*ha fact search.*ha fact show.*ha decision propose.*ha decision accept.*ha decision reckon.*ha decision list.*ha decision show/su);
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
    reckon = parseThinCommand(["decision", "reckon", "dec_1", "--task", "task-1"]), list = parseThinCommand(["decision", "list", "--search", "Canonical", "--state", "active", "--legacy-id", "E12", "--legacy-range", "E1-E20", "--module", "kernel", "--product-line", "platform"]), show = parseThinCommand(["decision", "show", "E12", "--include-body"]);
  assert.equal([propose, accept, claim, fulfill, relate, retireRelation, reckon, list, show].every((result) => result.ok), true);
  if (propose.ok) assert.deepEqual(propose.command.action, { kind: "decision-propose", jsonInput: packet, body: "# Canonical\n\nInitial prose.\n" });
  if (accept.ok) assert.deepEqual(accept.command.action, { kind: "decision-accept", decisionId: "dec_1", rationale: "Independent approval", judgmentOnlyRationale: "CEO judgment without evidence" });
  if (list.ok) assert.deepEqual(list.command.action, { kind: "decision-list", search: "Canonical", state: "active", legacyId: "E12", legacyRange: { start: 1, end: 20 }, module: "kernel", productLine: "platform" });
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
});

test("migration import parser exposes only source and dry-run", () => {
  const parsed = parseThinCommand(["migrate", "import", "--source", "../legacy", "--dry-run", "--json"]);
  assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "migrate-import", sourceRoot: "../legacy", dryRun: true });
  assert.equal(parseThinCommand(["migrate", "import"]).ok, false);
  assert.equal(parseThinCommand(["migrate", "import", "--source", "a", "--force"]).ok, false);
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
  if (reconcile.ok) assert.deepEqual(reconcile.command.action, { kind: "task-code-doc-reconcile", taskId: "task-1", executionId: "execution-1", commitSha: "a".repeat(40), iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] });
  if (complete.ok) assert.deepEqual(complete.command.action, { kind: "task-complete", verb: "complete", commandType: "CompleteTask", taskId: "task-1", executionId: "execution-1", ci: "passed", commitSha: "a".repeat(40), iteration: 0, paths: ["packages/kernel/src/domain/task.ts"] });
  assert.equal(parseThinCommand(["task", "submit", "task-1", "--execution-id", "execution-1"]).ok, false); assert.equal(parseThinCommand(["task", "review-execution", "task-1", "--execution-id", "execution-1", "--review-id", "review-1"]).ok, false); assert.equal(parseThinCommand(["task", "review-consent", "task-1", "--execution-id", "execution-1", "--review-id", "review-1", "--consent-id", "consent-1"]).ok, false); assert.equal(parseThinCommand(["task", "code-doc", "reconcile", "task-1", "--execution-id", "execution-1", "--commit-sha", "short", "--iteration", "2", "--path", "a.ts"]).ok, false); assert.equal(parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--ci", "failed"]).ok, false); assert.equal(parseThinCommand(["task", "complete", "task-1", "--execution-id", "execution-1", "--commit-sha", "a".repeat(40)]).ok, false);
});

test("progress append preserves ordered duplicate evidence in its closed daemon action", () => { const parsed = parseThinCommand(["task", "progress", "append", "task-1", "--text", "Exact progress", "--evidence", "test:reports/result.txt:same", "--evidence", "test:reports/result.txt:same"]); assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "task-progress-append", taskId: "task-1", text: "Exact progress", evidence: [{ type: "test", path: "reports/result.txt", summary: "same" }, { type: "test", path: "reports/result.txt", summary: "same" }] }); assert.equal(parseThinCommand(["task", "progress", "append", "task-1", "--text", "x", "--evidence", "bad"]).ok, false); assert.equal(parseThinCommand(["task", "progress", "append", "task-1"]).ok, false); });
test("artifact add emits only a source-to-destination descriptor", () => { const parsed = parseThinCommand(["task", "artifact", "add", "task-1", "--source", "tmp/result.md", "--destination", "reports/result.md"]); assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "task-artifact-add", taskId: "task-1", source: "tmp/result.md", destination: "reports/result.md" }); });
