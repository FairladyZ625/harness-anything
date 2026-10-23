import assert from "node:assert/strict";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../../../packages/daemon/src/dispatch-stream.ts";
import { guiE2eDispatchId, guiE2eRuntimeSessionId } from "./sessions-grouping.mjs";
import { nav } from "./helpers.mjs";

const dispatchId = guiE2eDispatchId("lanes-live"),
  runtimeSessionId = guiE2eRuntimeSessionId("lanes-live"),
  taskId = "task-e2e-lanes",
  activityObservedAt = () => new Date(Date.now() - 15 * 60_000).toISOString();

export default {
  id: "live-floor-activity",
  feature: "live-floor",
  lane: "isolated",
  description: "A live-floor dispatch with stale provider activity shows its idle minutes in the red status tag.",
  async run({ page, fixture, shot }) {
    const observedAt = activityObservedAt();
    openDispatchStream(fixture.rootDir, {
      dispatchId,
      taskId,
      executionId: "exe-lanes-live",
      runtimeSessionId,
      instanceId: "instance-e2e-lanes",
      kindId: "codex",
      startedAt: observedAt,
    });
    appendRuntimeWorkerRecord(fixture.rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: observedAt,
      event: { type: "item.updated", item: { type: "command_execution", status: "in_progress" } },
    });

    await nav(page, /^(?:现场|Live floor)$/u, "live-floor-page");
    const row = page.getByTestId("live-floor-session-row").filter({ hasText: "并行 Agent 泳道时间线" });
    await row.waitFor();
    const tag = row.locator('[data-status-tone="bad"]');
    await tag.waitFor();
    const label = (await tag.innerText()).trim(),
      minutes = Number(/(?:静默|Silent for)\s*(\d+)/u.exec(label)?.[1]);
    assert.ok(minutes >= 10, `the activity age must cross the silence threshold: ${label}`);
    await tag.scrollIntoViewIfNeeded();
    await shot("live-floor-silent-activity");
  },
};
