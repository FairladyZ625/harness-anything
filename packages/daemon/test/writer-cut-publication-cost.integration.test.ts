// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { G1_METRICS, G1_OPERATIONS, measureWriteCostScaling } from "./fixtures/g1-write-cost-scaling.ts";

test("publishing completed writer cuts retains every existing 200-event operation budget", async (t) => {
  const measured = await measureWriteCostScaling(200),
    budgets = JSON.parse(readFileSync(new URL("../../../tools/gates/cost-budget.json", import.meta.url), "utf8"))
      .writeCostScaling.budgets;
  const exceeded: string[] = [];
  for (const operation of G1_OPERATIONS)
    for (const metric of G1_METRICS)
      if (measured.counts[operation][metric] > budgets[operation][metric])
        exceeded.push(`${operation}.${metric}: ${measured.counts[operation][metric]} > ${budgets[operation][metric]}`);
  t.diagnostic(JSON.stringify(measured.counts));
  assert.deepEqual(exceeded, []);
});
