// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { materializePacketStdin, rawTemplateBody } from "../src/index.ts";
import { packetJson } from "../../daemon/src/repo-cell-packets.ts";

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
    triples = parseThinCommand(["relation", "triples", "--source-kind", "decision", "--target-kind", "fact"]);
  assert.equal(relate.ok, true);
  assert.equal(unrelate.ok, true);
  assert.equal(reconfirm.ok, true);
  assert.equal(suspect.ok, true);
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
  if (triples.ok)
    assert.deepEqual(triples.command.action, {
      kind: "relation-triples",
      sourceKind: "decision",
      targetKind: "fact",
    });
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
