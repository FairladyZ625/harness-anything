// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";

test("thin command directory renders every supported user command", () => {
  const help = renderThinHelp();
  assert.equal(thinCliCommands.length, 40);
  for (const command of thinCliCommands) assert.match(help, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(help, /daemon serve|fact list|fact invalidate|record fact|decision list|decision transition|decision verify|decision repin|decision amend|decision relation replace/u);
  assert.match(help, /ha fact record.*ha fact search.*ha fact show.*ha decision propose.*ha decision accept.*ha decision reckon.*ha decision search.*ha decision show/su);
});

test("thin parser derives closed preset and task-create payloads from descriptors", () => {
  assert.equal(parseThinCommand(["doc", "sync"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "Bound", "--completion-gate", "G32"]).ok, false);
  const create = parseThinCommand(["task", "create", "--title", "Bound", "--preset", "create-milestone", "--task-class", "milestone", "--dry-run"]), inspect = parseThinCommand(["preset", "inspect", "standard-task", "--locale", "en-US"]);
  assert.equal(create.ok, true); assert.equal(inspect.ok, true); if (create.ok) { assert.equal(create.command.method, "repo.task.create"); assert.deepEqual(create.command.action, { kind: "task-create", title: "Bound", presetId: "create-milestone", taskClass: "milestone", dryRun: true }); } if (inspect.ok) { assert.equal(inspect.command.method, "repo.preset.inspect"); assert.deepEqual(inspect.command.action, { kind: "preset-inspect", presetId: "standard-task", locale: "en-US" }); }
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
  const propose = parseThinCommand(["decision", "propose", "--title", "Canonical", "--question", "Should events own this Decision?", "--chosen", '{"id":"CH1","text":"Use events"}', "--rejected", '{"id":"RJ1","text":"Use files","whyNot":"Not canonical"}', "--module", "kernel"]),
    accept = parseThinCommand(["decision", "accept", "dec_1", "--rationale", "Independent approval"]),
    claim = parseThinCommand(["decision", "claim", "add", "dec_1", "--id", "C1", "--text", "Coverage is replayable"]),
    fulfill = parseThinCommand(["decision", "claim", "fulfill", "dec_1", "--id", "C1", "--mode", "evidenced"]),
    relate = parseThinCommand(["decision", "relate", "dec_1", "--anchor", "C1", "--type", "evidenced-by", "--target", "fact/task-1/F-ABCDEFGH", "--rationale", "Observed"]),
    retireRelation = parseThinCommand(["decision", "relation", "retire", "dec_1", "--relation", "rel_0123456789abcdef", "--reason", "Stale"]),
    reckon = parseThinCommand(["decision", "reckon", "dec_1", "--task", "task-1"]), search = parseThinCommand(["decision", "search", "Canonical", "--state", "accepted"]), show = parseThinCommand(["decision", "show", "dec_1", "--include-body"]);
  assert.equal([propose, accept, claim, fulfill, relate, retireRelation, reckon, search, show].every((result) => result.ok), true);
  if (propose.ok) assert.deepEqual(propose.command.action, { kind: "decision-propose", title: "Canonical", question: "Should events own this Decision?", riskTier: "medium", urgency: "medium", vertical: "default", preset: "default", decisionClass: "ordinary", appliesTo: { modules: ["kernel"], productLines: [] }, chosen: [{ id: "CH1", text: "Use events" }], rejected: [{ id: "RJ1", text: "Use files", whyNot: "Not canonical" }] });
  if (show.ok) assert.deepEqual(show.command.action, { kind: "decision-show", decisionId: "dec_1", includeBody: true });
  const failures = [
    parseThinCommand(["decision", "accept", "dec_1", "--rationale", "a", "--rationale", "b"]),
    parseThinCommand(["decision", "accept", "dec_1", "--rationale", "x".repeat(200)]),
    parseThinCommand(["decision", "accept"]),
    parseThinCommand(["decision", "show", "dec_1", "--body"]),
    parseThinCommand(["decision", "list"])
  ];
  assert.deepEqual(failures.map((result) => result.ok ? "ok" : result.code), ["duplicate_field", "invalid_field", "missing_field", "unknown_field", "unsupported_command"]);
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
  const parsed = parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner", "--display-name", "Owner"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, {
    kind: "repo-bootstrap", repoId: "alpha", personId: "owner", displayName: "Owner"
  });
  assert.equal(parseThinCommand(["init", "--repo-id", "alpha", "--person-id", "owner"]).ok, false);
});

test("thin parser rejects malformed completion receipts instead of throwing", () => {
  const parsed = parseThinCommand(["task", "complete", "task-1", "--execution-id", "exec-1", "--gate-receipt", "missing-separator"]);
  assert.deepEqual(parsed, { ok: false, code: "invalid_field", nextAction: "Use --gate-receipt <gate-id>:<receipt-ref>.", json: false });
});

test("progress append preserves ordered duplicate evidence in its closed daemon action", () => { const parsed = parseThinCommand(["task", "progress", "append", "task-1", "--text", "Exact progress", "--evidence", "test:reports/result.txt:same", "--evidence", "test:reports/result.txt:same"]); assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "task-progress-append", taskId: "task-1", text: "Exact progress", evidence: [{ type: "test", path: "reports/result.txt", summary: "same" }, { type: "test", path: "reports/result.txt", summary: "same" }] }); assert.equal(parseThinCommand(["task", "progress", "append", "task-1", "--text", "x", "--evidence", "bad"]).ok, false); assert.equal(parseThinCommand(["task", "progress", "append", "task-1"]).ok, false); });
