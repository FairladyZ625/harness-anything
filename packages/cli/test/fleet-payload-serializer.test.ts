// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { serializeFleetAction } from "../src/daemon/fleet-payload-serializer.ts";

const command = (rootDir: string, action: Record<string, unknown>) =>
  ({
    rootDir,
    method: "repo.task.run",
    action,
  }) as never;

test("the declaration serializer sends file contents and rejects undeclared JSON fields", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-payload-serializer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "proposal.json"),
    JSON.stringify({
      title: "Edge proposal",
      question: "Which writer?",
      riskTier: "low",
      urgency: "medium",
      decisionClass: "ordinary",
      chosen: [],
      rejected: [],
      claims: [],
      unexpected: true,
    }),
  );
  assert.throws(
    () => serializeFleetAction(command(root, { kind: "decision-propose", fromFile: "proposal.json" })),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
  );
  writeFileSync(
    path.join(root, "proposal.json"),
    JSON.stringify({
      title: "Edge proposal",
      question: 42,
      riskTier: "low",
      urgency: "medium",
      decisionClass: "ordinary",
      chosen: [],
      rejected: [],
      claims: [],
    }),
  );
  assert.throws(
    () => serializeFleetAction(command(root, { kind: "decision-propose", fromFile: "proposal.json" })),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
  );
  writeFileSync(
    path.join(root, "proposal.json"),
    JSON.stringify({
      title: "Edge proposal",
      question: "Which writer?",
      riskTier: "low",
      urgency: "medium",
      decisionClass: "ordinary",
      chosen: [],
      rejected: [],
      claims: [],
    }),
  );
  writeFileSync(path.join(root, "body.md"), "# Edge proposal\n");
  const action = serializeFleetAction(
    command(root, { kind: "decision-propose", fromFile: "proposal.json", bodyFile: "body.md" }),
  );
  assert.equal(action.body, "# Edge proposal\n");
  assert.equal(Object.hasOwn(action, "fromFile"), false);
  assert.equal(Object.hasOwn(action, "bodyFile"), false);
  assert.throws(
    () =>
      serializeFleetAction(
        command(root, { kind: "decision-propose", fromFile: "proposal.json", body: "inline", bodyFile: "body.md" }),
      ),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
  );
});

test("line-list declarations become content arrays and missing packet fields fail closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-payload-lines-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "ids.txt"), "# local note\nF-0001\n\nF-0002\n");
  const action = serializeFleetAction(command(root, { kind: "fact-archive", idsFile: "ids.txt", reason: "Finished." }));
  assert.deepEqual(action.factIds, ["F-0001", "F-0002"]);
  writeFileSync(path.join(root, "proposal.json"), JSON.stringify({ question: "Missing title" }));
  assert.throws(
    () => serializeFleetAction(command(root, { kind: "decision-propose", fromFile: "proposal.json" })),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
  );
});

test("ordinary required declarations fail before a Fleet action is emitted", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-payload-required-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => serializeFleetAction(command(root, { kind: "task-progress-append", taskId: "task-one" })),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
  );
  assert.throws(
    () => serializeFleetAction(command(root, { kind: "task-start", taskId: "task-one", evil: "x" })),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
  );
});

test(
  "file codecs reject a repository symlink that resolves outside the workspace",
  { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "fleet-payload-symlink-"));
    const outside = mkdtempSync(path.join(tmpdir(), "fleet-payload-outside-"));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    writeFileSync(
      path.join(outside, "proposal.json"),
      JSON.stringify({
        title: "Edge proposal",
        question: "Which writer?",
        riskTier: "low",
        urgency: "medium",
        decisionClass: "ordinary",
        chosen: [],
        rejected: [],
        claims: [],
      }),
    );
    symlinkSync(path.join(outside, "proposal.json"), path.join(root, "proposal.json"));
    assert.throws(
      () => serializeFleetAction(command(root, { kind: "decision-propose", fromFile: "proposal.json" })),
      (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
    );
  },
);

test("decision JSON arrays obey the same shape and row bound as center admission", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fleet-payload-wire-rows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = {
    title: "Edge proposal",
    question: "Which writer?",
    riskTier: "low",
    urgency: "medium",
    decisionClass: "ordinary",
    rejected: [],
    claims: [],
  };

  for (const [label, chosen] of [
    ["nested-array", [[]]],
    ["oversized-list", Array.from({ length: 501 }, () => ({ id: "CH1", text: "Probe choice" }))],
  ] as const) {
    const parsed = parseThinCommand(["decision", "propose", "--json-input", JSON.stringify({ ...base, chosen })], root);
    assert.equal(parsed.ok, true, `${label} remains valid CLI JSON syntax`);
    if (!parsed.ok) continue;
    assert.throws(
      () => serializeFleetAction(parsed.command),
      (error: unknown) => (error as { readonly code?: string }).code === "invalid_field",
      `${label} must be rejected before a Fleet action is emitted`,
    );
  }
});
