import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// `npm run test:e2e` / `test:gui:e2e` 的入口(gate test-gui-e2e 的受保护面 packages/gui/e2e/**):
// 场景本身住在 tools/gui-e2e/scenarios,这里只把 isolated lane 整体跑一遍并把结果当断言。
// renderer/preload 已由 package script 在此之前构建,所以 noBuild。
test("GUI e2e catalog (isolated lane) is healthy", { timeout: 300_000 }, async () => {
  const { runGuiE2E } = await import(pathToFileURL(resolve(import.meta.dirname, "../../../tools/gui-e2e.mjs")).href);
  const { result } = await runGuiE2E({ lane: "isolated", scenarios: [], noBuild: true });
  const failed = result.scenarios.filter((scenario) => scenario.outcome !== "healthy");
  assert.deepEqual(
    failed.map((scenario) => `${scenario.id}: ${scenario.failedStep ?? ""} ${scenario.message ?? ""}`),
    [],
    `unhealthy scenarios (runId ${result.runId})`,
  );
  assert.equal(result.outcome, "healthy");
});
