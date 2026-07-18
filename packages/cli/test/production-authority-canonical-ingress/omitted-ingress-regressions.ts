import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDecisionDocument } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../../src/cli/types.ts";

interface RegressionReceipt {
  readonly ok: boolean;
  readonly error?: { readonly code?: string; readonly hint?: string };
}

export async function verifyOmittedIngressRegressions(input: {
  readonly authoredRoot: string;
  readonly runCommand: (action: ParsedCommand["action"], sessionId: string) => Promise<RegressionReceipt>;
}): Promise<void> {
  const receipts = new Map<string, RegressionReceipt>();
  const run = async (kind: string, action: ParsedCommand["action"]) => {
    const receipt = await input.runCommand(action, `regression-${kind}`);
    receipts.set(kind, receipt);
    assert.equal(receipt.ok, true, `${kind}:${JSON.stringify(receipt)}`);
  };
  await run("decision-amend", { kind: "decision-amend", decisionId: "dec_INGRESS", title: "Ingress decision amended", fulfillments: [], patches: [], dryRun: false });
  const decisionPath = path.join(input.authoredRoot, "decisions/decision-dec_INGRESS/decision.md");
  assert.match(readFileSync(decisionPath, "utf8"), /title: "Ingress decision amended"/u);
  const initialRelationId = parseDecisionDocument(readFileSync(decisionPath, "utf8")).decision.relations.find((relation) => relation.state === "active")!.relation_id;
  await run("decision-relation-retire", { kind: "decision-relation-retire", decisionId: "dec_INGRESS", relationId: initialRelationId, dryRun: false });
  assert.equal(parseDecisionDocument(readFileSync(decisionPath, "utf8")).decision.relations.find((relation) => relation.relation_id === initialRelationId)?.state, "retired");
  await run("decision-relate-replacement-seed", { kind: "decision-relate", decisionId: "dec_INGRESS", anchor: "C1", relationType: "relates", target: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK4", rationale: "Seed replace regression.", dryRun: false });
  const replaceRelationId = parseDecisionDocument(readFileSync(decisionPath, "utf8")).decision.relations.find((relation) => relation.state === "active")!.relation_id;
  await run("decision-relation-replace", { kind: "decision-relation-replace", decisionId: "dec_INGRESS", relationId: replaceRelationId, anchor: "C1", relationType: "relates", target: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK6", rationale: "Replace regression edge.", dryRun: false });
  assert.match(readFileSync(decisionPath, "utf8"), /Replace regression edge/u);

  await run("task-amend", { kind: "task-amend", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK0", patches: [{ field: "taskClass", value: "milestone" }] });
  assert.match(readFileSync(path.join(input.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK0/INDEX.md"), "utf8"), /taskClass: milestone/u);
  await run("task-archive", { kind: "task-archive", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK1", reason: "archive regression" });
  await run("task-reopen", { kind: "task-reopen", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK1", reason: "reopen regression" });
  assert.match(readFileSync(path.join(input.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK1/INDEX.md"), "utf8"), /packageDisposition: active/u);
  await run("task-delete", { kind: "task-delete", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK2", mode: "soft", reason: "delete regression" });
  assert.match(readFileSync(path.join(input.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK2/INDEX.md"), "utf8"), /packageDisposition: tombstoned/u);
  await run("task-relate", { kind: "task-relate", sourceTaskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK3", relationType: "depends-on", targetTaskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK4", rationale: "relate regression", dryRun: false });
  assert.match(readFileSync(path.join(input.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK3/INDEX.md"), "utf8"), /type: depends-on/u);
  await run("task-supersede", { kind: "task-supersede", oldTaskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK5", byTaskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK6", confirm: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK5", reason: "supersede regression", allowOpenFindings: false });
  assert.match(readFileSync(path.join(input.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNK5/INDEX.md"), "utf8"), /packageDisposition: archived/u);
  await run("module-step", { kind: "module-step", moduleKey: "ingress-step", stepId: "ING-1", state: "done" });
  assert.match(readFileSync(path.join(input.authoredRoot, "modules.json"), "utf8"), /ING-1/u);
  await run("module-unregister", { kind: "module-unregister", moduleKey: "ingress-unregister" });
  assert.match(readFileSync(path.join(input.authoredRoot, "modules.json"), "utf8"), /"status": "unregistered"/u);
  assert.deepEqual([...receipts.keys()].filter((kind) => kind !== "decision-relate-replacement-seed").sort(), ["decision-amend", "decision-relation-replace", "decision-relation-retire", "module-step", "module-unregister", "task-amend", "task-archive", "task-delete", "task-relate", "task-reopen", "task-supersede"]);

  const hardDelete = await input.runCommand({ kind: "task-delete", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK0", mode: "hard", reason: "hard delete regression", confirm: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNK0" }, "regression-task-delete-hard");
  assert.equal(hardDelete.ok, false, JSON.stringify(hardDelete));
  assert.equal(hardDelete.error?.code, "authority_ingress_rejected", JSON.stringify(hardDelete));
  assert.match(hardDelete.error?.hint ?? "", /production path does not offer hard delete; use task archive or task supersede/u);
}
