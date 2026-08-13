// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { thinCliCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseThinCommand, renderThinHelp } from "../src/cli/thin-command.ts";

test("thin command directory renders every supported user command", () => {
  const help = renderThinHelp();
  assert.equal(thinCliCommands.length, 25);
  for (const command of thinCliCommands) assert.match(help, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(help, /daemon serve|fact list|fact invalidate|record fact/u);
  assert.match(help, /ha fact record.*ha fact search.*ha fact show/su);
});

test("thin parser derives closed preset and task-create payloads from descriptors", () => {
  assert.equal(parseThinCommand(["doc", "sync"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--title", "Bound", "--completion-gate", "G32"]).ok, false);
  const create = parseThinCommand(["task", "create", "--title", "Bound", "--preset", "create-milestone", "--task-class", "milestone"]), inspect = parseThinCommand(["preset", "inspect", "standard-task", "--locale", "en-US"]);
  assert.equal(create.ok, true); assert.equal(inspect.ok, true); if (create.ok) { assert.equal(create.command.method, "repo.task.create"); assert.deepEqual(create.command.action, { kind: "task-create", title: "Bound", presetId: "create-milestone", taskClass: "milestone" }); } if (inspect.ok) { assert.equal(inspect.command.method, "repo.preset.inspect"); assert.deepEqual(inspect.command.action, { kind: "preset-inspect", presetId: "standard-task", locale: "en-US" }); }
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

test("thin parser converts the sole preset script target into closed typed start params", () => {
  const parsed = parseThinCommand(["script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--task-id", "task-1", "--inputs", '{"title":"Canary"}']);
  assert.equal(parsed.ok, true); if (parsed.ok) assert.deepEqual(parsed.command, { rootDir: parsed.command.rootDir, json: false, method: "repo.preset.run.start", action: { kind: "preset-run-start", presetId: "user-canary", entrypoint: "check", idempotencyKey: "once", taskId: "task-1", inputs: { title: "Canary" } } });
  assert.equal(parseThinCommand(["script", "run", "user-canary/check", "--idempotency-key", "once"]).ok, false);
  assert.equal(parseThinCommand(["script", "run", "preset:user-canary/check", "--idempotency-key", "once", "--inputs", "not-json"]).ok, false);
});

test("thin doc commands derive descriptor-only actions from the protocol directory", () => {
  const status = parseThinCommand(["doc", "status", "--path", "tasks/task-1/INDEX.md"]),
    show = parseThinCommand(["doc", "show", "--path", "tasks/task-1/INDEX.md"]),
    submit = parseThinCommand(["doc", "sync", "--submit", "--execution-id", "exec-1", "--base-ledger-sha", "a".repeat(40),
      "--path", "tasks/task-1/INDEX.md", "--base-blob-sha256", "b".repeat(64)]);
  assert.equal(status.ok, true); assert.equal(show.ok, true); assert.equal(submit.ok, true);
  if (status.ok) assert.deepEqual(status.command.action, { kind: "doc-status", paths: ["tasks/task-1/INDEX.md"] });
  if (show.ok) assert.deepEqual(show.command.action, { kind: "doc-show", path: "tasks/task-1/INDEX.md" });
  if (submit.ok) {
    assert.deepEqual(submit.command.action, { kind: "doc-submit", executionId: "exec-1", baseLedgerSha: "a".repeat(40),
      selections: [{ path: "tasks/task-1/INDEX.md", baseBlobSha256: "b".repeat(64) }] });
    assert.deepEqual(Object.keys(submit.command.action).sort(), ["baseLedgerSha", "executionId", "kind", "selections"]);
  }
  assert.equal(parseThinCommand(["doc", "show", "--path", "INDEX.md", "--body", "inline"]).ok, false);
});

test("doc CLI and GUI delivery surfaces do not import store, Git, or semantic compiler code", () => {
  const sources = ["../src/cli/doc-sync-command.ts", "../src/cli/thin-command.ts", "../../gui/src/api/api-contract-registry.ts", "../../gui/src/api/service-bridge.ts", "../../gui/src/main/local-composition-root.ts"];
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
