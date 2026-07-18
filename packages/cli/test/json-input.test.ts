// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commandInputDescriptorFor } from "../src/cli/command-input-descriptors.ts";
import { commandDescriptors } from "../src/cli/command-registry.ts";
import { parseArgs } from "../src/cli/parse-args.ts";

test("decision input schema adds canonical why_not without breaking the v1 whyNot alias", () => {
  const command = commandDescriptors.find((descriptor) => descriptor.kind === "decision-propose");
  assert.ok(command);
  const descriptor = commandInputDescriptorFor(command);

  assert.equal(descriptor.input.schemaId, "harness://schema/cli/decision-propose-input/v1");
  assert.equal(descriptor.input.properties.why_not?.type, "string");
  assert.equal(descriptor.input.properties.whyNot?.type, "string");
});

test("parseArgs passes inline JSON input to command parsers and keeps flags as overrides", () => {
  const parsed = parseArgs([
    "decision",
    "propose",
    "--json-input",
    JSON.stringify({
      title: "JSON Decision",
      question: "Use global JSON input?",
      chosen: [{ text: "Use injected input" }],
      rejected: [{ text: "Per-parser payloads", why_not: "They duplicate schema translation." }],
      riskTier: "medium",
      urgency: "high",
      modules: ["cli", "m5-circulation"],
      claims: [{ text: "JSON claim one" }, { id: "C9", text: "JSON claim two", load_bearing: false }],
      dryRun: true
    }),
    "--title",
    "Flag Title"
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "decision-propose") return;
  assert.equal(parsed.value.action.title, "Flag Title");
  assert.equal(parsed.value.action.question, "Use global JSON input?");
  assert.deepEqual(parsed.value.action.chosen, [{ id: "CH1", text: "Use injected input" }]);
  assert.deepEqual(parsed.value.action.rejected, [{ id: "RJ1", text: "Per-parser payloads", why_not: "They duplicate schema translation." }]);
  assert.deepEqual(parsed.value.action.modules, ["cli", "m5-circulation"]);
  assert.deepEqual(parsed.value.action.claims, [{ id: "C1", text: "JSON claim one" }, { id: "C9", text: "JSON claim two", load_bearing: false }]);
  assert.equal(parsed.value.action.dryRun, true);
});

test("parseArgs passes structured task create input without argv conversion", () => {
  const parsed = parseArgs([
    "task",
    "create",
    "--json-input",
    JSON.stringify({ title: "Structured task", workKind: "fix", riskTier: "high", urgency: "medium", dryRun: true })
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "new-task") return;
  assert.equal(parsed.value.action.title, "Structured task");
  assert.equal(parsed.value.action.workKind, "fix");
  assert.equal(parsed.value.action.riskTier, "high");
  assert.equal(parsed.value.action.dryRun, true);
});

test("parseArgs passes structured runtime event input without argv conversion", () => {
  const parsed = parseArgs([
    "event",
    "append",
    "--json-input",
    JSON.stringify({ sessionId: "session-structured", eventKind: "cost", runtime: "codex", summary: "Structured cost event", totalTokens: 42 })
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "runtime-event-append") return;
  assert.equal(parsed.value.action.sessionId, "session-structured");
  assert.equal(parsed.value.action.eventKind, "cost");
  assert.equal(parsed.value.action.totalTokens, 42);
});

test("parseArgs reads task and runtime structured input from actual files", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "ha-parse-from-file-"));
  try {
    const taskPath = path.join(tempDir, "task.json");
    const eventPath = path.join(tempDir, "event.json");
    writeFileSync(taskPath, JSON.stringify({ title: "Task from file", workKind: "fix", dryRun: true }), "utf8");
    writeFileSync(eventPath, JSON.stringify({ sessionId: "session-from-file", eventKind: "cost", totalTokens: 7 }), "utf8");

    const task = parseArgs(["task", "create", "--from-file", taskPath]);
    const event = parseArgs(["event", "append", "--from-file", eventPath]);

    assert.equal(task.ok, true);
    assert.equal(event.ok, true);
    if (!task.ok || !event.ok || task.value.action.kind !== "new-task" || event.value.action.kind !== "runtime-event-append") return;
    assert.equal(task.value.action.title, "Task from file");
    assert.equal(event.value.action.sessionId, "session-from-file");
    assert.equal(event.value.action.totalTokens, 7);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseArgs gives fact flags and structured input the same validated action", () => {
  const fromFlags = parseArgs([
    "fact", "record", "--task", "task_01SAME", "--id", "F-ABCDEF12", "--statement", "Equivalent fact input",
    "--source", "json-input.test.ts", "--confidence", "high", "--memory-class", "procedural", "--memory-tag", "tool_memory", "--dry-run"
  ]);
  const fromJson = parseArgs([
    "fact", "record", "--json-input", JSON.stringify({
      taskId: "task_01SAME",
      factId: "F-ABCDEF12",
      statement: "Equivalent fact input",
      source: "json-input.test.ts",
      confidence: "high",
      memoryClass: "procedural",
      memoryTags: ["tool_memory"],
      dryRun: true
    })
  ]);

  assert.equal(fromFlags.ok, true);
  assert.equal(fromJson.ok, true);
  if (!fromFlags.ok || !fromJson.ok) return;
  assert.deepEqual(fromJson.value.action, fromFlags.value.action);
});

test("parseArgs applies descriptor set and append semantics to mixed decision input", () => {
  const parsed = parseArgs([
    "decision", "propose", "--json-input", JSON.stringify({
      title: "JSON title",
      question: "How should mixed input merge?",
      chosen: [{ text: "JSON chosen" }],
      rejected: [{ text: "JSON rejected", why_not: "JSON reason" }],
      modules: ["json-module"],
      productLines: ["json-product"],
      claim: "JSON scalar claim",
      claims: [{ text: "JSON appended claim" }],
      evidenceRelations: [{ anchor: "C1", type: "relates", target: "task/task_1", rationale: "JSON relation" }]
    }),
    "--chosen", "Flag chosen", "--rejected", "Flag rejected", "--why-not", "Flag reason",
    "--module", "flag-module", "--product-line", "flag-product", "--claim", "Flag claim",
    "--evidence-relation", "C1:relates:task/task_2:Flag relation"
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.action.kind !== "decision-propose") return;
  assert.deepEqual(parsed.value.action.chosen, [{ id: "CH1", text: "Flag chosen" }]);
  assert.deepEqual(parsed.value.action.rejected, [{ id: "RJ1", text: "Flag rejected", why_not: "Flag reason" }]);
  assert.deepEqual(parsed.value.action.modules, ["json-module", "flag-module"]);
  assert.deepEqual(parsed.value.action.productLines, ["json-product", "flag-product"]);
  assert.deepEqual(parsed.value.action.claims, [{ id: "C1", text: "JSON appended claim" }, { id: "C2", text: "Flag claim" }]);
  assert.deepEqual(parsed.value.action.evidenceRelations, [
    { anchor: "C1", type: "relates", target: "task/task_1", rationale: "JSON relation" },
    { anchor: "C1", type: "relates", target: "task/task_2", rationale: "Flag relation" }
  ]);
});

test("parseArgs rejects structured identity fields with the wrong JSON type", () => {
  const parsed = parseArgs([
    "fact", "record", "--json-input", JSON.stringify({
      taskId: { nested: "not-an-id" },
      statement: "Invalid identity type",
      source: "json-input.test.ts"
    })
  ]);

  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? undefined : parsed.error.code, "invalid_json_input");
});
