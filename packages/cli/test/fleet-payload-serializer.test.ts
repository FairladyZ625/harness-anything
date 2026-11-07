// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
});
